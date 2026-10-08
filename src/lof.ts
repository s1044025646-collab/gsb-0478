import { AppError } from './errors.js';

export interface InputPoint {
  id: string;
  x: number;
  y: number;
}

export interface PointRecord extends InputPoint {
  ordinal: number;
}

export interface NeighborDetail {
  id: string;
  squaredDistance: number;
  distance: number;
  neighborKDistance: number;
  reachabilityDistance: number;
  neighborLrd: number;
  densityRatio: number;
  includedBecause: 'distance <= k-distance';
}

export interface PointReport {
  id: string;
  x: number;
  y: number;
  ordinal: number;
  squaredKDistance: number;
  kDistance: number;
  actualNeighborhoodSize: number;
  neighbors: NeighborDetail[];
  reachabilityDistanceSum: number;
  lrd: number;
  lof: number;
  rank: number;
  marked: boolean;
}

export interface LofOptions {
  k: number;
  threshold?: number | null;
}

export interface LofReport {
  algorithm: 'LOF';
  dimension: 2;
  distanceMetric: 'EUCLIDEAN_RAW_2D';
  comparisonRule: 'SQUARED_DISTANCE_EXACT_FLOAT64';
  pointCount: number;
  requestedK: number;
  threshold: number | null;
  points: PointReport[];
  generatedAt: string;
}

interface IntermediatePoint extends PointRecord {
  squaredKDistance: number;
  kDistance: number;
  neighborIndexes: number[];
}

export const MAX_ABS_COORDINATE = 1e100;

export function validatePoints(points: readonly InputPoint[]): asserts points is readonly InputPoint[] {
  if (!Array.isArray(points) || points.length < 3 || points.length > 500) {
    throw new AppError('VALIDATION_ERROR', '点数必须为 3 到 500 的完整本地点集。');
  }
  const ids = new Set<string>();
  const coordinateKeys = new Map<string, string>();

  for (const point of points) {
    if (!point || typeof point.id !== 'string' || point.id.trim().length === 0 || point.id.length > 128) {
      throw new AppError('VALIDATION_ERROR', '每个点都必须包含 1 到 128 个字符的非空字符串 ID。');
    }
    if (ids.has(point.id)) {
      throw new AppError('DUPLICATE_ID', `点 ID 重复：${point.id}`, { id: point.id });
    }
    ids.add(point.id);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) ||
      Math.abs(point.x) > MAX_ABS_COORDINATE || Math.abs(point.y) > MAX_ABS_COORDINATE) {
      throw new AppError('VALIDATION_ERROR', `点 ${point.id} 的坐标必须是有限数，且绝对值不超过 ${MAX_ABS_COORDINATE}。`, {
        id: point.id,
        x: point.x,
        y: point.y,
      });
    }
    const key = `${point.x}/${point.y}`;
    const existing = coordinateKeys.get(key);
    if (existing !== undefined) {
      throw new AppError('DUPLICATE_POINT', `点 ${point.id} 与 ${existing} 坐标完全相同；本服务拒绝零距离退化。`, {
        duplicateId: point.id,
        existingId: existing,
      });
    }
    coordinateKeys.set(key, point.id);
  }
}

export function validateK(k: number, n: number): asserts k is number {
  if (!Number.isInteger(k) || k < 1 || k > n - 1) {
    throw new AppError('INVALID_K', `k 必须是 1 到 n-1（当前 n=${n}）的整数。`, { k, n });
  }
}

function finiteOrOverflow(value: number, description: string): number {
  if (!Number.isFinite(value)) {
    throw new AppError('NUMERIC_OVERFLOW', `${description}超出 Float64 可表示范围，计算失败；不会把 Infinity 当作 LOF。`);
  }
  return value;
}

export function calculateLof(input: readonly InputPoint[], options: LofOptions): LofReport {
  validatePoints(input);
  const points: PointRecord[] = input.map((point, ordinal) => ({ ...point, ordinal }));
  const n = points.length;
  validateK(options.k, n);
  if (options.threshold !== undefined && options.threshold !== null &&
    (!Number.isFinite(options.threshold) || options.threshold < 0)) {
    throw new AppError('VALIDATION_ERROR', '展示阈值必须是非负有限数；它只影响标记和筛选。');
  }

  const distances: Float64Array[] = [];
  for (let i = 0; i < n; i += 1) {
    distances.push(new Float64Array(n));
  }

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const dx = points[i]!.x - points[j]!.x;
      const dy = points[i]!.y - points[j]!.y;
      const squared = finiteOrOverflow(dx * dx + dy * dy, `点 ${points[i]!.id} 与 ${points[j]!.id} 的平方距离`);
      distances[i]![j] = squared;
      distances[j]![i] = squared;
    }
  }

  const intermediate: IntermediatePoint[] = points.map((point, index) => {
    const others = points
      .map((candidate, candidateIndex) => ({ squared: distances[index]![candidateIndex]!, index: candidateIndex }))
      .filter((candidate) => candidate.index !== index);
    others.sort((a, b) => (a.squared === b.squared ? a.index - b.index : a.squared - b.squared));
    const kth = others[options.k - 1];
    if (!kth) {
      throw new AppError('INVALID_K', '无法取得第 k 小距离。', { k: options.k });
    }
    const neighborIndexes = others
      .filter((candidate) => candidate.squared === kth.squared || candidate.squared < kth.squared)
      .map((candidate) => candidate.index);
    const kDistance = finiteOrOverflow(Math.sqrt(kth.squared), `点 ${point.id} 的 k-distance`);
    return { ...point, squaredKDistance: kth.squared, kDistance, neighborIndexes };
  });

  const lrds = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (const neighborIndex of intermediate[i]!.neighborIndexes) {
      const reach = Math.max(intermediate[neighborIndex]!.kDistance, Math.sqrt(distances[i]![neighborIndex]!));
      sum = finiteOrOverflow(sum + reach, `点 ${intermediate[i]!.id} 的可达距离和`);
    }
    if (sum <= 0 || !Number.isFinite(sum)) {
      throw new AppError('NUMERIC_OVERFLOW', `点 ${intermediate[i]!.id} 的可达距离和无效。`);
    }
    lrds[i] = finiteOrOverflow(intermediate[i]!.neighborIndexes.length / sum, `点 ${intermediate[i]!.id} 的局部可达密度`);
  }

  const reports: PointReport[] = [];
  for (let i = 0; i < n; i += 1) {
    const source = intermediate[i]!;
    const neighbors: NeighborDetail[] = source.neighborIndexes.map((neighborIndex) => {
      const neighbor = intermediate[neighborIndex]!;
      const distance = Math.sqrt(distances[i]![neighborIndex]!);
      const reachabilityDistance = Math.max(neighbor.kDistance, distance);
      const neighborLrd = lrds[neighborIndex]!;
      const densityRatio = finiteOrOverflow(neighborLrd / lrds[i]!, `点 ${source.id} 到 ${neighbor.id} 的密度比`);
      return {
        id: neighbor.id,
        squaredDistance: distances[i]![neighborIndex]!,
        distance: finiteOrOverflow(distance, `点 ${source.id} 到 ${neighbor.id} 的距离`),
        neighborKDistance: neighbor.kDistance,
        reachabilityDistance: finiteOrOverflow(reachabilityDistance, `点 ${source.id} 到 ${neighbor.id} 的可达距离`),
        neighborLrd: finiteOrOverflow(neighborLrd, `点 ${neighbor.id} 的 LRD`),
        densityRatio,
        includedBecause: 'distance <= k-distance' as const,
      };
    }).sort((a, b) => compareId(a.id, b.id));

    const reachSum = neighbors.reduce((sum, neighbor) => sum + neighbor.reachabilityDistance, 0);
    const lof = finiteOrOverflow(
      neighbors.reduce((sum, neighbor) => sum + neighbor.densityRatio, 0) / source.neighborIndexes.length,
      `点 ${source.id} 的 LOF`,
    );
    reports.push({
      id: source.id,
      x: source.x,
      y: source.y,
      ordinal: source.ordinal,
      squaredKDistance: source.squaredKDistance,
      kDistance: source.kDistance,
      actualNeighborhoodSize: source.neighborIndexes.length,
      neighbors,
      reachabilityDistanceSum: finiteOrOverflow(reachSum, `点 ${source.id} 的可达距离和`),
      lrd: lrds[i]!,
      lof,
      rank: 0,
      marked: options.threshold === undefined || options.threshold === null ? false : lof > options.threshold,
    });
  }

  const sorted = reports.toSorted((a, b) => b.lof - a.lof || compareId(a.id, b.id));
  sorted.forEach((point, index) => {
    point.rank = index + 1;
  });

  return {
    algorithm: 'LOF',
    dimension: 2,
    distanceMetric: 'EUCLIDEAN_RAW_2D',
    comparisonRule: 'SQUARED_DISTANCE_EXACT_FLOAT64',
    pointCount: n,
    requestedK: options.k,
    threshold: options.threshold === undefined ? null : options.threshold,
    points: sorted,
    generatedAt: new Date().toISOString(),
  };
}

export function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function transformPoints(points: readonly InputPoint[], transform: (x: number, y: number) => [number, number]): InputPoint[] {
  return points.map((point) => {
    const [x, y] = transform(point.x, point.y);
    return { id: point.id, x, y };
  });
}
