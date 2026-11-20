// 输入归一化、校验与确定性哈希工具。
// 整个工具是纯离线计算：不发起任何网络请求，也不连接真实缓存或源站。

export const BUCKET_SECONDS = 1; // 规划时间桶粒度：1 秒

export const DEGRADE = Object.freeze({
  CAPACITY_OVERFLOW: 'capacity-overflow', // 区域装不下：直接回源
  RETRY_EXHAUSTED: 'retry-exhausted', // 重试耗尽：回源
  REGION_UNAVAILABLE: 'region-unavailable', // 区域故障且无容身区域：回源
  UNPLANNED_HOTKEY: 'unplanned-hotkey', // 短时新热点未纳入计划：回源
  PREHEAT_AT_RISK: 'preheat-at-risk' // 截止时间前未完成预热：届时回源
});

export const DEFAULT_CONFIG = Object.freeze({
  maxRetries: 3,
  retryBaseDelaySeconds: 2,
  retryMaxDelaySeconds: 30,
  backoffFactor: 2,
  maxConcurrencyPerKey: 1, // 同一热门键跨区域最大同时预热数
  defaultRegionBandwidthMbps: 200, // 单区域预热带宽 Mbps
  ttlJitterFraction: 0.2, // TTL 抖动比例（±20%）
  preRefreshFraction: 0.1, // TTL 到期前 10% 提前续预热
  maxBypassRps: Infinity, // 回源限流中可划给降级请求的上限
  hitRateTarget: 0.95, // 命中率目标
  deadlineSeconds: 300 // 整体预热截止时间
});

const NON_NEGATIVE_NUMBER = (value, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} 必须是非负有限数字，收到 ${JSON.stringify(value)}`);
  }
};

const POSITIVE_NUMBER = (value, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} 必须是正有限数字，收到 ${JSON.stringify(value)}`);
  }
};

// FNV-1a 32 位哈希：让同一 key 的抖动在多次运行间保持确定，便于测试与复盘。
export function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// 返回 [-1, 1) 区间的确定性抖动值。
export function deterministicJitter(seedText) {
  return (fnv1a32(seedText) / 0xffffffff) * 2 - 1;
}

function normalizeKey(raw, index) {
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError(`keys[${index}] 必须是对象`);
  }
  const id = String(raw.id ?? raw.key ?? '');
  if (!id) {
    throw new TypeError(`keys[${index}] 缺少 id`);
  }
  POSITIVE_NUMBER(raw.sizeBytes, `keys[${id}].sizeBytes`);
  POSITIVE_NUMBER(raw.ttlSeconds, `keys[${id}].ttlSeconds`);
  NON_NEGATIVE_NUMBER(raw.heat ?? 1, `keys[${id}].heat`);
  return {
    id,
    heat: raw.heat ?? 1,
    ttlSeconds: raw.ttlSeconds,
    sizeBytes: raw.sizeBytes
  };
}

function normalizeRegion(raw, index) {
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError(`regions[${index}] 必须是对象`);
  }
  const id = String(raw.id ?? '');
  if (!id) {
    throw new TypeError(`regions[${index}] 缺少 id`);
  }
  POSITIVE_NUMBER(raw.capacityBytes, `regions[${id}].capacityBytes`);
  const bandwidthMbps = raw.bandwidthMbps ?? DEFAULT_CONFIG.defaultRegionBandwidthMbps;
  POSITIVE_NUMBER(bandwidthMbps, `regions[${id}].bandwidthMbps`);
  return {
    id,
    capacityBytes: raw.capacityBytes,
    bandwidthMbps,
    bandwidthBytesPerSec: (bandwidthMbps * 1_000_000) / 8
  };
}

function normalizeOrigin(raw) {
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError('origin 必须是对象');
  }
  POSITIVE_NUMBER(raw.rpsLimit ?? 1, 'origin.rpsLimit');
  NON_NEGATIVE_NUMBER(raw.bandwidthMbps ?? 0, 'origin.bandwidthMbps');
  const maxBypassRps = raw.maxBypassRps ?? DEFAULT_CONFIG.maxBypassRps;
  NON_NEGATIVE_NUMBER(maxBypassRps, 'origin.maxBypassRps');
  return {
    rpsLimit: raw.rpsLimit ?? 1,
    bandwidthBytesPerSec: ((raw.bandwidthMbps ?? 0) * 1_000_000) / 8,
    maxBypassRps
  };
}

export function normalizeInput(input) {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('输入必须是对象');
  }
  if (!Array.isArray(input.keys) || input.keys.length === 0) {
    throw new TypeError('keys 必须是非空数组');
  }
  if (!Array.isArray(input.regions) || input.regions.length === 0) {
    throw new TypeError('regions 必须是非空数组');
  }
  if (!input.origin) {
    throw new TypeError('缺少 origin 源站限流配置');
  }

  const keys = input.keys.map(normalizeKey);
  const regions = input.regions.map(normalizeRegion);
  const origin = normalizeOrigin(input.origin);

  const seenKeys = new Set();
  for (const key of keys) {
    if (seenKeys.has(key.id)) {
      throw new TypeError(`重复的键 id: ${key.id}`);
    }
    seenKeys.add(key.id);
  }
  const seenRegions = new Set();
  for (const region of regions) {
    if (seenRegions.has(region.id)) {
      throw new TypeError(`重复的区域 id: ${region.id}`);
    }
    seenRegions.add(region.id);
  }

  const userConfig = input.config ?? {};
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  NON_NEGATIVE_NUMBER(config.maxRetries, 'config.maxRetries');
  POSITIVE_NUMBER(config.retryBaseDelaySeconds, 'config.retryBaseDelaySeconds');
  POSITIVE_NUMBER(config.retryMaxDelaySeconds, 'config.retryMaxDelaySeconds');
  POSITIVE_NUMBER(config.backoffFactor, 'config.backoffFactor');
  POSITIVE_NUMBER(config.maxConcurrencyPerKey, 'config.maxConcurrencyPerKey');
  NON_NEGATIVE_NUMBER(config.ttlJitterFraction, 'config.ttlJitterFraction');
  NON_NEGATIVE_NUMBER(config.preRefreshFraction, 'config.preRefreshFraction');
  NON_NEGATIVE_NUMBER(config.hitRateTarget, 'config.hitRateTarget');
  POSITIVE_NUMBER(config.deadlineSeconds, 'config.deadlineSeconds');
  if (config.hitRateTarget > 1) {
    throw new TypeError('config.hitRateTarget 不能超过 1');
  }

  return { keys, regions, origin, config };
}

// 秒级向上取整，至少 1 个时间桶。
export function bucketsForSeconds(seconds) {
  return Math.max(1, Math.ceil(seconds / BUCKET_SECONDS));
}
