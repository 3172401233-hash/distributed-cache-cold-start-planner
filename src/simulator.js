// 场景模拟器：在内存中“执行”冷启动计划，注入预热失败、区域故障、
// 短时热点变化等事件，验证计划的重试、容灾与重规划行为。
// 全程纯内存模拟，不连接真实缓存或源站。

import { normalizeInput } from './model.js';
import { ReservationBoard } from './scheduler.js';
import {
  allocateBypassAllowance,
  regionUnavailableEntry,
  retryExhaustedEntry,
  retryBackoffSeconds,
  unplannedHotkeyEntry
} from './policies.js';

function compareByHeat(left, right, heatById) {
  const heatDiff = heatById.get(right.keyId) - heatById.get(left.keyId);
  if (heatDiff !== 0) return heatDiff;
  if (left.keyId !== right.keyId) return left.keyId < right.keyId ? -1 : 1;
  if (left.regionId !== right.regionId) return left.regionId < right.regionId ? -1 : 1;
  return 0;
}

export function simulatePlan(rawInput, plan, scenarioEvents = []) {
  const { keys, regions, origin, config } = normalizeInput(rawInput);
  const board = new ReservationBoard({ regions, origin, config });

  const keyById = new Map(keys.map((key) => [key.id, key]));
  const heatById = new Map(keys.map((key) => [key.id, key.heat]));
  const healthy = new Set(regions.map((region) => region.id));
  const capacityById = new Map(regions.map((region) => [region.id, region.capacityBytes]));
  const bandwidthById = new Map(
    regions.map((region) => [region.id, region.bandwidthBytesPerSec])
  );

  const pending = new Map();
  const inflight = new Map();
  const attempts = new Map();
  const usedBytes = new Map(regions.map((region) => [region.id, 0]));
  const admittedKeys = new Map(regions.map((region) => [region.id, new Set()]));
  const loadedKeys = new Map(regions.map((region) => [region.id, new Set()]));

  const timeline = [];
  const degradation = [];
  const replans = [];
  let failureCount = 0;
  let retryCount = 0;
  let failoverCount = 0;
  let peakOriginRps = 0;

  // 失败注入：支持精确时间点（task-failure 事件）与次数（failures 数组）两种写法。
  const failureAt = new Set();
  const failureLeft = new Map();
  const events = [];
  for (const failure of rawInput.simulation?.failures ?? []) {
    failureLeft.set(
      failure.taskId,
      (failureLeft.get(failure.taskId) ?? 0) + (failure.times ?? 1)
    );
  }
  for (const event of scenarioEvents) {
    events.push(event);
    if (event.type === 'task-failure') {
      failureAt.add(`${event.taskId}@${event.atSecond}`);
    }
  }

  const eventBuckets = new Map();
  for (const event of events) {
    const bucket = event.atSecond;
    const group = eventBuckets.get(bucket) ?? [];
    group.push(event);
    eventBuckets.set(bucket, group);
  }
  const maxEventBucket = events.reduce((max, event) => Math.max(max, event.atSecond), 0);

  let bucketNow = 0;
  function log(type, fields = {}) {
    timeline.push({ atSecond: bucketNow, type, ...fields });
  }

  function makeTask(keyId, regionId) {
    const key = keyById.get(keyId);
    return {
      id: `${regionId}__${keyId}`,
      keyId,
      regionId,
      heat: key.heat,
      ttlSeconds: key.ttlSeconds,
      sizeBytes: key.sizeBytes,
      bandwidthBytesPerSec: bandwidthById.get(regionId),
      earliestBucket: bucketNow + 1
    };
  }

  function admit(task) {
    usedBytes.set(task.regionId, usedBytes.get(task.regionId) + task.sizeBytes);
    admittedKeys.get(task.regionId).add(task.keyId);
    pending.set(task.id, task);
  }

  // 按计划初始化各区域的预热任务与容量占用。
  for (const planned of plan.tasks) {
    attempts.set(planned.id, 0);
    const task = { ...planned, earliestBucket: 0 };
    delete task.startBucket;
    delete task.endBucket;
    delete task.startSecond;
    delete task.finishSecond;
    delete task.durationSeconds;
    admit(task);
  }

  function schedulePending() {
    const candidates = [...pending.values()]
      .filter((task) => (task.earliestBucket ?? 0) <= bucketNow && healthy.has(task.regionId))
      .sort((left, right) => compareByHeat(left, right, heatById));
    for (const task of candidates) {
      // 故障转移/恢复任务至少从下一 bucket 开始（转移与重新建立连接有延迟，
      // 且故障当秒的源站请求窗口已被中止任务占用）。
      const startBucket = Math.max(bucketNow, task.earliestBucket ?? 0, task.minStartBucket ?? 0);
      // 当前秒放不下（同键并发、源站限流或带宽占满）的任务留待后续秒，
      // 不能跳过约束直接预约。
      if (!board.canPlace(task, startBucket)) {
        continue;
      }
      board.reserve(task, startBucket);
      const attempt = (attempts.get(task.id) ?? 0) + 1;
      attempts.set(task.id, attempt);
      inflight.set(task.id, { task, finishBucket: task.endBucket });
      pending.delete(task.id);
      log('scheduled', {
        taskId: task.id,
        keyId: task.keyId,
        regionId: task.regionId,
        attempt,
        finishSecond: task.finishSecond
      });
    }
    if (board.originRps.size > 0) {
      peakOriginRps = Math.max(peakOriginRps, ...board.originRps.values());
    }
  }

  function completeTask(task) {
    board.release(task);
    inflight.delete(task.id);
    const timedFailure = failureAt.has(`${task.id}@${bucketNow}`);
    const countedFailure = (failureLeft.get(task.id) ?? 0) > 0;
    if (countedFailure) {
      failureLeft.set(task.id, failureLeft.get(task.id) - 1);
    }
    const attempt = attempts.get(task.id);
    const isFailure = timedFailure || countedFailure;

    if (!isFailure) {
      loadedKeys.get(task.regionId).add(task.keyId);
      log('loaded', { taskId: task.id, keyId: task.keyId, regionId: task.regionId, attempt });
      return;
    }

    failureCount += 1;
    log('failed', { taskId: task.id, keyId: task.keyId, regionId: task.regionId, attempt });
    if (attempt > config.maxRetries) {
      degradation.push(retryExhaustedEntry({ task, config }));
      log('retry-exhausted', { taskId: task.id, keyId: task.keyId, regionId: task.regionId });
      return;
    }
    const delay = retryBackoffSeconds(attempt, config, task.keyId);
    task.earliestBucket = bucketNow + delay;
    pending.set(task.id, task);
    retryCount += 1;
    log('retry-scheduled', {
      taskId: task.id,
      keyId: task.keyId,
      regionId: task.regionId,
      attempt,
      retryAtSecond: task.earliestBucket
    });
  }

  function failover(task, healthyAfterBucket = healthy) {
    // 计划本来要求每个区域各预热一份同键副本；故障区域的副本需要并入健康区域。
    // 若健康区域已有同键副本（在途或已装载），直接复用即可，无需再占容量。
    const reusable = [...healthy]
      .sort()
      .find(
        (regionId) =>
          healthyAfterBucket.has(regionId) &&
          (inflight.has(`${regionId}__${task.keyId}`) ||
            loadedKeys.get(regionId).has(task.keyId) ||
            pending.has(`${regionId}__${task.keyId}`))
      );
    if (reusable) {
      failoverCount += 1;
      log('failover-reuse', {
        keyId: task.keyId,
        fromRegionId: task.regionId,
        toRegionId: reusable
      });
      return;
    }
    const target = [...regions]
      .map((region) => region.id)
      .sort()
      .find(
        (regionId) =>
          healthyAfterBucket.has(regionId) &&
          !admittedKeys.get(regionId).has(task.keyId) &&
          usedBytes.get(regionId) + task.sizeBytes <= capacityById.get(regionId)
      );
    if (!target) {
      // 没有可承接的健康区域：任务留在原区域，等待恢复；最终仍未完成则降级。
      task.earliestBucket = bucketNow + 1;
      task.minStartBucket = bucketNow + 1;
      pending.set(task.id, task);
      return;
    }
    const replacement = makeTask(task.keyId, target);
    replacement.earliestBucket = bucketNow + 1;
    replacement.minStartBucket = bucketNow + 1;
    attempts.set(replacement.id, attempts.get(replacement.id) ?? 0);
    admit(replacement);
    failoverCount += 1;
    log('failover', {
      keyId: task.keyId,
      fromRegionId: task.regionId,
      toRegionId: target
    });
  }

  function applyRegionDown(regionId, healthyAfterBucket) {
    healthy.delete(regionId);
    // 释放故障区域的容量记账，供其他区域的容灾准入判断。
    usedBytes.set(regionId, 0);
    admittedKeys.get(regionId).clear();
    log('region-down', { regionId });
    const affectedTasks = [];
    for (const [, entry] of inflight) {
      if (entry.task.regionId === regionId) {
        affectedTasks.push(entry.task);
      }
    }
    for (const task of [...pending.values()]) {
      if (task.regionId === regionId) {
        affectedTasks.push(task);
      }
    }
    for (const task of affectedTasks) {
      const wasInflight = inflight.has(task.id);
      if (inflight.has(task.id)) {
        board.release(task);
        inflight.delete(task.id);
      } else {
        pending.delete(task.id);
      }
      if (wasInflight) {
        // 在途任务被故障中止：同键在健康区域的待调度副本推迟到下一秒，
        // 避免与中止任务已占用的源站请求窗口重叠。
        for (const other of pending.values()) {
          if (other.keyId === task.keyId && other.regionId !== regionId) {
            other.earliestBucket = Math.max(other.earliestBucket ?? 0, bucketNow + 1);
            other.minStartBucket = Math.max(other.minStartBucket ?? 0, bucketNow + 1);
          }
        }
      }
      failover(task, healthyAfterBucket);
    }
  }

  function applyRegionUp(regionId) {
    healthy.add(regionId);
    // 重启后缓存为空：清空装载状态并按原计划重新准入。
    loadedKeys.get(regionId).clear();
    admittedKeys.get(regionId).clear();
    usedBytes.set(regionId, 0);
    log('region-up', { regionId });
    for (const planned of plan.tasks) {
      if (planned.regionId !== regionId || pending.has(planned.id) || inflight.has(planned.id)) {
        continue;
      }
      const task = makeTask(planned.keyId, regionId);
      task.earliestBucket = bucketNow + 1;
      task.minStartBucket = bucketNow + 1;
      attempts.set(task.id, 0);
      admit(task);
    }
  }

  function evictPending(regionId, reason) {
    const evictedTaskIds = [];
    while (usedBytes.get(regionId) > capacityById.get(regionId)) {
      const victims = [...pending.values()]
        .filter((task) => task.regionId === regionId)
        .sort((left, right) => compareByHeat(left, right, heatById));
      const victim = victims[0];
      if (!victim) break;
      pending.delete(victim.id);
      usedBytes.set(regionId, usedBytes.get(regionId) - victim.sizeBytes);
      admittedKeys.get(regionId).delete(victim.keyId);
      evictedTaskIds.push(victim.id);
      degradation.push(
        unplannedHotkeyEntry({
          key: keyById.get(victim.keyId),
          regionId,
          deadlineSecond: bucketNow
        })
      );
      log('evicted', { keyId: victim.keyId, regionId, reason });
    }
    if (evictedTaskIds.length > 0) {
      replans.push({ atSecond: bucketNow, action: 'evict', evictedTaskIds, reason });
    }
  }

  function applyHeatUpdate(event) {
    const addedTasks = [];
    for (const change of event.changes) {
      const existing = keyById.get(change.id);
      if (existing) {
        const oldSize = existing.sizeBytes;
        existing.heat = change.heat ?? existing.heat;
        existing.ttlSeconds = change.ttlSeconds ?? existing.ttlSeconds;
        heatById.set(change.id, existing.heat);
        if (change.sizeBytes && change.sizeBytes !== oldSize) {
          existing.sizeBytes = change.sizeBytes;
          for (const regionId of healthy) {
            if (admittedKeys.get(regionId).has(change.id) && !loadedKeys.get(regionId).has(change.id)) {
              usedBytes.set(
                regionId,
                usedBytes.get(regionId) + (change.sizeBytes - oldSize)
              );
              evictPending(regionId, `key ${change.id} size grew`);
            }
          }
        }
        continue;
      }

      const key = {
        id: change.id,
        heat: change.heat ?? 1,
        sizeBytes: change.sizeBytes,
        ttlSeconds: change.ttlSeconds ?? 60
      };
      if (!(key.sizeBytes > 0)) {
        throw new TypeError(`heat-update 新键 ${key.id} 缺少正的 sizeBytes`);
      }
      keyById.set(key.id, key);
      heatById.set(key.id, key.heat);
      for (const regionId of [...healthy].sort()) {
        if (usedBytes.get(regionId) + key.sizeBytes <= capacityById.get(regionId)) {
          const task = makeTask(key.id, regionId);
          task.earliestBucket = bucketNow + 1;
          task.minStartBucket = bucketNow + 1;
          admit(task);
          addedTasks.push(task.id);
        } else {
          degradation.push(
            unplannedHotkeyEntry({ key, regionId, deadlineSecond: bucketNow })
          );
        }
      }
    }
    log('heat-update', { changes: event.changes.map((change) => change.id) });
    replans.push({ atSecond: bucketNow, action: 'admit', addedTasks });
  }

  const guardLimit = 100_000;
  const deadlineBucket = Math.max(maxEventBucket, config.deadlineSeconds);
  while (
    (inflight.size > 0 || pending.size > 0 || bucketNow <= maxEventBucket) &&
    bucketNow <= guardLimit
  ) {
    // 截止时间到达：仍在排队（通常因区域故障无法调度）的任务直接降级，
    // 已在途的任务允许跑完，避免无界等待。
    if (bucketNow >= deadlineBucket && pending.size > 0 && inflight.size === 0) {
      break;
    }
    const bucketEvents = eventBuckets.get(bucketNow) ?? [];
    // 同一秒的事件按 故障 -> 恢复 -> 热点变化 排序，
    // 保证同时宕机多个区域时不会把任务容灾到即将故障的区域。
    const eventOrder = { 'region-down': 0, 'region-up': 1, 'heat-update': 2 };
    const sortedEvents = [...bucketEvents].sort(
      (left, right) => eventOrder[left.type] - eventOrder[right.type]
    );
    const healthyAfterBucket = new Set(healthy);
    for (const event of sortedEvents) {
      if (event.type === 'region-down') healthyAfterBucket.delete(event.regionId);
      if (event.type === 'region-up') healthyAfterBucket.add(event.regionId);
    }
    for (const event of sortedEvents) {
      if (event.type === 'region-down') {
        applyRegionDown(event.regionId, healthyAfterBucket);
      } else if (event.type === 'region-up') {
        applyRegionUp(event.regionId);
      } else if (event.type === 'heat-update') {
        applyHeatUpdate(event);
      }
    }

    for (const [, entry] of [...inflight]) {
      if (entry.finishBucket === bucketNow) {
        completeTask(entry.task);
      }
    }

    schedulePending();
    bucketNow += 1;
  }

  // 仍未安排的任务（如区域全程不可用）给出带截止时间的降级。
  for (const task of pending.values()) {
    degradation.push(
      regionUnavailableEntry({
        key: keyById.get(task.keyId),
        regionId: task.regionId,
        deadlineSecond: config.deadlineSeconds
      })
    );
  }
  allocateBypassAllowance(degradation, origin.maxBypassRps);

  return {
    mode: 'offline-simulation',
    finishedAtSecond: bucketNow,
    timeline,
    replans,
    degradation: {
      bypassBudgetRps: origin.maxBypassRps,
      entries: degradation
    },
    loaded: Object.fromEntries(
      [...loadedKeys.entries()].map(([regionId, set]) => [regionId, [...set].sort()])
    ),
    attempts: Object.fromEntries(attempts),
    summary: {
      failureCount,
      retryCount,
      failoverCount,
      exhaustedCount: degradation.filter((entry) => entry.type === 'retry-exhausted').length,
      peakOriginRps,
      finalPendingCount: pending.size,
      timelineEventCount: timeline.length
    }
  };
}
