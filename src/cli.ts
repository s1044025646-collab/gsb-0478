#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError } from './errors.js';
import { explanationsToCsv, reportToCsv, reportToJson } from './exporters.js';
import { calculateLof, transformPoints, type InputPoint } from './lof.js';
import { Store } from './store.js';

const projectRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '-h', '--help'].includes(command)) return printHelp();

  if (command === 'demo') {
    const outDir = resolve(projectRoot, 'data', 'demo');
    mkdirSync(outDir, { recursive: true });
    const points: InputPoint[] = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1, y: 0 },
      { id: 'c', x: 3, y: 0 },
      { id: 'd', x: 7, y: 0 },
      { id: 'e', x: 7.2, y: 0 },
    ];
    const report = calculateLof(points, { k: 1, threshold: 1.5 });
    writeFileSync(resolve(outDir, 'demo.json'), reportToJson(report), 'utf8');
    writeFileSync(resolve(outDir, 'demo.csv'), reportToCsv(report), 'utf8');
    writeFileSync(resolve(outDir, 'demo-edges.csv'), explanationsToCsv(report), 'utf8');
    console.log(JSON.stringify(report, null, 2));
    console.log(`\n已导出：${outDir}`);
    return;
  }

  if (command === 'analyze-file') {
    const options = parseOptions(args);
    const file = required(options, 'input');
    const k = Number(required(options, 'k'));
    const threshold = options.has('threshold') ? Number(options.get('threshold')) : undefined;
    const payload = JSON.parse(readFileSync(resolve(file), 'utf8')) as { points: InputPoint[] };
    const report = calculateLof(payload.points, threshold === undefined ? { k } : { k, threshold });
    const format = options.get('format') ?? 'json';
    const content = format === 'csv' ? reportToCsv(report) : reportToJson(report);
    const output = options.get('output');
    if (output) writeFileSync(resolve(output), content, 'utf8');
    else process.stdout.write(content);
    return;
  }

  if (command === 'check-invariants') {
    const file = required(parseOptions(args), 'input');
    const payload = JSON.parse(readFileSync(resolve(file), 'utf8')) as { points: InputPoint[] };
    const ordered = calculateLof(payload.points, { k: 1 });
    const rotated = calculateLof(transformPoints(payload.points, (x, y) => [x * Math.SQRT1_2 - y * Math.SQRT1_2, x * Math.SQRT1_2 + y * Math.SQRT1_2]), { k: 1 });
    const reordered = calculateLof([...payload.points].reverse(), { k: 1 });
    const closeEnough = (a: number, b: number) => Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b));
    for (const point of ordered.points) {
      const afterRotation = rotated.points.find((candidate) => candidate.id === point.id)!;
      const afterReorder = reordered.points.find((candidate) => candidate.id === point.id)!;
      if (!closeEnough(point.lof, afterRotation.lof) || !closeEnough(point.lof, afterReorder.lof)) {
        throw new AppError('VALIDATION_ERROR', `点 ${point.id} 未通过刚性旋转或输入重排不变性检查。`);
      }
    }
    console.log(JSON.stringify({ ok: true, pointCount: ordered.pointCount, check: 'rotation-and-reorder' }, null, 2));
    return;
  }

  if (command === 'explain-file') {
    const options = parseOptions(args);
    const payload = JSON.parse(readFileSync(resolve(required(options, 'input')), 'utf8')) as { points: InputPoint[] };
    const pointId = required(options, 'point');
    const report = calculateLof(payload.points, { k: Number(required(options, 'k')) });
    const point = report.points.find((candidate) => candidate.id === pointId);
    if (!point) throw new AppError('NOT_FOUND', `点 ${pointId} 不存在。`);
    process.stdout.write(JSON.stringify(point, null, 2));
    return;
  }

  if (command === 'compare-k') {
    const options = parseOptions(args);
    const payload = JSON.parse(readFileSync(resolve(required(options, 'input')), 'utf8')) as { points: InputPoint[] };
    const ks = required(options, 'ks').split(',').map((value) => Number(value));
    const comparisons = ks.map((k) => ({
      k,
      lofById: Object.fromEntries(calculateLof(payload.points, { k }).points.map((point) => [point.id, point.lof])),
    }));
    process.stdout.write(JSON.stringify({ comparisons }, null, 2));
    return;
  }

  if (command === 'serve-db') {
    const dbPath = resolve(projectRoot, 'data', 'lof.sqlite');
    mkdirSync(resolve(dbPath, '..'), { recursive: true });
    const store = new Store(dbPath);
    const file = required(parseOptions(args.slice(1)), 'input');
    const payload = JSON.parse(readFileSync(resolve(file), 'utf8')) as CreatePayload;
    const snapshot = store.createDataset(payload);
    const analysis = store.analyze(snapshot.id, Number(required(parseOptions(args), 'k')), undefined, undefined);
    console.log(JSON.stringify({ dataset: snapshot, analysis: { id: analysis.id, version: analysis.version } }, null, 2));
    store.close();
    return;
  }

  throw new AppError('VALIDATION_ERROR', `未知命令：${command}`);
}

interface CreatePayload {
  name?: string;
  xUnit?: string;
  yUnit?: string;
  points: InputPoint[];
}

function parseOptions(args: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith('--')) throw new AppError('VALIDATION_ERROR', `无法识别参数：${token}`);
    const key = token.slice(2);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      options.set(key, 'true');
    } else {
      options.set(key, value);
      index += 1;
    }
  }
  return options;
}

function required(options: Map<string, string>, key: string): string {
  const value = options.get(key);
  if (value === undefined) throw new AppError('VALIDATION_ERROR', `缺少必需参数 --${key}`);
  return value;
}

function printHelp(): void {
  console.log(`二维 LOF 本地 CLI

命令：
  demo                                      运行内置并列邻域与导出演示
  analyze-file --input points.json --k 2 [--threshold 1.5] [--format csv] [--output out.json]
  explain-file --input points.json --k 2 --point p1
  compare-k --input points.json --ks 1,2,3
  check-invariants --input points.json      检查旋转和输入重排不变性
  serve-db --input points.json --k 2        创建冻结 SQLite 数据集和分析
  help

points.json:
{"points":[{"id":"p1","x":0,"y":0}]}
`);
}

main().catch((error: unknown) => {
  if (error instanceof AppError) console.error(`[${error.code}] ${error.message}`);
  else console.error(error);
  process.exitCode = 1;
});
