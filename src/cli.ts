/**
 * CLI：建点集、校验、分析、解释、比较 k、导出、启动服务、演示。
 * 用法：node dist/src/cli.js <command> [args]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "./store";
import { startServer } from "./server";
import { validatePoints } from "./lof";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = process.env.LOF_DB ?? path.join(DATA_DIR, "lof.sqlite");

function readPointsFile(file: string): any {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(raw) ? raw : raw.points;
}

function print(x: unknown): void {
  process.stdout.write((typeof x === "string" ? x : JSON.stringify(x, null, 2)) + "\n");
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const store = new Store(DB_PATH);
  try {
    switch (cmd) {
      case "create": {
        // create <points.json> [name] [unitX] [unitY]
        const points = readPointsFile(args[0]);
        print(store.createDataset(args[1] ?? path.basename(args[0]), args[2] ?? "unit", args[3] ?? "unit", points));
        break;
      }
      case "mutate": {
        // mutate <datasetId> [add.json] [removeIds 逗号分隔]
        const add = args[1] ? readPointsFile(args[1]) : [];
        const remove = args[2] ? args[2].split(",").filter(Boolean) : [];
        print(store.mutatePoints(args[0], add, remove));
        break;
      }
      case "validate": {
        const points = readPointsFile(args[0]);
        validatePoints(points);
        print({ ok: true, pointCount: points.length });
        break;
      }
      case "analyze": {
        // analyze <datasetId> <k>
        print(store.analyze(args[0], Number(args[1])));
        break;
      }
      case "scores": {
        // scores <analysisId> [threshold]
        print(store.getScores(args[0], args[1] !== undefined ? Number(args[1]) : undefined));
        break;
      }
      case "explain": {
        // explain <analysisId> <pointId> [--two-hop] [offset] [limit]
        if (args.includes("--two-hop")) {
          print(store.explainPointTwoHop(args[0], args[1]));
        } else {
          print(store.explainPoint(args[0], args[1], Number(args[2] ?? 0), Number(args[3] ?? 100)));
        }
        break;
      }
      case "compare": {
        // compare <datasetId> 1,2,3
        const ks = args[1].split(",").map(Number);
        print(store.compareKs(args[0], ks));
        break;
      }
      case "export": {
        // export <analysisId> [json|csv] [outFile]
        const format = args[1] === "csv" ? "csv" : "json";
        const out = store.exportAnalysis(args[0], format);
        if (args[2]) {
          fs.writeFileSync(args[2], out, "utf8");
          print({ written: args[2] });
        } else {
          print(out);
        }
        break;
      }
      case "datasets":
        print(store.listDatasets());
        break;
      case "serve": {
        // serve [port]（默认 0 = 自动选择空闲端口）
        const port = Number(args[0] ?? process.env.PORT ?? 0);
        const { port: actual } = await startServer(store, port);
        print({ listening: `http://127.0.0.1:${actual}`, db: DB_PATH });
        return; // 保持进程
      }
      case "demo": {
        demo(store);
        break;
      }
      default:
        print(`用法: node dist/src/cli.js <command>
  create <points.json> [name] [unitX] [unitY]   建点集（版本 1）
  mutate <datasetId> [add.json] [removeIds]     增删点，生成新版本
  validate <points.json>                        仅校验点集
  analyze <datasetId> <k>                       运行分析（幂等）
  scores <analysisId> [threshold]               查看分数（threshold 只影响标记）
  explain <analysisId> <pointId> [--two-hop]    查看单点邻域来源解释
  compare <datasetId> 1,2,3                     比较不同 k
  export <analysisId> [json|csv] [outFile]      导出结果
  datasets                                      列出点集
  serve [port]                                  启动 API（默认自动选空闲端口）
  demo                                          内置演示`);
    }
  } finally {
    if (cmd !== "serve") store.close();
  }
}

function demo(store: Store): void {
  const { datasetId } = store.createDataset("demo-三点共线", "unit", "unit", [
    { id: "A", x: 0, y: 0 },
    { id: "B", x: 1, y: 0 },
    { id: "C", x: 3, y: 0 },
  ]);
  const { analysisId } = store.analyze(datasetId, 1);
  print("== (0,0),(1,0),(3,0), k=1：期望 LOF = 1, 1, 2 ==");
  print(store.getScores(analysisId));
  print("== 点 C 的解释 ==");
  print(store.explainPoint(analysisId, "C"));
  const d2 = store.createDataset("demo-并列最近邻", "unit", "unit", [
    { id: "A", x: 0, y: 0 },
    { id: "B", x: 1, y: 0 },
    { id: "C", x: 2, y: 0 },
  ]);
  const a2 = store.analyze(d2.datasetId, 1);
  print("== (0,0),(1,0),(2,0), k=1：中点邻域含 2 个并列最近邻，三者 LOF 均为 1 ==");
  print(store.getScores(a2.analysisId));
}

main().catch((e) => {
  const code = (e as any).code ?? "INTERNAL";
  process.stderr.write(JSON.stringify({ error: { code, message: (e as Error).message } }) + "\n");
  process.exit(1);
});
