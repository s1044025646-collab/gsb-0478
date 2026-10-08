import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { AppError } from '../src/errors.js';
import { calculateLof, transformPoints } from '../src/lof.js';
import { Store } from '../src/store.js';

const lofById = (points: ReturnType<typeof calculateLof>['points']) =>
  Object.fromEntries(points.map((point) => [point.id, point.lof]));

describe('LOF 手算小例', () => {
  test('k=1 的三个非等距一维点为 1, 1, 2', () => {
    const report = calculateLof([
      { id: 'p0', x: 0, y: 0 },
      { id: 'p1', x: 1, y: 0 },
      { id: 'p3', x: 3, y: 0 },
    ], { k: 1 });
    expect(lofById(report.points)).toEqual({ p0: 1, p1: 1, p3: 2 });
  });

  test('k=1 时中点有两个并列最近邻，全部纳入且分数均为 1', () => {
    const report = calculateLof([
      { id: 'left', x: 0, y: 0 },
      { id: 'mid', x: 1, y: 0 },
      { id: 'right', x: 2, y: 0 },
    ], { k: 1 });
    const mid = report.points.find((point) => point.id === 'mid')!;
    expect(mid.actualNeighborhoodSize).toBe(2);
    expect(mid.neighbors.map((neighbor) => neighbor.id).sort()).toEqual(['left', 'right']);
    expect(lofById(report.points)).toEqual({ left: 1, mid: 1, right: 1 });
  });

  test('正方形等距点在 k=n-1 时全部为 1', () => {
    const square = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1, y: 0 },
      { id: 'c', x: 1, y: 1 },
      { id: 'd', x: 0, y: 1 },
    ];
    const report = calculateLof(square, { k: 3 });
    for (const point of report.points) {
      expect(point.actualNeighborhoodSize).toBe(3);
      expect(point.lof).toBeCloseTo(1, 12);
    }
  });

  test('完全重合坐标被拒绝，相同邻距可以保留', () => {
    expect(() => calculateLof([
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 0, y: 0 },
      { id: 'c', x: 1, y: 0 },
    ], { k: 1 })).toThrow(AppError);
  });

  test('输入重排与刚性平移旋转保持 LOF', () => {
    const points = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1, y: 0 },
      { id: 'c', x: 3, y: 1 },
      { id: 'd', x: 7, y: 0 },
      { id: 'e', x: 7.2, y: -0.1 },
    ];
    const original = lofById(calculateLof(points, { k: 2 }).points);
    const translated = transformPoints(points, (x, y) => [x + 10, y - 4]);
    const angle = 0.73;
    const rotated = transformPoints(points, (x, y) => [
      x * Math.cos(angle) - y * Math.sin(angle) + 3,
      x * Math.sin(angle) + y * Math.cos(angle) - 2,
    ]);
    for (const transformed of [translated, rotated, [...points].reverse()]) {
      const result = lofById(calculateLof(transformed, { k: 2 }).points);
      for (const id of Object.keys(original)) {
        expect(result[id]).toBeCloseTo(original[id]!, 10);
      }
    }
  });

  test('整体正比例缩放不改变 LOF，单独缩放轴可以改变', () => {
    const points = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1, y: 0 },
      { id: 'c', x: 2, y: 0.3 },
      { id: 'd', x: 6, y: 0 },
      { id: 'e', x: 6.2, y: 0 },
    ];
    const original = lofById(calculateLof(points, { k: 2 }).points);
    const scaled = lofById(calculateLof(transformPoints(points, (x, y) => [x * 5, y * 5]), { k: 2 }).points);
    const anisotropic = lofById(calculateLof(transformPoints(points, (x, y) => [x * 10, y]), { k: 2 }).points);
    for (const id of Object.keys(original)) expect(scaled[id]).toBeCloseTo(original[id]!, 10);
    expect(Object.values(anisotropic).some((value, index) => Math.abs(value - Object.values(original)[index]!) > 1e-9)).toBe(true);
  });

  test('排名降序、并列 ID 固定，阈值只做标记', () => {
    const report = calculateLof([
      { id: 'z', x: 0, y: 0 },
      { id: 'a', x: 1, y: 0 },
      { id: 'm', x: 3, y: 0 },
    ], { k: 1, threshold: 1.5 });
    expect(report.points.map((point) => point.id)).toEqual(['m', 'a', 'z']);
    expect(report.points.find((point) => point.id === 'm')?.marked).toBe(true);
    expect(report.points.find((point) => point.id === 'a')?.marked).toBe(false);
  });
});

describe('SQLite 冻结结果', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

  test('重复请求幂等，增删点创建新版本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lof-'));
    dirs.push(dir);
    const store = new Store(join(dir, 'test.sqlite'));
    const dataset = store.createDataset({
      points: [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 1, y: 0 },
        { id: 'c', x: 3, y: 0 },
      ],
    });
    const first = store.analyze(dataset.id, 1, undefined, 'request-1');
    const second = store.analyze(dataset.id, 1, undefined, 'request-1');
    expect(second.id).toBe(first.id);

    const replaced = store.replacePoints(dataset.id, [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 1, y: 0 },
      { id: 'c', x: 2, y: 0 },
    ]);
    expect(replaced.currentVersion).toBe(2);
    const next = store.analyze(dataset.id, 1, undefined, 'request-1');
    expect(next.version).toBe(2);
    expect(next.id).not.toBe(first.id);
    const reopened = new Store(join(dir, 'test.sqlite'));
    expect(reopened.getAnalysis(first.id).report.points.find((point) => point.id === 'c')?.lof).toBe(2);
    store.close();
    reopened.close();
  });
});
