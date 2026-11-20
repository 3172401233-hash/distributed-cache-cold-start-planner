// 时间桶（1 秒）预约板：在规划阶段为每个预热任务预留
// 1) 源站每秒请求数（RPS）与源站带宽
// 2) 每个区域的预热带宽
// 3) 同一热门键跨区域同时预热的并发上限
// 所有约束按秒精确记账，杜绝瞬时超限。

import { BUCKET_SECONDS, bucketsForSeconds } from './model.js';

export class ReservationBoard {
  constructor({ regions, origin, config }) {
    this.originRpsLimit = origin.rpsLimit;
    this.originBandwidthLimit = origin.bandwidthBytesPerSec;
    this.maxConcurrencyPerKey = config.maxConcurrencyPerKey;
    this.regionLimits = new Map(
      regions.map((region) => [region.id, region.bandwidthBytesPerSec])
    );
    this.originRps = new Map(); // bucket -> 已预约请求数
    this.originBytes = new Map(); // bucket -> 已预约字节
    this.regionBytes = new Map(); // `${regionId}:${bucket}` -> 字节
    this.keyActive = new Map(); // `${keyId}:${bucket}` -> 并发区域数
  }

  static spanFor(task) {
    return bucketsForSeconds(task.sizeBytes / task.bandwidthBytesPerSec);
  }

  static add(map, key, amount) {
    map.set(key, (map.get(key) ?? 0) + amount);
  }

  canPlace(task, startBucket) {
    const span = ReservationBoard.spanFor(task);
    const perBucketBytes = task.sizeBytes / span;
    for (let offset = 0; offset < span; offset += 1) {
      const bucket = startBucket + offset;
      if ((this.originRps.get(bucket) ?? 0) + 1 > this.originRpsLimit) {
        return false;
      }
      if (
        this.originBandwidthLimit > 0 &&
        (this.originBytes.get(bucket) ?? 0) + perBucketBytes > this.originBandwidthLimit
      ) {
        return false;
      }
      const regionKey = `${task.regionId}:${bucket}`;
      const regionLimit = this.regionLimits.get(task.regionId);
      if ((this.regionBytes.get(regionKey) ?? 0) + perBucketBytes > regionLimit) {
        return false;
      }
      const keyKey = `${task.keyId}:${bucket}`;
      if ((this.keyActive.get(keyKey) ?? 0) + 1 > this.maxConcurrencyPerKey) {
        return false;
      }
    }
    return true;
  }

  reserve(task, startBucket) {
    const span = ReservationBoard.spanFor(task);
    const perBucketBytes = task.sizeBytes / span;
    for (let offset = 0; offset < span; offset += 1) {
      const bucket = startBucket + offset;
      ReservationBoard.add(this.originRps, bucket, 1);
      if (perBucketBytes > 0) {
        ReservationBoard.add(this.originBytes, bucket, perBucketBytes);
        ReservationBoard.add(this.regionBytes, `${task.regionId}:${bucket}`, perBucketBytes);
      }
      ReservationBoard.add(this.keyActive, `${task.keyId}:${bucket}`, 1);
    }
    task.startBucket = startBucket;
    task.endBucket = startBucket + span; // 排他上界
    task.startSecond = startBucket * BUCKET_SECONDS;
    task.finishSecond = task.endBucket * BUCKET_SECONDS;
    task.durationSeconds = span * BUCKET_SECONDS;
    return task;
  }

  release(task) {
    if (task.startBucket === undefined) {
      return;
    }
    const span = task.endBucket - task.startBucket;
    const perBucketBytes = task.sizeBytes / span;
    for (let offset = 0; offset < span; offset += 1) {
      const bucket = task.startBucket + offset;
      this.originRps.set(bucket, this.originRps.get(bucket) - 1);
      if (perBucketBytes > 0) {
        this.originBytes.set(bucket, this.originBytes.get(bucket) - perBucketBytes);
        const regionKey = `${task.regionId}:${bucket}`;
        this.regionBytes.set(regionKey, this.regionBytes.get(regionKey) - perBucketBytes);
      }
      const keyKey = `${task.keyId}:${bucket}`;
      this.keyActive.set(keyKey, this.keyActive.get(keyKey) - 1);
    }
    delete task.startBucket;
    delete task.endBucket;
    delete task.startSecond;
    delete task.finishSecond;
    delete task.durationSeconds;
  }

  // 贪心放置：从 earliestBucket 开始逐秒试探，找到第一个满足全部约束的起点。
  schedule(task, earliestBucket = 0) {
    let startBucket = earliestBucket;
    let guard = 0;
    while (!this.canPlace(task, startBucket)) {
      startBucket += 1;
      guard += 1;
      if (guard > 1_000_000) {
        throw new Error(`任务 ${task.id} 找不到可行的预热时间窗，请检查限流与带宽配置`);
      }
    }
    return this.reserve(task, startBucket);
  }
}

// 规划任务的优先级：热度高 → TTL 短 → 对象小 → id 字典序，保证结果确定可复现。
export function compareTaskPriority(left, right) {
  if (right.heat !== left.heat) return right.heat - left.heat;
  if (left.ttlSeconds !== right.ttlSeconds) return left.ttlSeconds - right.ttlSeconds;
  if (left.sizeBytes !== right.sizeBytes) return left.sizeBytes - right.sizeBytes;
  if (left.keyId !== right.keyId) return left.keyId < right.keyId ? -1 : 1;
  if (left.regionId !== right.regionId) return left.regionId < right.regionId ? -1 : 1;
  return 0;
}
