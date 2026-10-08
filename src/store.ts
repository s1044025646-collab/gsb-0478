import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors.js';
import { calculateLof, type InputPoint, type LofReport, validateK, validatePoints } from './lof.js';

export interface DatasetMeta {
  id: string;
  name: string;
  xUnit: string | null;
  yUnit: string | null;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface DatasetSnapshot extends DatasetMeta {
  points: InputPoint[];
}

export interface CreateDatasetInput {
  name?: string;
  xUnit?: string;
  yUnit?: string;
  points: InputPoint[];
}

export interface AnalysisRow {
  id: number;
  datasetId: string;
  version: number;
  k: number;
  threshold: number | null;
  idempotencyKey: string | null;
  report: LofReport;
  createdAt: string;
}

interface DatasetRow {
  id: string;
  name: string;
  x_unit: string | null;
  y_unit: string | null;
  current_version: number;
  created_at: string;
  updated_at: string;
}

interface PointRow {
  id: string;
  x: number;
  y: number;
  ordinal: number;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS datasets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        x_unit TEXT,
        y_unit TEXT,
        current_version INTEGER NOT NULL CHECK (current_version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dataset_versions (
        dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version >= 1),
        created_at TEXT NOT NULL,
        PRIMARY KEY (dataset_id, version)
      );
      CREATE TABLE IF NOT EXISTS points (
        dataset_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        id TEXT NOT NULL,
        x REAL NOT NULL,
        y REAL NOT NULL,
        PRIMARY KEY (dataset_id, version, ordinal),
        UNIQUE (dataset_id, version, id),
        FOREIGN KEY (dataset_id, version) REFERENCES dataset_versions(dataset_id, version) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dataset_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        k INTEGER NOT NULL,
        threshold REAL,
        idempotency_key TEXT NOT NULL DEFAULT '',
        distance_metric TEXT NOT NULL,
        comparison_rule TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (dataset_id, version, k, threshold, idempotency_key),
        FOREIGN KEY (dataset_id, version) REFERENCES dataset_versions(dataset_id, version) ON DELETE CASCADE
      );
    `);
  }

  createDataset(input: CreateDatasetInput, datasetId = createId()): DatasetSnapshot {
    validatePoints(input.points);
    const now = new Date().toISOString();
    const name = input.name?.trim() || datasetId;
    const xUnit = emptyToNull(input.xUnit);
    const yUnit = emptyToNull(input.yUnit);
    const tx = this.db.exec.bind(this.db);
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare(`INSERT INTO datasets (id, name, x_unit, y_unit, current_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)`).run(datasetId, name, xUnit, yUnit, now, now);
      this.db.prepare('INSERT INTO dataset_versions (dataset_id, version, created_at) VALUES (?, 1, ?)').run(datasetId, now);
      this.insertPoints(datasetId, 1, input.points);
      tx('COMMIT');
    } catch (error) {
      tx('ROLLBACK');
      throw mapSqliteError(error);
    }
    return this.getSnapshot(datasetId, 1);
  }

  replacePoints(datasetId: string, points: InputPoint[]): DatasetSnapshot {
    validatePoints(points);
    const existing = this.requireDatasetRow(datasetId);
    const nextVersion = existing.current_version + 1;
    const now = new Date().toISOString();
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.db.prepare('INSERT INTO dataset_versions (dataset_id, version, created_at) VALUES (?, ?, ?)').run(datasetId, nextVersion, now);
      this.insertPoints(datasetId, nextVersion, points);
      this.db.prepare('UPDATE datasets SET current_version = ?, updated_at = ? WHERE id = ?').run(nextVersion, now, datasetId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw mapSqliteError(error);
    }
    return this.getSnapshot(datasetId, nextVersion);
  }

  private insertPoints(datasetId: string, version: number, points: readonly InputPoint[]): void {
    const statement = this.db.prepare('INSERT INTO points (dataset_id, version, ordinal, id, x, y) VALUES (?, ?, ?, ?, ?, ?)');
    points.forEach((point, ordinal) => statement.run(datasetId, version, ordinal, point.id, point.x, point.y));
  }

  listDatasets(): DatasetMeta[] {
    return (this.db.prepare('SELECT * FROM datasets ORDER BY created_at, id').all() as unknown as DatasetRow[])
      .map(rowToMeta);
  }

  getSnapshot(datasetId: string, version?: number): DatasetSnapshot {
    const dataset = this.requireDatasetRow(datasetId);
    const selectedVersion = version ?? dataset.current_version;
    const versionExists = this.db.prepare('SELECT 1 FROM dataset_versions WHERE dataset_id = ? AND version = ?')
      .get(datasetId, selectedVersion);
    if (!versionExists) {
      throw new AppError('NOT_FOUND', `数据集 ${datasetId} 不存在版本 ${selectedVersion}。`);
    }
    const points = this.db.prepare('SELECT id, x, y, ordinal FROM points WHERE dataset_id = ? AND version = ? ORDER BY ordinal')
      .all(datasetId, selectedVersion) as unknown as PointRow[];
    return { ...rowToMeta(dataset), currentVersion: selectedVersion, points: points.map(({ id, x, y }) => ({ id, x, y })) };
  }

  analyze(datasetId: string, k: number, threshold: number | undefined, idempotencyKey?: string): AnalysisRow {
    const snapshot = this.getSnapshot(datasetId);
    validateK(k, snapshot.points.length);
    const key = emptyToNull(idempotencyKey) ?? '';
    const thresholdValue = threshold ?? null;
    const existingStatement = this.db.prepare(`SELECT * FROM analyses
      WHERE dataset_id = ? AND version = ? AND k = ? AND threshold IS ? AND idempotency_key IS ?`);
    const existing = existingStatement.get(datasetId, snapshot.currentVersion, k, thresholdValue, key) as AnalysisRecord | undefined;
    if (existing) {
      return rowToAnalysis(existing);
    }

    const report = calculateLof(snapshot.points, threshold === undefined ? { k } : { k, threshold });
    const now = new Date().toISOString();
    try {
      const result = this.db.prepare(`INSERT INTO analyses
        (dataset_id, version, k, threshold, idempotency_key, distance_metric, comparison_rule, report_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          datasetId,
          snapshot.currentVersion,
          k,
          thresholdValue,
          key,
          report.distanceMetric,
          report.comparisonRule,
          JSON.stringify(report),
          now,
        );
      return this.getAnalysis(Number(result.lastInsertRowid));
    } catch (error) {
      const concurrent = this.db.prepare(`SELECT * FROM analyses
        WHERE dataset_id = ? AND version = ? AND k = ? AND threshold IS ? AND idempotency_key IS ?`)
        .get(datasetId, snapshot.currentVersion, k, thresholdValue, key) as AnalysisRecord | undefined;
      if (concurrent) return rowToAnalysis(concurrent);
      throw new AppError('ATOMIC_PUBLISH_FAILED', '分析结果原子发布失败。', error);
    }
  }

  getAnalysis(id: number): AnalysisRow {
    const row = this.db.prepare('SELECT * FROM analyses WHERE id = ?').get(id) as AnalysisRecord | undefined;
    if (!row) throw new AppError('NOT_FOUND', `分析结果 ${id} 不存在。`);
    return rowToAnalysis(row);
  }

  listAnalyses(datasetId: string): Array<Omit<AnalysisRow, 'report'>> {
    this.requireDatasetRow(datasetId);
    const rows = this.db.prepare('SELECT * FROM analyses WHERE dataset_id = ? ORDER BY id').all(datasetId) as unknown as AnalysisRecord[];
    return rows.map((row) => ({ ...rowToAnalysis(row) }));
  }

  compare(datasetId: string, ks: number[]): Array<{ k: number; analysisId: number; lofById: Record<string, number> }> {
    const uniqueK = [...new Set(ks)].sort((a, b) => a - b);
    return uniqueK.map((k) => {
      const analysis = this.analyze(datasetId, k, undefined, undefined);
      const lofById = Object.fromEntries(analysis.report.points.map((point) => [point.id, point.lof]));
      return { k, analysisId: analysis.id, lofById };
    });
  }

  private requireDatasetRow(datasetId: string): DatasetRow {
    const row = this.db.prepare('SELECT * FROM datasets WHERE id = ?').get(datasetId) as DatasetRow | undefined;
    if (!row) throw new AppError('NOT_FOUND', `数据集 ${datasetId} 不存在。`);
    return row;
  }
}

interface AnalysisRecord {
  id: number;
  dataset_id: string;
  version: number;
  k: number;
  threshold: number | null;
  idempotency_key: string | null;
  distance_metric: string;
  comparison_rule: string;
  report_json: string;
  created_at: string;
}

function rowToAnalysis(row: AnalysisRecord): AnalysisRow {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    version: row.version,
    k: row.k,
    threshold: row.threshold,
    idempotencyKey: row.idempotency_key,
    report: JSON.parse(row.report_json) as LofReport,
    createdAt: row.created_at,
  };
}

function rowToMeta(row: DatasetRow): DatasetMeta {
  return {
    id: row.id,
    name: row.name,
    xUnit: row.x_unit,
    yUnit: row.y_unit,
    currentVersion: row.current_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function mapSqliteError(error: unknown): unknown {
  if (error instanceof Error && error.message.includes('UNIQUE constraint failed: datasets.id')) {
    return new AppError('CONFLICT', '数据集 ID 已存在。');
  }
  return error;
}

export function createId(): string {
  return `ds_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
