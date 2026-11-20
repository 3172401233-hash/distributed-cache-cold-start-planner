// 重试退避、降级/回源条目、TTL 抖动与同时过期治理策略。

import { DEGRADE, deterministicJitter } from './model.js';

// 指数退避 + 抖动 + 上限封顶。attempt 从 1 开始（第一次失败后的等待）。
export function retryBackoffSeconds(attempt, config, keyId = '') {
  const base =
    config.retryBaseDelaySeconds *
    Math.pow(config.backoffFactor, Math.max(0, attempt - 1));
  const capped = Math.min(base, config.retryMaxDelaySeconds);
  const jitter = 0.5 + 0.5 * deterministicJitter(`${keyId}:retry:${attempt}`);
  return Math.max(1, Math.round(capped * jitter));
}

// 按热度权重把回源限流中的降级配额切分给各回源条目。
export function allocateBypassAllowance(entries, totalRps) {
  if (!Number.isFinite(totalRps)) {
    for (const entry of entries) {
      entry.allowanceRps = Infinity;
    }
    return entries;
  }
  const weightSum = entries.reduce((sum, entry) => sum + entry.heat, 0) || 1;
  let remaining = totalRps;
  entries.forEach((entry, index) => {
    const share =
      index === entries.length - 1
        ? Math.max(0, remaining)
        : (totalRps * entry.heat) / weightSum;
    entry.allowanceRps = Math.round(share * 1000) / 1000;
    remaining -= share;
  });
  return entries;
}

function makeEntry({ type, keyId, regionId, heat, reason, deadlineSecond, fallback }) {
  return {
    type,
    keyId,
    regionId: regionId ?? null,
    heat,
    reason,
    fallback,
    deadlineSecond, // 截止时间：超过该秒仍未预热成功则按 fallback 回源
    allowanceRps: 0
  };
}

export function capacityOverflowEntry({ key, regionId }) {
  return makeEntry({
    type: DEGRADE.CAPACITY_OVERFLOW,
    keyId: key.id,
    regionId,
    heat: key.heat,
    reason: `区域 ${regionId} 剩余容量不足，对象 ${key.sizeBytes} 字节无法装入`,
    deadlineSecond: 0,
    fallback: 'bypass-to-origin'
  });
}

export function retryExhaustedEntry({ task, config }) {
  return makeEntry({
    type: DEGRADE.RETRY_EXHAUSTED,
    keyId: task.keyId,
    regionId: task.regionId,
    heat: task.heat,
    reason: `预热连续失败，${config.maxRetries} 次重试已耗尽`,
    deadlineSecond: task.endBucket,
    fallback: 'bypass-to-origin'
  });
}
export function regionUnavailableEntry({ key, regionId, deadlineSecond }) {
  return makeEntry({
    type: DEGRADE.REGION_UNAVAILABLE,
    keyId: key.id,
    regionId,
    heat: key.heat,
    reason: `区域 ${regionId} 故障且无健康区域可承接预热`,
    deadlineSecond,
    fallback: 'bypass-to-origin'
  });
}

export function unplannedHotkeyEntry({ key, regionId, deadlineSecond }) {
  return makeEntry({
    type: DEGRADE.UNPLANNED_HOTKEY,
    keyId: key.id,
    regionId,
    heat: key.heat,
    reason: '短时热点未包含在冷启动计划中，需重新规划',
    deadlineSecond,
    fallback: 'bypass-to-origin'
  });
}

export function atRiskEntry({ task, deadlineSecond }) {
  return makeEntry({
    type: DEGRADE.PREHEAT_AT_RISK,
    keyId: task.keyId,
    regionId: task.regionId,
    heat: task.heat,
    reason: `预热完成时间晚于截止时间 ${deadlineSecond}s，截止前请求需回源`,
    deadlineSecond,
    fallback: 'bypass-to-origin'
  });
}

// TTL 抖动：给每个键确定化地分配 ±jitterFraction 的 TTL 偏移，打散同时过期，
// 并给出到期前的续预热（pre-warm）时间点。
export function buildExpiryPolicy(keys, config) {
  const ttlGroups = new Map();
  const entries = keys.map((key) => {
    const jitter = deterministicJitter(`${key.id}:ttl`);
    const adjustedTtl = Math.max(
      1,
      Math.round(key.ttlSeconds * (1 + jitter * config.ttlJitterFraction))
    );
    const preWarmAt = Math.max(
      0,
      Math.round(adjustedTtl * (1 - config.preRefreshFraction))
    );
    const group = ttlGroups.get(key.ttlSeconds) ?? {
      ttlSeconds: key.ttlSeconds,
      count: 0,
      spreadAdjustedTtl: []
    };
    group.count += 1;
    group.spreadAdjustedTtl.push(adjustedTtl);
    ttlGroups.set(key.ttlSeconds, group);
    return {
      keyId: key.id,
      originalTtlSeconds: key.ttlSeconds,
      adjustedTtlSeconds: adjustedTtl,
      preWarmAtSecond: preWarmAt
    };
  });

  const simultaneousExpiryRisks = [...ttlGroups.values()]
    .filter((group) => group.count > 1)
    .map((group) => ({
      ttlSeconds: group.ttlSeconds,
      keyCount: group.count,
      mitigation: 'ttl-jitter',
      adjustedTtlRange: [
        Math.min(...group.spreadAdjustedTtl),
        Math.max(...group.spreadAdjustedTtl)
      ]
    }));

  return { entries, simultaneousExpiryRisks };
}
