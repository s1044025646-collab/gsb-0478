# 二维 LOF 局部离群分数后端（API + CLI）

离线、本地运行的二维 LOF（Local Outlier Factor，局部离群因子）分析服务。
输入带唯一编号的平面点与邻居参数 k，为每个点计算 LOF 分数、邻域与密度来源，
并支持逐点解释、不同 k 对比与 JSON/CSV 导出。只做 API 与 CLI，无前端。

**分数语义**：LOF 只表示**本次样本与尺度下的局部稀疏程度**，不是异常概率，
系统不宣称统计显著性或误报率保证。不做聚类、不拟合高斯混合、不训练分类器，
也不会自动删除任何点。

## 运行环境

- Windows 本地，Node.js ≥ 22（使用内置 `node:sqlite`，无需 Docker / WSL / 外部服务）
- 仅开发依赖 TypeScript，运行时零第三方依赖

## 快速开始

```powershell
npm install        # 安装 TypeScript 等开发依赖
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API（默认自动选择空闲端口并打印）
npm run demo       # 内置演示：两个手算小例
```

数据保存在项目内 `data/lof.sqlite`（可用环境变量 `LOF_DB` 覆盖，`:memory:` 表示纯内存）。
端口可用 `node dist/src/cli.js serve 8080` 或环境变量 `PORT` 指定；不传则自动选空闲端口。

## 计算口径（公开浮点口径）

- 距离为**原始坐标的欧氏距离**，不做轴标准化，输入顺序不影响结果。
- 距离排序与相等判定基于**平方距离的精确 Number 比较**，不使用模糊容差吞并相邻距离。
- `k-distance(p)`：排除自身后第 k 小的距离。
- **邻域 `Nk(p)`**：所有距离 `<= k-distance(p)` 的其他点。**距离并列时邻域可能多于 k 个，
  并列点全部纳入**，绝不只截取排序前 k 项；按编号排序仅为稳定展示。
- **可达距离** `reach(p,o) = max(k-distance(o), dist(p,o))`，下界来自**邻点 o** 自己的
  k-distance，而不是 p 的。
- **局部可达密度** `lrd(p) = |Nk(p)| / Σ reach(p,o)`。
- **LOF(p)** = 邻点 `lrd(o)/lrd(p)` 的平均，分母为**实际邻域大小**。
- 计算分两阶段：先得到全部点的 k-distance 与 lrd，再产生 LOF；不存在“邻点尚未处理
  就用零密度替代”的情况。
- 坐标完全相同（零距离退化）的点对被**拒绝**；不同 ID 的非重合点允许有相同邻距。
- 近点导致数值溢出（lrd 或 LOF 非有限）时整次分析以 `NUMERIC_OVERFLOW` 失败，
  不把无穷大当作正常分数。

## 尺度与变换性质

- 刚性平移/旋转不改变任何 LOF。
- 整体坐标乘同一正比例：lrd 反向缩放，LOF 不变。
- 单独缩放一个轴**可以**改变结果（因为不做自动标准化）——坐标单位需由使用者保证可比。

## 参数校验与错误码

| 错误码 | 含义 |
| --- | --- |
| `INVALID_POINT_COUNT` | 点数不在 3–500 |
| `INVALID_POINT_ID` / `DUPLICATE_POINT_ID` | id 缺失/非字符串/重复 |
| `NON_FINITE_COORDINATE` | 坐标非有限数 |
| `COORDINATE_OUT_OF_RANGE` | 坐标绝对值超过 1e150 |
| `DUPLICATE_COORDINATES` | 两个点坐标完全相同（拒绝） |
| `INVALID_K` | k 不是 1 到 n-1 的整数 |
| `NUMERIC_OVERFLOW` | 密度/分数计算溢出，分析失败 |
| `NOT_FOUND` | 点集/分析/点不存在 |
| `INVALID_INPUT` | 请求体或参数非法 |

## API

所有响应为 JSON，错误形如 `{ "error": { "code", "message" } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/datasets` | 建点集 `{name?, unitX?, unitY?, points:[{id,x,y}]}`，生成版本 1 |
| GET | `/datasets` / `/datasets/:id` | 列出点集 / 查看最新版本与点 |
| POST | `/datasets/:id/points` | `{add?:[], remove?:[id]}` 增删点，**生成新版本** |
| POST | `/datasets/:id/validate` | 仅校验 `{points}` |
| POST | `/datasets/:id/analyses` | `{k}` 运行分析，**幂等**：同版本同 k 返回同一分析 |
| GET | `/datasets/:id/analyses` | 列出该点集全部分析 |
| POST | `/datasets/:id/compare` | `{ks:[1,2,3]}` 并排比较不同 k 的每点 LOF |
| GET | `/analyses/:id?threshold=1.5` | 分数降序（并列按 ID）；threshold 只影响 `flagged` 标记 |
| GET | `/analyses/:id/points/:pid?offset=&limit=` | 单点解释（分页，不少算邻居） |
| GET | `/analyses/:id/points/:pid?twoHop=1` | 两层邻域来源：p 的邻域 + 每个邻点自己的邻域 |
| GET | `/analyses/:id/export?format=json\|csv` | 导出冻结结果 |

### 单点解释内容

k-distance、真实邻域大小、每个邻点的（距离、邻点自己的 k-distance、可达距离、
邻点 lrd、密度比），以及本点 lrd 与最终 LOF——即“某条边为何进入邻域”可完整追溯。

## CLI

```
node dist/src/cli.js create <points.json> [name] [unitX] [unitY]
node dist/src/cli.js mutate <datasetId> [add.json] [removeIds逗号分隔]
node dist/src/cli.js validate <points.json>
node dist/src/cli.js analyze <datasetId> <k>
node dist/src/cli.js scores <analysisId> [threshold]
node dist/src/cli.js explain <analysisId> <pointId> [--two-hop] [offset] [limit]
node dist/src/cli.js compare <datasetId> 1,2,3
node dist/src/cli.js export <analysisId> [json|csv] [outFile]
node dist/src/cli.js datasets
node dist/src/cli.js serve [port]
node dist/src/cli.js demo
```

点文件格式：`[{"id":"A","x":0,"y":0}, ...]` 或 `{"points":[...]}`，示例见 `examples/points.json`。

## 持久化与一致性

- SQLite 保存原点、轴单位、k、距离口径与**冻结的分析结果**。
- 增删点形成**新版本**；分析绑定版本，不会只更新被编辑点而沿用过期邻域。
- 重复分析请求幂等；一次报告在单事务内**原子发布**；重启后逐点解释保持一致。

## 测试

`npm test` 覆盖：两个手算小例（含并列最近邻）、正方形等距点、k=n-1、坐标重复拒绝、
输入重排、刚性平移旋转、整体缩放 LOF 不变、单轴缩放改变结果、独立距离矩阵核对、
幂等、版本冻结、分页完整性、两层邻域、比较与导出。

## 限制

- 朴素全对距离实现，O(n²) 内存与时间；n ≤ 500 足够，无空间树。
- 仅处理本地完整数值点；缺失/非数值输入直接拒绝。
- LOF 是相对比较，跨点集/跨尺度的分数不可直接比较。
