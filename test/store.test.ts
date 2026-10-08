import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store";

const PTS = [
  { id: "A", x: 0, y: 0 },
  { id: "B", x: 1, y: 0 },
  { id: "C", x: 3, y: 0 },
];

test("分析幂等：重复请求返回同一 analysisId", () => {
  const s = new Store(":memory:");
  const { datasetId } = s.createDataset("t", "m", "m", PTS);
  const a1 = s.analyze(datasetId, 1);
  const a2 = s.analyze(datasetId, 1);
  assert.equal(a1.analysisId, a2.analysisId);
  assert.equal(a2.reused, true);
  s.close();
});

test("增删点生成新版本，旧分析冻结不变", () => {
  const s = new Store(":memory:");
  const { datasetId } = s.createDataset("t", "m", "m", PTS);
  const a1 = s.analyze(datasetId, 1);
  const m = s.mutatePoints(datasetId, [{ id: "D", x: 3.5, y: 0 }], []);
  assert.equal(m.versionNo, 2);
  const a2 = s.analyze(datasetId, 1);
  assert.notEqual(a1.analysisId, a2.analysisId);
  // 旧分析仍可逐点解释且数值不变
  const c = s.explainPoint(a1.analysisId, "C") as any;
  assert.equal(c.lof, 2);
  s.close();
});

test("分数排序：LOF 降序，threshold 只标记不改分", () => {
  const s = new Store(":memory:");
  const { datasetId } = s.createDataset("t", "m", "m", PTS);
  const { analysisId } = s.analyze(datasetId, 1);
  const scores = s.getScores(analysisId, 1.5) as any[];
  assert.equal(scores[0].id, "C");
  assert.equal(scores[0].flagged, true);
  assert.equal(scores[1].flagged, false);
  s.close();
});

test("解释分页不少算邻居", () => {
  const s = new Store(":memory:");
  const pts = [
    { id: "c", x: 0, y: 0 },
    ...Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, x: Math.cos(i) * 2, y: Math.sin(i) * 2 })),
  ];
  const { datasetId } = s.createDataset("t", "m", "m", pts);
  const { analysisId } = s.analyze(datasetId, 10);
  const full = s.explainPoint(analysisId, "c", 0, 100) as any;
  const p1 = s.explainPoint(analysisId, "c", 0, 4) as any;
  const p2 = s.explainPoint(analysisId, "c", 4, 4) as any;
  const p3 = s.explainPoint(analysisId, "c", 8, 4) as any;
  const merged = [...p1.neighbors, ...p2.neighbors, ...p3.neighbors];
  assert.equal(full.neighborTotal, 10);
  assert.deepEqual(merged.map((x: any) => x.id), full.neighbors.map((x: any) => x.id));
  s.close();
});

test("两层邻域来源可查询", () => {
  const s = new Store(":memory:");
  const { datasetId } = s.createDataset("t", "m", "m", PTS);
  const { analysisId } = s.analyze(datasetId, 1);
  const two = s.explainPointTwoHop(analysisId, "C") as any;
  assert.ok(two.secondHop.B);
  assert.equal(two.secondHop.B.kDistance, 1);
  s.close();
});

test("比较不同 k 与导出", () => {
  const s = new Store(":memory:");
  const { datasetId } = s.createDataset("t", "m", "m", PTS);
  const cmp = s.compareKs(datasetId, [1, 2]) as any;
  assert.equal(cmp.rows.length, 3);
  assert.ok("k=1" in cmp.rows[0] && "k=2" in cmp.rows[0]);
  const { analysisId } = s.analyze(datasetId, 1);
  const csv = s.exportAnalysis(analysisId, "csv");
  assert.ok(csv.startsWith("rank,id,lof"));
  const json = JSON.parse(s.exportAnalysis(analysisId, "json"));
  assert.equal(json.k, 1);
  s.close();
});
