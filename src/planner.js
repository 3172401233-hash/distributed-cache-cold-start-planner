// 冷启动规划器：容量准入 -> 分批预约预热 -> 截止时间/降级 -> 命中率与过期治理。

import { normalizeInput } from './model.js';
import { ReservationBoard, compareTaskPriority } from './scheduler.js';
import {
  allocateBypassAllowance,
  atRiskEntry,
  buildExpiryPolicy,
  capacityOverflowEntry
} from './policies.js';

function planAdmission(keys, regions) {
  const tasks = [];
  const degradation = [];
  const regionStats = regions.map((region) => ({
    regionId: region.id,
    capacityBytes: region.capacityBytes,
    admittedBytes: 0,
    admittedKeys: 0,
    overflowKeys: 0,
    admittedHeat: 0,
    overflowHeat: 0
  }));

  for (let regionIndex = 0; regionIndex < regions.length; regionIndex += 1) {
    const region = regions[regionIndex];
    const stats = regionStats[regionIndex];
    let usedBytes = 0;
    for (const key of keys) {
      if (usedBytes + key.sizeBytes <= region.capacityBytes) {
        usedBytes += key.sizeBytes;
        stats.admittedBytes = usedBytes;
        stats.admittedKeys += 1;
        stats.admittedHeat += key.heat;
        tasks.push({
          id: `${region.id}__${key.id}`,
          keyId: key.id,
          regionId: region.id,
          heat: key.heat,
          ttlSeconds: key.ttlSeconds,
          sizeBytes: key.sizeBytes,
          bandwidthBytesPerSec: region.bandwidthBytesPerSec
        });
      } else {
        stats.overflowKeys += 1;
        stats.overflowHeat += key.heat;
        degradation.push(capacityOverflowEntry({ key, regionId: region.id }));
      }
    }
  }
  return { tasks, degradation, regionStats };
}

function buildWaves(tasks) {
  const byStart = new Map();
  for (const task of tasks) {
    const group = byStart.get(task.startSecond) ?? [];
    group.push(task);
    byStart.set(task.startSecond, group);
  }
  return [...byStart.entries()]
    .sort(([left], [right]) => left - right)
    .map(([startSecond, waveTasks], index) => ({
      wave: index + 1,
      startSecond,
      taskCount: waveTasks.length,
      taskIds: waveTasks.map((task) => task.id)
    }));
}

function summarizeHitRate(keys, regions, regionStats) {
  const totalHeat = keys.reduce((sum, key) => sum + key.heat, 0) || 1;
  const perRegion = regionStats.map((stats) => {
    const estimatedHitRate = stats.admittedHeat / totalHeat;
    return {
      regionId: stats.regionId,
      admittedKeyRatio: stats.admittedKeys / Math.max(1, keys.length),
      capacityUtilization: stats.admittedBytes / stats.capacityBytes,
      estimatedHitRate,
      overflowKeyCount: stats.overflowKeys,
      overflowHeatRatio: stats.overflowHeat / totalHeat
    };
  });
  const overallHitRate =
    perRegion.reduce((sum, item) => sum + item.estimatedHitRate, 0) /
    Math.max(1, regions.length);
  return { perRegion, overallHitRate };
}

export function buildColdStartPlan(rawInput) {
  const { keys, regions, origin, config } = normalizeInput(rawInput);

  // 热度优先的准入顺序：热门键先占用容量。
  const orderedKeys = [...keys].sort((left, right) => {
    if (right.heat !== left.heat) return right.heat - left.heat;
    if (left.ttlSeconds !== right.ttlSeconds) return left.ttlSeconds - right.ttlSeconds;
    return left.id < right.id ? -1 : 1;
  });

  const { tasks, degradation, regionStats } = planAdmission(orderedKeys, regions);

  const board = new ReservationBoard({ regions, origin, config });
  const scheduled = tasks
    .sort(compareTaskPriority)
    .map((task) => board.schedule(task, 0));

  // 截止时间：完成时间晚于整体截止时间的任务，在截止前一律按降级回源处理。
  for (const task of scheduled) {
    if (task.startSecond >= config.deadlineSeconds) {
      degradation.push(atRiskEntry({ task, deadlineSecond: config.deadlineSeconds }));
    }
  }

  const waves = buildWaves(scheduled);
  const expiry = buildExpiryPolicy(orderedKeys, config);
  allocateBypassAllowance(degradation, origin.maxBypassRps);
  const hitRate = summarizeHitRate(orderedKeys, regions, regionStats);

  const peakOriginRps =
    board.originRps.size === 0 ? 0 : Math.max(...board.originRps.values());
  const expectedFinishSecond = scheduled.reduce(
    (max, task) => Math.max(max, task.finishSecond),
    0
  );

  return {
    generatedAt: new Date().toISOString(),
    mode: 'offline-simulation',
    config,
    constraints: {
      originRpsLimit: origin.rpsLimit,
      originBandwidthBytesPerSec: origin.bandwidthBytesPerSec,
      maxConcurrencyPerKey: config.maxConcurrencyPerKey,
      deadlineSeconds: config.deadlineSeconds
    },
    waves,
    tasks: scheduled.map((task) => ({ ...task })),
    capacity: regionStats,
    hitRate: {
      ...hitRate,
      target: config.hitRateTarget,
      missesTarget: hitRate.overallHitRate < config.hitRateTarget,
      note:
        hitRate.overallHitRate < config.hitRateTarget
          ? '命中率低于目标，未覆盖键的请求按 degradation 中的限流配额回源'
          : '命中率达到目标'
    },
    expiryPolicy: expiry,
    degradation: {
      bypassBudgetRps: origin.maxBypassRps,
      entries: degradation
    },
    summary: {
      keyCount: keys.length,
      regionCount: regions.length,
      taskCount: scheduled.length,
      waveCount: waves.length,
      peakOriginRps,
      expectedFinishSecond,
      meetsDeadline: expectedFinishSecond <= config.deadlineSeconds,
      degradationCount: degradation.length,
      degradationByType: degradation.reduce((acc, entry) => {
        acc[entry.type] = (acc[entry.type] ?? 0) + 1;
        return acc;
      }, {})
    }
  };
}
