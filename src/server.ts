/** 纯 node:http 实现的 REST API，无外部运行时依赖。 */
import * as http from "node:http";
import { LofError } from "./lof";
import { Store } from "./store";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": typeof body === "string" && body.startsWith("rank,") ? "text/csv; charset=utf-8" : "application/json; charset=utf-8" });
  res.end(text);
}

function sendError(res: http.ServerResponse, e: unknown): void {
  if (e instanceof LofError) {
    const status = e.code === "NOT_FOUND" ? 404 : e.code === "NUMERIC_OVERFLOW" ? 422 : 400;
    send(res, status, { error: { code: e.code, message: e.message } });
  } else {
    send(res, 500, { error: { code: "INTERNAL", message: String(e) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new LofError("INVALID_INPUT", "请求体必须是合法 JSON");
  }
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const body = method === "POST" || method === "PUT" ? await readBody(req) : {};

      // POST /datasets { name?, unitX?, unitY?, points }
      if (method === "POST" && parts.length === 1 && parts[0] === "datasets") {
        const r = store.createDataset(body.name ?? "dataset", body.unitX, body.unitY, body.points);
        return send(res, 201, r);
      }
      // GET /datasets
      if (method === "GET" && parts.length === 1 && parts[0] === "datasets") {
        return send(res, 200, store.listDatasets());
      }
      if (parts[0] === "datasets" && parts.length >= 2) {
        const dsId = parts[1];
        // GET /datasets/:id  -> 最新版本与点
        if (method === "GET" && parts.length === 2) {
          const ds = store.getDataset(dsId);
          const ver = store.latestVersion(dsId);
          return send(res, 200, { ...ds, versionId: ver.id, versionNo: ver.version_no, points: store.getPoints(ver.id) });
        }
        // POST /datasets/:id/points { add?: [], remove?: [] } -> 新版本
        if (method === "POST" && parts.length === 3 && parts[2] === "points") {
          return send(res, 201, store.mutatePoints(dsId, body.add ?? [], body.remove ?? []));
        }
        // POST /datasets/:id/validate { points } -> 仅校验
        if (method === "POST" && parts.length === 3 && parts[2] === "validate") {
          const { validatePoints } = require("./lof") as typeof import("./lof");
          validatePoints(body.points);
          return send(res, 200, { ok: true, pointCount: body.points.length });
        }
        // POST /datasets/:id/analyses { k } -> 幂等
        if (method === "POST" && parts.length === 3 && parts[2] === "analyses") {
          return send(res, 201, store.analyze(dsId, body.k));
        }
        // GET /datasets/:id/analyses
        if (method === "GET" && parts.length === 3 && parts[2] === "analyses") {
          return send(res, 200, store.listAnalyses(dsId));
        }
        // POST /datasets/:id/compare { ks: [1,2,3] }
        if (method === "POST" && parts.length === 3 && parts[2] === "compare") {
          if (!Array.isArray(body.ks) || body.ks.length === 0) throw new LofError("INVALID_INPUT", "ks 必须是非空数组");
          return send(res, 200, store.compareKs(dsId, body.ks));
        }
      }
      if (parts[0] === "analyses" && parts.length >= 2) {
        const aId = parts[1];
        // GET /analyses/:id?threshold=1.5
        if (method === "GET" && parts.length === 2) {
          const a = store.getAnalysis(aId);
          const threshold = url.searchParams.has("threshold") ? Number(url.searchParams.get("threshold")) : undefined;
          if (threshold !== undefined && !Number.isFinite(threshold)) throw new LofError("INVALID_INPUT", "threshold 必须是有限数");
          return send(res, 200, { ...a, threshold, scores: store.getScores(aId, threshold) });
        }
        // GET /analyses/:id/points/:pid?offset=&limit=&twoHop=1
        if (method === "GET" && parts.length === 4 && parts[2] === "points") {
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const limit = Number(url.searchParams.get("limit") ?? 100);
          if (url.searchParams.get("twoHop") === "1") {
            return send(res, 200, store.explainPointTwoHop(aId, parts[3]));
          }
          return send(res, 200, store.explainPoint(aId, parts[3], offset, limit));
        }
        // GET /analyses/:id/export?format=json|csv
        if (method === "GET" && parts.length === 3 && parts[2] === "export") {
          const format = url.searchParams.get("format") === "csv" ? "csv" : "json";
          return send(res, 200, store.exportAnalysis(aId, format));
        }
      }
      send(res, 404, { error: { code: "NOT_FOUND", message: `未匹配路由: ${method} ${url.pathname}` } });
    } catch (e) {
      sendError(res, e);
    }
  });
}

/** 启动服务；port=0（默认）时自动选择空闲端口。 */
export function startServer(store: Store, port = 0, host = "127.0.0.1"): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer(store);
    server.listen(port, host, () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}
