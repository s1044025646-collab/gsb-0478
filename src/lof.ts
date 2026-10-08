/**
 * 二维 LOF（局部离群因子）核心计算。
 *
 * 口径说明（公开浮点口径）：
 * - 距离为原始坐标的欧氏距离，不做任何轴标准化。
 * - 排序与“相等”判定基于平方距离的精确 Number 比较，不使用模糊容差。
 * - k-distance(p) = 排除自身后第 k 小的距离。
 * - 邻域 Nk(p) = 所有距离 <= k-distance(p) 的其他点（并列全部纳入，可能多于 k 个）。
 * - reach(p,o) = max(k-distance(o), dist(p,o))，下界来自邻点 o。
 * - lrd(p) = |Nk(p)| / sum(reach(p,o))。
 * - LOF(p) = mean over o in Nk(p) of lrd(o)/lrd(p)。
 */

export interface Point {
  id: string;
  x: number;
  y: number;
}

export const MIN_POINTS = 3;
export const MAX_POINTS = 500;
/** 坐标绝对值上限，保证平方距离与求和不会溢出为 Infinity。 */
export const MAX_ABS_COORD = 1e150;

export type ErrorCode =
  | "INVALID_POINT_COUNT"
  | "INVALID_POINT_ID"
  | "DUPLICATE_POINT_ID"
  | "NON_FINITE_COORDINATE"
  | "COORDINATE_OUT_OF_RANGE"
  | "DUPLICATE_COORDINATES"
  | "INVALID_K"
  | "NUMERIC_OVERFLOW"
  | "NOT_FOUND"
  | "INVALID_INPUT";

export class LofError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export function validatePoints(points: Point[]): void {
  if (!Array.isArray(points) || points.length < MIN_POINTS || points.length > MAX_POINTS) {
    throw new LofError(
      "INVALID_POINT_COUNT",
      `点数必须在 ${MIN_POINTS} 到 ${MAX_POINTS} 之间，当前为 ${Array.isArray(points) ? points.length : "非数组"}`
    );
  }
  const ids = new Set<string>();
  const coords = new Set<string>();
  for (const p of points) {
    if (!p || typeof p.id !== "string" || p.id.length === 0) {
      throw new LofError("INVALID_POINT_ID", "每个点必须包含非空字符串 id");
    }
    if (ids.has(p.id)) {
      throw new LofError("DUPLICATE_POINT_ID", `点 id 重复: ${p.id}`);
    }
    ids.add(p.id);
    if (typeof p.x !== "number" || typeof p.y !== "number" || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new LofError("NON_FINITE_COORDINATE", `点 ${p.id} 的坐标必须是有限数`);
    }
    if (Math.abs(p.x) > MAX_ABS_COORD || Math.abs(p.y) > MAX_ABS_COORD) {
      throw new LofError("COORDINATE_OUT_OF_RANGE", `点 ${p.id} 的坐标超出允许范围 ±${MAX_ABS_COORD}`);
    }
    // 精确坐标判重：拒绝两个点坐标完全相同（避免零距离退化）。
    const key = `${p.x} ${p.y}`;
    if (coords.has(key)) {
      throw new LofError("DUPLICATE_COORDINATES", `存在坐标完全相同的点（含 ${p.id}），本题拒绝重合点`);
    }
    coords.add(key);
  }
}

export function validateK(k: unknown, n: number): asserts k is number {
  if (typeof k !== "number" || !Number.isInteger(k) || k < 1 || k > n - 1) {
    throw new LofError("INVALID_K", `k 必须是 1 到 n-1（${n - 1}）之间的整数，当前为 ${String(k)}`);
  }
}

export interface NeighborDetail {
  id: string;
  distance: number;
  kDistance: number;
  reachability: number;
  lrd: number;
  lrdRatio: number;
}

export interface PointResult {
  id: string;
  kDistance: number;
  neighborhoodSize: number;
  lrd: number;
  lof: number;
  neighbors: NeighborDetail[];
}

export interface LofResult {
  k: number;
  pointCount: number;
  points: PointResult[];
}

function sqDist(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function computeLof(points: Point[], k: number): LofResult {
  validatePoints(points);
  validateK(k, points.length);
  const n = points.length;

  // 全对平方距离矩阵（朴素实现，n <= 500 可接受）。
  const d2: number[][] = [];
  for (let i = 0; i < n; i++) d2.push(new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const v = sqDist(points[i], points[j]);
      d2[i][j] = v;
      d2[j][i] = v;
    }
  }

  // 第一步：全部点的 k-distance 与邻域（并列全部纳入）。
  const kDist2: number[] = new Array(n);
  const neighborIdx: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const others: { j: number; v: number }[] = [];
    for (let j = 0; j < n; j++) {
      if (j !== i) others.push({ j, v: d2[i][j] });
    }
    // 按平方距离精确排序；距离相等时按编号排序仅为稳定展示，不影响谁被排除。
    others.sort((a, b) => (a.v < b.v ? -1 : a.v > b.v ? 1 : a.j - b.j));
    const kd2 = others[k - 1].v;
    kDist2[i] = kd2;
    neighborIdx[i] = others.filter((o) => o.v <= kd2).map((o) => o.j);
  }
  const kDist = kDist2.map(Math.sqrt);

  // 第二步：全部点的可达距离和与 lrd（必须先全部算完再求 LOF）。
  const lrd: number[] = new Array(n);
  const reach: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const nb = neighborIdx[i];
    reach[i] = new Array(nb.length);
    let sum = 0;
    for (let t = 0; t < nb.length; t++) {
      const j = nb[t];
      const r = Math.max(kDist[j], Math.sqrt(d2[i][j]));
      reach[i][t] = r;
      sum += r;
    }
    lrd[i] = nb.length / sum;
    if (!Number.isFinite(lrd[i])) {
      throw new LofError("NUMERIC_OVERFLOW", `点 ${points[i].id} 的局部可达密度计算溢出，分析失败`);
    }
  }

  // 第三步：LOF = 邻点 lrd 比值的平均，分母为实际邻域大小。
  const results: PointResult[] = [];
  for (let i = 0; i < n; i++) {
    const nb = neighborIdx[i];
    let ratioSum = 0;
    const neighbors: NeighborDetail[] = nb.map((j, t) => {
      const ratio = lrd[j] / lrd[i];
      ratioSum += ratio;
      return {
        id: points[j].id,
        distance: Math.sqrt(d2[i][j]),
        kDistance: kDist[j],
        reachability: reach[i][t],
        lrd: lrd[j],
        lrdRatio: ratio,
      };
    });
    neighbors.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const lof = ratioSum / nb.length;
    if (!Number.isFinite(lof)) {
      throw new LofError("NUMERIC_OVERFLOW", `点 ${points[i].id} 的 LOF 计算溢出，分析失败`);
    }
    results.push({
      id: points[i].id,
      kDistance: kDist[i],
      neighborhoodSize: nb.length,
      lrd: lrd[i],
      lof,
      neighbors,
    });
  }
  results.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { k, pointCount: n, points: results };
}
