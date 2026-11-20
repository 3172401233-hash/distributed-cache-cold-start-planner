import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, '..', 'src', 'cli.js');
const scenarioPath = path.join(here, '..', 'examples', 'scenario.json');

test('CLI：从文件生成计划并可附带场景模拟', () => {
  const output = execFileSync(
    process.execPath,
    [cliPath, '--simulate', scenarioPath],
    { encoding: 'utf8' }
  );
  const result = JSON.parse(output);
  assert.equal(result.plan.mode, 'offline-simulation');
  assert.ok(result.plan.tasks.length > 0);
  assert.ok(result.plan.summary.peakOriginRps <= 2);
  assert.equal(result.simulation.mode, 'offline-simulation');
  assert.ok(result.simulation.summary.retryCount >= 1);
  assert.ok(result.simulation.timeline.some((event) => event.type === 'region-down'));
});

test('CLI：支持 stdin 输入', () => {
  const input = JSON.stringify({
    keys: [{ id: 'k', heat: 1, ttlSeconds: 60, sizeBytes: 1024 }],
    regions: [{ id: 'r', capacityBytes: 10_000, bandwidthMbps: 8 }],
    origin: { rpsLimit: 5, maxBypassRps: 1 }
  });
  const output = execFileSync(process.execPath, [cliPath], {
    encoding: 'utf8',
    input
  });
  const result = JSON.parse(output);
  assert.equal(result.plan.tasks[0].keyId, 'k');
});

test('CLI：--help 输出使用说明', () => {
  const output = execFileSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
  assert.match(output, /离线模拟/);
  assert.match(output, /--simulate/);
});
