import type { LofReport, PointReport } from './lof.js';

export function reportToJson(report: LofReport): string {
  return JSON.stringify(report, null, 2);
}

export function reportToCsv(report: LofReport): string {
  const header = [
    'rank', 'id', 'x', 'y', 'k', 'kDistance', 'actualNeighborhoodSize',
    'neighborIds', 'reachabilityDistanceSum', 'lrd', 'lof', 'marked',
  ];
  const lines = [header.join(',')];
  for (const point of report.points) {
    lines.push([
      point.rank,
      csv(point.id),
      point.x,
      point.y,
      report.requestedK,
      point.kDistance,
      point.actualNeighborhoodSize,
      csv(point.neighbors.map((neighbor) => neighbor.id).join('|')),
      point.reachabilityDistanceSum,
      point.lrd,
      point.lof,
      point.marked,
    ].join(','));
  }
  return `\uFEFF${lines.join('\n')}`;
}

export function explanationsToCsv(report: LofReport): string {
  const header = [
    'sourceId', 'sourceRank', 'neighborId', 'squaredDistance', 'distance',
    'sourceSquaredKDistance', 'sourceKDistance', 'neighborKDistance', 'reachabilityDistance',
    'sourceLrd', 'neighborLrd', 'densityRatio', 'includedBecause',
  ];
  const byId = new Map(report.points.map((point) => [point.id, point]));
  const lines = [header.join(',')];
  for (const point of report.points) {
    for (const neighbor of point.neighbors) {
      lines.push([
        csv(point.id), point.rank, csv(neighbor.id), neighbor.squaredDistance,
        neighbor.distance, point.squaredKDistance, point.kDistance, neighbor.neighborKDistance,
        neighbor.reachabilityDistance, point.lrd, neighbor.neighborLrd,
        neighbor.densityRatio, csv(neighbor.includedBecause),
      ].join(','));
    }
  }
  return `\uFEFF${lines.join('\n')}`;
}

export function getPoint(report: LofReport, pointId: string): PointReport {
  const point = report.points.find((candidate) => candidate.id === pointId);
  if (!point) {
    const available = report.points.map((candidate) => candidate.id).join(', ');
    throw new Error(`点 ${pointId} 不在冻结结果中。可用 ID：${available}`);
  }
  return point;
}

function csv(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
