import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, errorResponse } from './errors.js';
import { explanationsToCsv, getPoint, reportToCsv, reportToJson } from './exporters.js';
import { Store } from './store.js';

const projectRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dataDir = process.env.LOF_DATA_DIR ?? resolve(projectRoot, 'data');
const store = new Store(resolve(dataDir, 'lof.sqlite'));

export function createApp(): Server {
  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const rendered = errorResponse(error);
      sendJson(response, rendered.status, rendered.body);
    });
  });
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const pathParts = url.pathname.replace(/^\/|\/$/g, '').split('/').filter(Boolean);
  const method = request.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { ok: true, service: 'local-2d-lof', dataDir });
    return;
  }

  if (pathParts[0] === 'datasets') {
    if (method === 'POST' && pathParts.length === 1) {
      const body = await readJson(request);
      const dataset = store.createDataset(body);
      sendJson(response, 201, dataset);
      return;
    }
    if (method === 'GET' && pathParts.length === 1) {
      sendJson(response, 200, { datasets: store.listDatasets() });
      return;
    }
    const datasetId = pathParts[1];
    if (!datasetId) throw new AppError('NOT_FOUND', '路由不存在。');

    if (method === 'GET' && pathParts.length === 2) {
      sendJson(response, 200, store.getSnapshot(datasetId, optionalInteger(url.searchParams.get('version'))));
      return;
    }
    if (method === 'PUT' && pathParts.length === 3 && pathParts[2] === 'points') {
      const body = await readJson(request);
      sendJson(response, 200, store.replacePoints(datasetId, body.points));
      return;
    }
    if (method === 'POST' && pathParts.length === 3 && pathParts[2] === 'analyses') {
      const body = await readJson(request);
      const threshold = body.threshold === undefined ? undefined : Number(body.threshold);
      const analysis = store.analyze(datasetId, Number(body.k), threshold, body.idempotencyKey);
      sendJson(response, 201, analysis);
      return;
    }
    if (method === 'GET' && pathParts.length === 3 && pathParts[2] === 'analyses') {
      sendJson(response, 200, { analyses: store.listAnalyses(datasetId) });
      return;
    }
    if (method === 'POST' && pathParts.length === 3 && pathParts[2] === 'compare') {
      const body = await readJson(request);
      if (!Array.isArray(body.ks) || body.ks.length === 0) {
        throw new AppError('VALIDATION_ERROR', 'compare 请求必须包含非空 ks 数组。');
      }
      sendJson(response, 200, { datasetId, comparisons: store.compare(datasetId, body.ks.map(Number)) });
      return;
    }
  }

  if (pathParts[0] === 'analyses') {
    const analysisId = Number(pathParts[1]);
    if (!Number.isInteger(analysisId)) throw new AppError('NOT_FOUND', '分析 ID 必须是整数。');
    const analysis = store.getAnalysis(analysisId);

    if (method === 'GET' && pathParts.length === 2) {
      sendJson(response, 200, analysis);
      return;
    }
    if (method === 'GET' && pathParts.length === 3 && pathParts[2] === 'export') {
      const format = url.searchParams.get('format') ?? 'json';
      if (format === 'csv') return sendText(response, 200, reportToCsv(analysis.report), 'text/csv; charset=utf-8');
      if (format !== 'json') throw new AppError('VALIDATION_ERROR', '导出格式只支持 json 或 csv。');
      return sendText(response, 200, reportToJson(analysis.report), 'application/json; charset=utf-8');
    }
    if (method === 'GET' && pathParts.length === 5 && pathParts[2] === 'points' && pathParts[4] === 'edge') {
      const source = getPoint(analysis.report, decodeURIComponent(pathParts[3]!));
      const neighborId = url.searchParams.get('neighborId');
      if (!neighborId) throw new AppError('VALIDATION_ERROR', '必须提供 neighborId 查询参数。');
      const edge = source.neighbors.find((candidate) => candidate.id === neighborId);
      if (!edge) throw new AppError('NOT_FOUND', `边 ${source.id} -> ${neighborId} 未进入邻域。`);
      sendJson(response, 200, {
        sourceId: source.id,
        sourceSquaredKDistance: source.squaredKDistance,
        sourceKDistance: source.kDistance,
        actualNeighborhoodSize: source.actualNeighborhoodSize,
        ...edge,
        verification: {
          rule: 'squaredDistance <= sourceSquaredKDistance',
          accepted: true,
        },
      });
      return;
    }
    if (method === 'GET' && pathParts.length === 4 && pathParts[2] === 'points') {
      const point = getPoint(analysis.report, decodeURIComponent(pathParts[3]!));
      sendJson(response, 200, point);
      return;
    }
    if (method === 'GET' && pathParts.length === 4 && pathParts[2] === 'two-level' && pathParts[3] === 'csv') {
      return sendText(response, 200, explanationsToCsv(analysis.report), 'text/csv; charset=utf-8');
    }
  }

  throw new AppError('NOT_FOUND', '路由不存在。');
}

function optionalInteger(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new AppError('VALIDATION_ERROR', 'version 必须是整数。');
  return parsed;
}

async function readJson(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new AppError('VALIDATION_ERROR', '请求体必须是合法 JSON。');
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  sendText(response, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

function sendText(response: ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, { 'content-type': contentType });
  response.end(body);
}

async function findFreePort(preferred?: number): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(preferred ?? 0, '127.0.0.1', () => {
      const address = probe.address();
      if (address && typeof address === 'object') {
        const port = address.port;
        probe.close(() => resolvePort(port));
      } else {
        probe.close(() => reject(new AppError('VALIDATION_ERROR', '无法取得空闲端口。')));
      }
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const configured = process.env.PORT ? Number(process.env.PORT) : undefined;
  findFreePort(configured).then((port) => {
    createApp().listen(port, '127.0.0.1', () => {
      console.log(`LOF API: http://127.0.0.1:${port}`);
      console.log(`SQLite: ${resolve(dataDir, 'lof.sqlite')}`);
    });
  }).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
