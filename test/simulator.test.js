import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildColdStartPlan, simulatePlan } from '../src/index.js';

function scenarioInput(overrides = {}) {
  return {
    keys: [
      { id: 'k1', heat: 100, ttlSeconds: 30, sizeBytes: 1_000_000 },
      { id: 'k2', heat: 40, ttlSeconds: 90, sizeBytes: 2_000_000 }
    ],
    regions: [
      { id: 'r-a', capacityBytes: 10_000_000, bandwidthMbps: 8 },
      { id: 'r-b', capacityBytes: 10_000_000, bandwidthMbps: 8 }
    ],
    origin: { rpsLimit: 100, bandwidthMbps: 1000, maxBypassRps: 6 },
    config: {
      maxRetries: 3,
      maxConcurrencyPerKey: 1,
      retryBaseDelaySeconds: 2,
      deadlineSeconds: 300,
      hitRateTarget: 0.9
    },
    ...overrides
  };
}

test('失败重试：失败后按指数退避重试，成功后键正常装载', () => {
  const input = scenarioInput({
    simulation: { failures: [{ taskId: 'r-a__k1', times: 2 }] }
  });
  const plan = buildColdStartPlan(input);
  const result = simulatePlan(input, plan, input.simulation?.events ?? []);

  assert.equal(result.summary.failureCount, 2);
  assert.equal(result.summary.retryCount, 2);
  assert.equal(result.summary.exhaustedCount, 0);
  assert.ok(result.loaded['r-a'].includes('k1'));

  const retries = result.timeline.filter((event) => event.type === 'retry-scheduled');
  assert.equal(retries.length, 2);
  // 退避等待至少 1 秒，且两次退避不缩短（指数退避 + 确定性抖动）。
  const delays = retries.map((event) => event.retryAtSecond - event.atSecond);
  assert.ok(delays[0] >= 1);
  assert.ok(retries[1].retryAtSecond >= retries[0].retryAtSecond);
});

test('失败重试：超过最大重试次数后产生带截止时间的回源降级', () => {
  const input = scenarioInput({
    config: {
      maxRetries: 1,
      maxConcurrencyPerKey: 1,
      retryBaseDelaySeconds: 1,
      deadlineSeconds: 300,
      hitRateTarget: 0.9
    },
    simulation: { failures: [{ taskId: 'r-a__k1', times: 5 }] }
  });
  const plan = buildColdStartPlan(input);
  const result = simulatePlan(input, plan);

  assert.ok(result.summary.exhaustedCount >= 1);
  const entry = result.degradation.entries.find((item) => item.type === 'retry-exhausted');
  assert.equal(entry.keyId, 'k1');
  assert.equal(entry.fallback, 'bypass-to-origin');
  assert.ok(Number.isFinite(entry.allowanceRps));
  assert.ok(!result.loaded['r-a'].includes('k1'));
});

test('区域故障：在途任务转移到健康区域，恢复后重新预热', () => {
  const input = scenarioInput();
  const plan = buildColdStartPlan(input);
  const events = [
    { type: 'region-down', atSecond: 0, regionId: 'r-b' },
    { type: 'region-up', atSecond: 10, regionId: 'r-b' }
  ];
  const result = simulatePlan(input, plan, events);

  assert.ok(result.summary.failoverCount >= 2);
  const failovers = result.timeline.filter((event) => event.type === 'failover');
  assert.ok(failovers.every((event) => event.fromRegionId === 'r-b'));
  assert.ok(failovers.every((event) => event.toRegionId === 'r-a'));

  const down = result.timeline.find((event) => event.type === 'region-down');
  const up = result.timeline.find((event) => event.type === 'region-up');
  assert.equal(down.regionId, 'r-b');
  assert.equal(up.regionId, 'r-b');

  // r-b 恢复后其键重新装载，r-a 通过容灾持有全部键。
  assert.deepEqual(result.loaded['r-a'].sort(), ['k1', 'k2']);
  assert.deepEqual(result.loaded['r-b'].sort(), ['k1', 'k2']);
});

test('区域故障且无容量承接：等待恢复，持续不可用则降级', () => {
  const input = scenarioInput({
    regions: [
      { id: 'r-a', capacityBytes: 1_500_000, bandwidthMbps: 8 }, // 装不下 k2
      { id: 'r-b', capacityBytes: 10_000_000, bandwidthMbps: 8 }
    ],
    config: {
      maxRetries: 3,
      maxConcurrencyPerKey: 1,
      retryBaseDelaySeconds: 2,
      deadlineSeconds: 5,
      hitRateTarget: 0.9
    }
  });
  const plan = buildColdStartPlan(input);
  // r-a 与 r-b 同时故障，r-b 恢复时已超过模拟窗口保护。
  const events = [
    { type: 'region-down', atSecond: 0, regionId: 'r-a' },
    { type: 'region-down', atSecond: 0, regionId: 'r-b' },
    { type: 'region-up', atSecond: 200, regionId: 'r-a' },
    { type: 'region-up', atSecond: 200, regionId: 'r-b' }
  ];
  const result = simulatePlan(input, plan, events);
  const unavailable = result.degradation.entries.filter(
    (entry) => entry.type === 'region-unavailable'
  );
  assert.ok(unavailable.length > 0);
  assert.ok(unavailable.every((entry) => entry.deadlineSecond === 5));
});

test('短时热点：新键被动态准入并装载，重规划记录在 replans 中', () => {
  const input = scenarioInput();
  const plan = buildColdStartPlan(input);
  const events = [
    {
      type: 'heat-update',
      atSecond: 2,
      changes: [{ id: 'sudden-hot', heat: 99, sizeBytes: 500_000, ttlSeconds: 20 }]
    }
  ];
  const result = simulatePlan(input, plan, events);

  const admit = result.replans.find((item) => item.action === 'admit');
  assert.ok(admit.addedTasks.includes('r-a__sudden-hot'));
  assert.ok(result.loaded['r-a'].includes('sudden-hot'));
  assert.ok(result.loaded['r-b'].includes('sudden-hot'));
});

test('短时热点：新键容量不足时按回源降级并给出截止时间', () => {
  const input = scenarioInput({
    regions: [
      { id: 'r-a', capacityBytes: 3_100_000, bandwidthMbps: 8 },
      { id: 'r-b', capacityBytes: 3_100_000, bandwidthMbps: 8 }
    ]
  });
  const plan = buildColdStartPlan(input);
  const events = [
    {
      type: 'heat-update',
      atSecond: 1,
      changes: [{ id: 'huge-hot', heat: 99, sizeBytes: 5_000_000, ttlSeconds: 20 }]
    }
  ];
  const result = simulatePlan(input, plan, events);
  const entry = result.degradation.entries.find((item) => item.type === 'unplanned-hotkey');
  assert.equal(entry.keyId, 'huge-hot');
  assert.equal(entry.fallback, 'bypass-to-origin');
  assert.ok(Number.isFinite(entry.deadlineSecond));
});

test('模拟全程不突破源站 RPS 与同键并发约束', () => {
  const input = scenarioInput({
    origin: { rpsLimit: 2, maxBypassRps: 2 },
    simulation: { failures: [{ taskId: 'r-a__k1', times: 1 }] }
  });
  const plan = buildColdStartPlan(input);
  const result = simulatePlan(input, plan, [
    { type: 'region-down', atSecond: 1, regionId: 'r-b' },
    { type: 'region-up', atSecond: 6, regionId: 'r-b' }
  ]);
  assert.ok(result.summary.peakOriginRps <= 2);

  // 同键并发：同一时刻每个 key 至多一个在途区域任务。
  const scheduled = result.timeline.filter((event) => event.type === 'scheduled');
  const windowsByKey = new Map();
  for (const event of scheduled) {
    const windows = windowsByKey.get(event.keyId) ?? [];
    windows.push([event.atSecond, event.finishSecond]);
    windowsByKey.set(event.keyId, windows);
  }
  for (const [keyId, windows] of windowsByKey) {
    windows.sort((left, right) => left[0] - right[0]);
    for (let index = 1; index < windows.length; index += 1) {
      assert.ok(
        windows[index][0] >= windows[index - 1][1],
        `${keyId} 出现跨区域同时预热`
      );
    }
  }
});
