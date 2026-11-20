#!/usr/bin/env node
// 命令行入口：读取 JSON 场景，输出冷启动预热计划（可选附场景模拟结果）。
// 本工具只做离线规划，不连接真实缓存、源站或任何网络服务。

import { readFile, writeFile } from 'node:fs/promises';
import { buildColdStartPlan } from './planner.js';
import { simulatePlan } from './simulator.js';

function parseArgs(argv) {
  const args = { input: null, output: null, simulate: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      args.help = true;
    } else if (token === '--simulate') {
      args.simulate = true;
    } else if (token === '--output' || token === '-o') {
      args.output = argv[++index];
    } else if (token.startsWith('--output=')) {
      args.output = token.slice('--output='.length);
    } else if (!token.startsWith('-')) {
      args.input = token;
    } else {
      throw new Error(`未知参数: ${token}`);
    }
  }
  return args;
}

const HELP = `多区域缓存冷启动规划器（离线模拟，不连接真实缓存）

用法:
  cold-start-plan [选项] <scenario.json>
  cat scenario.json | cold-start-plan [--simulate]

选项:
  --simulate        同时执行场景模拟（失败重试、区域故障、热点变化）
  --output, -o PATH 将结果写入文件，默认输出到 stdout
  --help, -h        显示本帮助

场景事件（放在输入 JSON 的 simulation.events）:
  { "type": "task-failure", "atSecond": 5, "taskId": "region-a__key-1" }
  { "type": "region-down",   "atSecond": 8, "regionId": "region-a" }
  { "type": "region-up",     "atSecond": 20, "regionId": "region-a" }
  { "type": "heat-update",   "atSecond": 12, "changes": [
      { "id": "new-hot-key", "heat": 99, "sizeBytes": 1024, "ttlSeconds": 30 }
  ] }
`;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  const rawText = args.input ? await readFile(args.input, 'utf8') : await readStdin();
  if (!rawText.trim()) {
    throw new Error('未收到任何输入 JSON');
  }
  const input = JSON.parse(rawText);
  const plan = buildColdStartPlan(input);
  const result = args.simulate
    ? { plan, simulation: simulatePlan(input, plan, input.simulation?.events ?? []) }
    : { plan };
  const json = JSON.stringify(result, null, 2);
  if (args.output) {
    await writeFile(args.output, `${json}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`错误: ${error.message}\n`);
  process.exitCode = 1;
});
