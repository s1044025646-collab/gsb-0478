import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLof, validatePoints, LofError, Point } from "../src/lof";

function lofById(r: ReturnType<typeof computeLof>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of r.points) out[p.id] = p.lof;
  return out;
}

test("手算例 1：(0,0),(1,0),(3,0), k=1 -> LOF = 1,1,2", () => {
  const r = computeLof(
    [
      { id: "A", x: 0, y: 0 },
      { id: "B", x: 1, y: 0 },
      { id: "C", x: 3, y: 0 },
    ],
    1
  );
  const lof = lofById(r);
  assert.ok(Math.abs(lof.A - 1) < 1e-12);
  assert.ok(Math.abs(lof.B - 1) < 1e-12);
  assert.ok(Math.abs(lof.C - 2) < 1e-12);
  // 每层数值核对：C 的 k-distance=2，邻域只有 B；reach(C,B)=max(kdist(B)=1, 2)=2；lrd(C)=1/2
  const c = r.points.find((p) => p.id === "C")!;
  assert.equal(c.kDistance, 2);
  assert.equal(c.neighborhoodSize, 1);
  assert.equal(c.neighbors[0].id, "B");
  assert.equal(c.neighbors[0].kDistance, 1);
  assert.equal(c.neighbors[0].reachability, 2);
  assert.ok(Math.abs(c.lrd - 0.5) < 1e-12);
  // B 的 lrd = 1/max(kdist(A)=1, 1) = 1 -> 比值 1/0.5 = 2
  assert.ok(Math.abs(c.neighbors[0].lrdRatio - 2) < 1e-12);
});

test("手算例 2：(0,0),(1,0),(2,0), k=1 中点并列最近邻全部纳入，三者 LOF=1", () => {
  const r = computeLof(
    [
      { id: "A", x: 0, y: 0 },
      { id: "B", x: 1, y: 0 },
      { id: "C", x: 2, y: 0 },
    ],
    1
  );
  const b = r.points.find((p) => p.id === "B")!;
  assert.equal(b.neighborhoodSize, 2); // 并列，不能只截取前 k 项
  const lof = lofById(r);
  for (const id of ["A", "B", "C"]) assert.ok(Math.abs(lof[id] - 1) < 1e-12, `${id} 应为 1`);
});

test("正方形等距点：k=1 时所有点 LOF=1，邻域并列纳入", () => {
  const r = computeLof(
    [
      { id: "p1", x: 0, y: 0 },
      { id: "p2", x: 1, y: 0 },
      { id: "p3", x: 0, y: 1 },
      { id: "p4", x: 1, y: 1 },
    ],
    1
  );
  for (const p of r.points) {
    assert.equal(p.neighborhoodSize, 2); // 每点有两个距离为 1 的并列最近邻
    assert.ok(Math.abs(p.lof - 1) < 1e-12);
  }
});

test("k = n-1 可运行", () => {
  const pts: Point[] = [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 1, y: 0 },
    { id: "c", x: 0, y: 1 },
    { id: "d", x: 5, y: 5 },
  ];
  const r = computeLof(pts, 3);
  assert.equal(r.points.length, 4);
  for (const p of r.points) assert.equal(p.neighborhoodSize, 3);
});

test("拒绝坐标完全相同的两个点", () => {
  assert.throws(
    () =>
      validatePoints([
        { id: "a", x: 1, y: 1 },
        { id: "b", x: 1, y: 1 },
        { id: "c", x: 2, y: 2 },
      ]),
    (e: unknown) => e instanceof LofError && e.code === "DUPLICATE_COORDINATES"
  );
});

test("校验：点数范围、非有限坐标、重复 id、非法 k", () => {
  assert.throws(() => validatePoints([{ id: "a", x: 0, y: 0 }, { id: "b", x: 1, y: 1 }]), /点数/);
  assert.throws(
    () => validatePoints([{ id: "a", x: NaN, y: 0 }, { id: "b", x: 1, y: 1 }, { id: "c", x: 2, y: 2 }]),
    (e: unknown) => (e as LofError).code === "NON_FINITE_COORDINATE"
  );
  assert.throws(
    () => validatePoints([{ id: "a", x: 0, y: 0 }, { id: "a", x: 1, y: 1 }, { id: "c", x: 2, y: 2 }]),
    (e: unknown) => (e as LofError).code === "DUPLICATE_POINT_ID"
  );
  const pts = [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 1, y: 0 },
    { id: "c", x: 2, y: 0 },
  ];
  assert.throws(() => computeLof(pts, 0), (e: unknown) => (e as LofError).code === "INVALID_K");
  assert.throws(() => computeLof(pts, 3), (e: unknown) => (e as LofError).code === "INVALID_K");
  assert.throws(() => computeLof(pts, 1.5), (e: unknown) => (e as LofError).code === "INVALID_K");
});

test("输入重排不改变每点 LOF", () => {
  const pts: Point[] = [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 1, y: 0 },
    { id: "c", x: 0, y: 1 },
    { id: "d", x: 10, y: 10 },
    { id: "e", x: 10.5, y: 10 },
  ];
  const shuffled = [pts[3], pts[0], pts[4], pts[1], pts[2]];
  const r1 = lofById(computeLof(pts, 2));
  const r2 = lofById(computeLof(shuffled, 2));
  for (const id of Object.keys(r1)) assert.ok(Math.abs(r1[id] - r2[id]) < 1e-12);
});

test("刚性平移与旋转不改变 LOF", () => {
  const pts: Point[] = [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 1, y: 0 },
    { id: "c", x: 0, y: 2 },
    { id: "d", x: 8, y: 8 },
    { id: "e", x: 8.5, y: 8 },
  ];
  const theta = Math.PI / 3;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const moved = pts.map((p) => ({
    id: p.id,
    x: 100 + cos * p.x - sin * p.y,
    y: -50 + sin * p.x + cos * p.y,
  }));
  const r1 = lofById(computeLof(pts, 2));
  const r2 = lofById(computeLof(moved, 2));
  for (const id of Object.keys(r1)) assert.ok(Math.abs(r1[id] - r2[id]) < 1e-9, id);
});

test("整体正比例缩放：密度反向缩放但 LOF 不变", () => {
  const pts: Point[] = [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 1, y: 0 },
    { id: "c", x: 0, y: 2 },
    { id: "d", x: 8, y: 8 },
    { id: "e", x: 8.5, y: 8 },
  ];
  const s = 7;
  const scaled = pts.map((p) => ({ id: p.id, x: p.x * s, y: p.y * s }));
  const r1 = computeLof(pts, 2);
  const r2 = computeLof(scaled, 2);
  for (const p of r1.points) {
    const q = r2.points.find((z) => z.id === p.id)!;
    assert.ok(Math.abs(q.lrd - p.lrd / s) < 1e-12, `lrd 应按 1/s 缩放`);
    assert.ok(Math.abs(q.lof - p.lof) < 1e-9, `LOF 应不变`);
  }
});

test("单独缩放一个轴可改变结果（不自动标准化）", () => {
  const pts: Point[] = [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 1, y: 0 },
    { id: "c", x: 0, y: 2 },
    { id: "d", x: 8, y: 8 },
    { id: "e", x: 8.5, y: 8 },
  ];
  const stretched = pts.map((p) => ({ id: p.id, x: p.x, y: p.y * 100 }));
  const r1 = lofById(computeLof(pts, 2));
  const r2 = lofById(computeLof(stretched, 2));
  const changed = Object.keys(r1).some((id) => Math.abs(r1[id] - r2[id]) > 1e-6);
  assert.ok(changed, "单轴缩放应改变至少一个 LOF");
});

test("独立距离矩阵核对：五点手算 k=2", () => {
  // 独立实现：直接由距离矩阵手工推每层，与引擎对照。
  const pts: Point[] = [
    { id: "a", x: 0, y: 0 },
    { id: "b", x: 3, y: 0 },
    { id: "c", x: 0, y: 4 },
    { id: "d", x: 3, y: 4 },
    { id: "e", x: 100, y: 100 },
  ];
  const k = 2;
  const n = pts.length;
  const dist = pts.map((p) => pts.map((q) => Math.hypot(p.x - q.x, p.y - q.y)));
  const kd: number[] = [];
  const N: number[][] = [];
  for (let i = 0; i < n; i++) {
    const ds = dist[i].map((d, j) => ({ d, j })).filter((o) => o.j !== i).sort((x, y) => x.d - y.d);
    const kdv = ds[k - 1].d;
    kd.push(kdv);
    N.push(ds.filter((o) => o.d <= kdv).map((o) => o.j));
  }
  const lrd = N.map((nb, i) => nb.length / nb.reduce((s, j) => s + Math.max(kd[j], dist[i][j]), 0));
  const expected = N.map((nb, i) => nb.reduce((s, j) => s + lrd[j] / lrd[i], 0) / nb.length);
  const r = computeLof(pts, k);
  for (let i = 0; i < n; i++) {
    const p = r.points.find((z) => z.id === pts[i].id)!;
    assert.ok(Math.abs(p.kDistance - kd[i]) < 1e-12);
    assert.equal(p.neighborhoodSize, N[i].length);
    assert.ok(Math.abs(p.lrd - lrd[i]) < 1e-12);
    assert.ok(Math.abs(p.lof - expected[i]) < 1e-12);
  }
});
