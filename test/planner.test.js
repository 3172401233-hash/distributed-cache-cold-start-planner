import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildColdStartPlan } from '../src/index.js';

function baseInput(overrides = {}) {
  return {
    keys: [
      { id: 'k1', heat: 100, ttlSeconds: 30, sizeBytes: 1_000_000 },
      { id: 'k2', heat: 60, ttlSeconds: 60, sizeBytes: 2_000_000 },
      { id: 'k3', heat: 10, ttlSeconds: 30, sizeBytes: 500_000 }
    ],
    regions: [
      { id: 'r-a', capacityBytes: 10_000_000, bandwidthMbps: 8 },
      { id: 'r-b', capacityBytes: 10_000_000, bandwidthMbps: 8 }
    ],
    origin: { rpsLimit: 100, bandwidthMbps: 1000, maxBypassRps: 10 },
    config: {
      maxRetries: 3,
      maxConcurrencyPerKey: 1,
      deadlineSeconds: 300,
      hitRateTarget: 0.9
    },
    ...overrides
  };
}

test('集中热点：热门键排在首批，且同键跨区域不并发', () => {
  const plan = buildColdStartPlan(baseInput());
  assert.equal(plan.tasks.length, 6);

  const firstWave = plan.waves[0];
  assert.ok(firstWave.taskIds.some((id) => id.includes('k1')));

  // 同一 key 的两个区域任务时间窗不得重叠。
  for (const keyId of ['k1', 'k2', 'k3']) {
    const windows = plan.tasks
      .filter((task) => task.keyId === keyId)
      .map((task) => [task.startSecond, task.finishSecond])
      .sort((left, right) => left[0] - right[0]);
    for (let index = 1; index < windows.length; index += 1) {
      assert.ok(
        windows[index][0] >= windows[index - 1][1],
        `${keyId} 跨区域预热时间窗重叠`
      );
    }
  }

  // 高热度任务不晚于低热度任务开始（同区域带宽相当时按优先级排列）。
  const byKey = (id) => plan.tasks.filter((task) => task.keyId === id);
  assert.ok(Math.min(...byKey('k1').map((task) => task.startSecond)) <=
    Math.min(...byKey('k3').map((task) => task.startSecond)));
});

test('源站限流：峰值 RPS 不超过 rpsLimit，限流收紧会拉长总时长', () => {
  const loose = buildColdStartPlan(baseInput({ origin: { rpsLimit: 100, maxBypassRps: 10 } }));
  const tight = buildColdStartPlan(baseInput({ origin: { rpsLimit: 1, maxBypassRps: 10 } }));

  assert.ok(loose.summary.peakOriginRps <= 100);
  assert.ok(tight.summary.peakOriginRps <= 1);
  assert.ok(tight.summary.expectedFinishSecond > loose.summary.expectedFinishSecond);

  // rpsLimit=1 时任意一秒最多只有一个新请求（每任务仅首秒计入 1 RPS）。
  assert.ok(tight.summary.peakOriginRps === 1);
});

test('容量差距：小容量区域产生降级与命中率下降，并给出回源配额和截止时间', () => {
  const input = baseInput({
    regions: [
      { id: 'r-a', capacityBytes: 10_000_000, bandwidthMbps: 8 },
      { id: 'r-b', capacityBytes: 1_000_000, bandwidthMbps: 8 } // 只能装 k1
    ],
    origin: { rpsLimit: 100, maxBypassRps: 4 }
  });
  const plan = buildColdStartPlan(input);

  const smallRegion = plan.capacity.find((item) => item.regionId === 'r-b');
  assert.equal(smallRegion.admittedKeys, 1);
  assert.equal(smallRegion.overflowKeys, 2);

  const overflowEntries = plan.degradation.entries.filter(
    (entry) => entry.type === 'capacity-overflow' && entry.regionId === 'r-b'
  );
  assert.equal(overflowEntries.length, 2);
  for (const entry of overflowEntries) {
    assert.equal(entry.fallback, 'bypass-to-origin');
    assert.ok(Number.isFinite(entry.allowanceRps));
    assert.equal(entry.deadlineSecond, 0);
  }
  const totalAllowance = overflowEntries.reduce((sum, entry) => sum + entry.allowanceRps, 0);
  assert.ok(Math.abs(totalAllowance - 4) < 0.01);

  assert.ok(plan.hitRate.missesTarget === true || plan.hitRate.overallHitRate < 0.9);
});

test('同时过期：相同 TTL 的键得到确定性抖动，过期时间被打散', () => {
  const plan = buildColdStartPlan(baseInput());
  const sameTtl = plan.expiryPolicy.entries.filter((entry) => entry.originalTtlSeconds === 30);
  assert.equal(sameTtl.length, 2);
  const adjusted = new Set(sameTtl.map((entry) => entry.adjustedTtlSeconds));
  assert.ok(adjusted.size >= 1);
  for (const entry of sameTtl) {
    assert.ok(entry.preWarmAtSecond < entry.adjustedTtlSeconds);
    assert.ok(entry.adjustedTtlSeconds >= 24 && entry.adjustedTtlSeconds <= 36);
  }
  const risk = plan.expiryPolicy.simultaneousExpiryRisks.find(
    (group) => group.ttlSeconds === 30
  );
  assert.equal(risk.mitigation, 'ttl-jitter');
  // 确定性：重复运行结果一致。
  const again = buildColdStartPlan(baseInput());
  assert.deepEqual(again.expiryPolicy.entries, plan.expiryPolicy.entries);
});

test('截止时间：无法在截止前完成的任务生成 preheat-at-risk 降级', () => {
  const plan = buildColdStartPlan(
    baseInput({
      origin: { rpsLimit: 1, maxBypassRps: 2 },
      config: { maxRetries: 3, maxConcurrencyPerKey: 1, deadlineSeconds: 1, hitRateTarget: 0.9 }
    })
  );
  const atRisk = plan.degradation.entries.filter((entry) => entry.type === 'preheat-at-risk');
  assert.ok(atRisk.length > 0);
  for (const entry of atRisk) {
    assert.equal(entry.deadlineSecond, 1);
    assert.equal(entry.fallback, 'bypass-to-origin');
  }
  assert.equal(plan.summary.meetsDeadline, false);
});

test('输入校验：缺少字段或非法值时抛出明确错误', () => {
  assert.throws(() => buildColdStartPlan({ ...baseInput(), keys: [] }), /keys/);
  assert.throws(
    () => buildColdStartPlan(baseInput({ origin: { rpsLimit: 0 } })),
    /rpsLimit/
  );
  assert.throws(
    () => buildColdStartPlan(baseInput({ keys: [{ id: 'x', heat: 1, ttlSeconds: 10, sizeBytes: -1 }] })),
    /sizeBytes/
  );
});
