/**
 * SQLite 持久化：点集、版本、冻结的分析结果。
 * 增删点产生新版本；分析按 (version_id, k) 唯一，重复请求幂等返回同一结果。
 */
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeLof, LofError, Point, validateK, validatePoints } from "./lof";

export const DISTANCE_METRIC = "euclidean-raw-coordinates/squared-distance-ordering/exact-equality/no-epsilon";

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS datasets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        unit_x TEXT NOT NULL DEFAULT 'unit',
        unit_y TEXT NOT NULL DEFAULT 'unit',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dataset_versions (
        id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL,
        version_no INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS points (
        version_id TEXT NOT NULL,
        point_id TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        PRIMARY KEY (version_id, point_id)
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL,
        k INTEGER NOT NULL,
        distance_metric TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (version_id, k)
      );
      CREATE TABLE IF NOT EXISTS analysis_points (
        analysis_id TEXT NOT NULL,
        point_id TEXT NOT NULL,
        k_distance REAL NOT NULL,
        neighborhood_size INTEGER NOT NULL,
        lrd REAL NOT NULL,
        lof REAL NOT NULL,
        PRIMARY KEY (analysis_id, point_id)
      );
      CREATE TABLE IF NOT EXISTS analysis_neighbors (
        analysis_id TEXT NOT NULL,
        point_id TEXT NOT NULL,
        neighbor_id TEXT NOT NULL,
        distance REAL NOT NULL,
        neighbor_k_distance REAL NOT NULL,
        reachability REAL NOT NULL,
        neighbor_lrd REAL NOT NULL,
        lrd_ratio REAL NOT NULL,
        PRIMARY KEY (analysis_id, point_id, neighbor_id)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private newId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  createDataset(name: string, unitX = "unit", unitY = "unit", points: Point[]): { datasetId: string; versionId: string; versionNo: number } {
    validatePoints(points);
    const datasetId = this.newId("ds");
    const versionId = this.newId("ver");
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO datasets (id, name, unit_x, unit_y, created_at) VALUES (?,?,?,?,?)").run(datasetId, name, unitX, unitY, now);
      this.db.prepare("INSERT INTO dataset_versions (id, dataset_id, version_no, created_at) VALUES (?,?,?,?)").run(versionId, datasetId, 1, now);
      const ins = this.db.prepare("INSERT INTO points (version_id, point_id, x, y) VALUES (?,?,?,?)");
      for (const p of points) ins.run(versionId, p.id, p.x, p.y);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { datasetId, versionId, versionNo: 1 };
  }

  getDataset(datasetId: string): { id: string; name: string; unit_x: string; unit_y: string } {
    const row = this.db.prepare("SELECT * FROM datasets WHERE id = ?").get(datasetId) as any;
    if (!row) throw new LofError("NOT_FOUND", `点集不存在: ${datasetId}`);
    return row;
  }

  listDatasets(): unknown[] {
    return this.db.prepare(`
      SELECT d.id, d.name, d.unit_x AS unitX, d.unit_y AS unitY,
             (SELECT MAX(version_no) FROM dataset_versions v WHERE v.dataset_id = d.id) AS latestVersion
      FROM datasets d ORDER BY d.created_at`).all();
  }

  latestVersion(datasetId: string): { id: string; version_no: number } {
    this.getDataset(datasetId);
    const row = this.db.prepare("SELECT id, version_no FROM dataset_versions WHERE dataset_id = ? ORDER BY version_no DESC LIMIT 1").get(datasetId) as any;
    return row;
  }

  getPoints(versionId: string): Point[] {
    const rows = this.db.prepare("SELECT point_id AS id, x, y FROM points WHERE version_id = ? ORDER BY point_id").all(versionId) as any[];
    return rows.map((r) => ({ id: r.id, x: r.x, y: r.y }));
  }

  /** 增删点：基于当前最新版本生成新版本（不可只更新被编辑点而沿用过期邻域）。 */
  mutatePoints(datasetId: string, add: Point[], removeIds: string[]): { versionId: string; versionNo: number; pointCount: number } {
    const cur = this.latestVersion(datasetId);
    const existing = this.getPoints(cur.id);
    const removeSet = new Set(removeIds);
    const kept = existing.filter((p) => !removeSet.has(p.id));
    const next = kept.concat(add);
    validatePoints(next);
    const versionId = this.newId("ver");
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO dataset_versions (id, dataset_id, version_no, created_at) VALUES (?,?,?,?)").run(versionId, datasetId, cur.version_no + 1, now);
      const ins = this.db.prepare("INSERT INTO points (version_id, point_id, x, y) VALUES (?,?,?,?)");
      for (const p of next) ins.run(versionId, p.id, p.x, p.y);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { versionId, versionNo: cur.version_no + 1, pointCount: next.length };
  }

  /**
   * 运行分析。幂等：同一 (version, k) 已成功则直接返回已有分析 id。
   * 一次报告原子发布：全部点结果在单个事务内写入。
   */
  analyze(datasetId: string, k: number, versionId?: string): { analysisId: string; versionId: string; reused: boolean } {
    const ver = versionId ? { id: versionId, version_no: 0 } : this.latestVersion(datasetId);
    const points = this.getPoints(ver.id);
    validatePoints(points);
    validateK(k, points.length);

    const existing = this.db.prepare("SELECT id, status FROM analyses WHERE version_id = ? AND k = ?").get(ver.id, k) as any;
    if (existing && existing.status === "ok") {
      return { analysisId: existing.id, versionId: ver.id, reused: true };
    }
    if (existing) {
      this.db.prepare("DELETE FROM analyses WHERE id = ?").run(existing.id);
    }

    let result;
    try {
      result = computeLof(points, k);
    } catch (e) {
      if (e instanceof LofError && e.code === "NUMERIC_OVERFLOW") {
        const failId = this.newId("ana");
        this.db.prepare("INSERT INTO analyses (id, version_id, k, distance_metric, status, error, created_at) VALUES (?,?,?,?,?,?,?)")
          .run(failId, ver.id, k, DISTANCE_METRIC, "failed", `${e.code}: ${e.message}`, new Date().toISOString());
      }
      throw e;
    }

    const analysisId = this.newId("ana");
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO analyses (id, version_id, k, distance_metric, status, error, created_at) VALUES (?,?,?,?,?,NULL,?)")
        .run(analysisId, ver.id, k, DISTANCE_METRIC, "ok", now);
      const insP = this.db.prepare("INSERT INTO analysis_points (analysis_id, point_id, k_distance, neighborhood_size, lrd, lof) VALUES (?,?,?,?,?,?)");
      const insN = this.db.prepare("INSERT INTO analysis_neighbors (analysis_id, point_id, neighbor_id, distance, neighbor_k_distance, reachability, neighbor_lrd, lrd_ratio) VALUES (?,?,?,?,?,?,?,?)");
      for (const p of result.points) {
        insP.run(analysisId, p.id, p.kDistance, p.neighborhoodSize, p.lrd, p.lof);
        for (const nb of p.neighbors) {
          insN.run(analysisId, p.id, nb.id, nb.distance, nb.kDistance, nb.reachability, nb.lrd, nb.lrdRatio);
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { analysisId, versionId: ver.id, reused: false };
  }

  getAnalysis(analysisId: string): { id: string; version_id: string; k: number; status: string; distance_metric: string; error: string | null } {
    const row = this.db.prepare("SELECT * FROM analyses WHERE id = ?").get(analysisId) as any;
    if (!row) throw new LofError("NOT_FOUND", `分析不存在: ${analysisId}`);
    return row;
  }

  /** 分数排序：LOF 降序，并列按 ID 固定顺序。threshold 只影响标记，不改分数。 */
  getScores(analysisId: string, threshold?: number): unknown[] {
    this.getAnalysis(analysisId);
    const rows = this.db.prepare("SELECT point_id AS id, k_distance AS kDistance, neighborhood_size AS neighborhoodSize, lrd, lof FROM analysis_points WHERE analysis_id = ?").all(analysisId) as any[];
    rows.sort((a, b) => (b.lof - a.lof) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows.map((r, i) => ({
      rank: i + 1,
      ...r,
      flagged: threshold !== undefined ? r.lof >= threshold : undefined,
    }));
  }

  /** 单点解释：k-distance、邻域、每条可达距离、lrd、每项密度比、最终 LOF。支持分页，不少算邻居。 */
  explainPoint(analysisId: string, pointId: string, offset = 0, limit = 100): unknown {
    this.getAnalysis(analysisId);
    const p = this.db.prepare("SELECT point_id AS id, k_distance AS kDistance, neighborhood_size AS neighborhoodSize, lrd, lof FROM analysis_points WHERE analysis_id = ? AND point_id = ?").get(analysisId, pointId) as any;
    if (!p) throw new LofError("NOT_FOUND", `分析 ${analysisId} 中不存在点 ${pointId}`);
    const total = (this.db.prepare("SELECT COUNT(*) AS c FROM analysis_neighbors WHERE analysis_id = ? AND point_id = ?").get(analysisId, pointId) as any).c;
    const neighbors = this.db.prepare(`
      SELECT neighbor_id AS id, distance, neighbor_k_distance AS kDistance, reachability, neighbor_lrd AS lrd, lrd_ratio AS lrdRatio
      FROM analysis_neighbors WHERE analysis_id = ? AND point_id = ?
      ORDER BY neighbor_id LIMIT ? OFFSET ?`).all(analysisId, pointId, limit, offset);
    return { ...p, neighborTotal: total, neighborOffset: offset, neighborLimit: limit, neighbors };
  }

  /** 两层邻域来源：p 的邻域，以及每个邻点 o 自己的邻域（解释 o 的 k-distance / lrd 来源）。 */
  explainPointTwoHop(analysisId: string, pointId: string): unknown {
    const first = this.explainPoint(analysisId, pointId, 0, Number.MAX_SAFE_INTEGER) as any;
    const secondHop: Record<string, unknown> = {};
    for (const nb of first.neighbors) {
      secondHop[nb.id] = this.explainPoint(analysisId, nb.id, 0, Number.MAX_SAFE_INTEGER);
    }
    return { ...first, secondHop };
  }

  listAnalyses(datasetId: string): unknown[] {
    this.getDataset(datasetId);
    return this.db.prepare(`
      SELECT a.id, a.k, a.status, a.error, a.created_at AS createdAt, v.version_no AS versionNo
      FROM analyses a JOIN dataset_versions v ON v.id = a.version_id
      WHERE v.dataset_id = ? ORDER BY a.created_at`).all(datasetId);
  }

  /** 比较多个 k：对同一点集版本分别（幂等）分析并并排返回每点 LOF。 */
  compareKs(datasetId: string, ks: number[]): unknown {
    const ver = this.latestVersion(datasetId);
    const analyses = ks.map((k) => {
      const { analysisId } = this.analyze(datasetId, k, ver.id);
      const scores = this.getScores(analysisId) as any[];
      const byId: Record<string, number> = {};
      for (const s of scores) byId[s.id] = s.lof;
      return { k, analysisId, byId };
    });
    const ids = Object.keys(analyses[0].byId).sort();
    return {
      versionId: ver.id,
      ks,
      rows: ids.map((id) => {
        const row: Record<string, unknown> = { id };
        for (const a of analyses) row[`k=${a.k}`] = a.byId[id];
        return row;
      }),
      analysisIds: analyses.map((a) => ({ k: a.k, analysisId: a.analysisId })),
    };
  }

  exportAnalysis(analysisId: string, format: "json" | "csv"): string {
    const a = this.getAnalysis(analysisId);
    const scores = this.getScores(analysisId) as any[];
    if (format === "json") {
      return JSON.stringify({
        analysisId,
        k: a.k,
        distanceMetric: a.distance_metric,
        semantics: "LOF 分数仅表示本次样本与尺度下的局部稀疏程度，不是异常概率",
        scores,
      }, null, 2);
    }
    const header = "rank,id,lof,lrd,k_distance,neighborhood_size";
    const lines = scores.map((s) => `${s.rank},${csvEscape(s.id)},${s.lof},${s.lrd},${s.kDistance},${s.neighborhoodSize}`);
    return [header, ...lines].join("\n") + "\n";
  }
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
