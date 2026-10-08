# 二维 LOF 局部离群分数与并列邻域核验后端

这是一个仅包含后端的 Windows 本地服务，用 TypeScript、Node.js 和 SQLite 实现。它对 3 到 500 个完整二维点计算本次样本和坐标尺度下的 LOF（Local Outlier Factor），并保存可复核的邻域、距离门槛、可达距离、局部可达密度和密度比。

LOF 不是异常概率，不附带统计显著性或误报率保证；阈值只用于展示标记和筛选，不改变正式 LOF。系统不聚类、不拟合高斯混合、不训练分类器，也不会自动删除点。

## 环境要求

- Windows、PowerShell
- Node.js 22.5 或更高版本（使用内置 `node:sqlite`）
- 不需要 Docker、WSL、付费服务或外部在线 API

## 安装与运行

```powershell
npm install
npm run build
npm test
npm start
```

默认监听 `127.0.0.1` 并自动选择空闲端口，启动日志会输出实际 URL。需要固定端口时：

```powershell
$env:PORT="3000"; npm start
```

SQLite 数据库默认位于项目内 `data/lof.sqlite`。也可以设置：

```powershell
$env:LOF_DATA_DIR="E:\my-lof-data"; npm start
```

## CLI

```powershell
npm run build
node dist/cli.js demo
node dist/cli.js analyze-file --input examples/points.json --k 1
node dist/cli.js analyze-file --input examples/points.json --k 1 --format csv --output data/result.csv
node dist/cli.js explain-file --input examples/points.json --k 1 --point p3
node dist/cli.js compare-k --input examples/points.json --ks 1,2
node dist/cli.js check-invariants --input examples/points.json
```

## HTTP API

创建点集：

```powershell
$body = @'
{"name":"line","xUnit":"m","yUnit":"m","points":[
  {"id":"p0","x":0,"y":0},
  {"id":"p1","x":1,"y":0},
  {"id":"p3","x":3,"y":0}
]}
'@
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:<端口>/datasets -ContentType 'application/json' -Body $body
```

常用接口：

- `GET /health`：健康检查
- `POST /datasets`：创建点集
- `GET /datasets`：列出点集
- `GET /datasets/{id}?version=1`：读取某个冻结版本
- `PUT /datasets/{id}/points`：用完整点集替换，生成新版本
- `POST /datasets/{id}/analyses`：请求分析，JSON 包含 `k`、可选 `threshold`、可选 `idempotencyKey`
- `GET /analyses/{id}`：读取冻结报告
- `GET /analyses/{id}/points/{pointId}`：读取单点完整邻域解释
- `GET /analyses/{id}/points/{sourceId}/edge?neighborId=p1`：核验一条边为何进入邻域
- `GET /analyses/{id}/export?format=json|csv`：导出
- `GET /analyses/{id}/two-level/csv`：导出每条邻域边的两层数值来源
- `POST /datasets/{id}/compare`：请求体 `{"ks":[1,2,3]}`，比较不同 k

重复提交相同 `idempotencyKey`、版本、`k` 和阈值会返回同一条冻结分析。增删点不会原地覆盖旧结果，而是产生新版本；旧分析仍按旧邻域解释。

## 数值口径

- 坐标必须是有限数，支持保存 x/y 轴单位，但计算不自动标准化。
- 使用原始坐标的欧氏距离；排序和相等判定基于 Float64 平方距离。
- 不使用较大的模糊容差吞并相邻距离；只有平方距离按 IEEE Float64 比较相等才视为并列。
- 拒绝两个坐标完全相同的点，因为零距离会造成退化。
- `k` 必须是 `1 <= k <= n-1` 的整数。
- 对每点 `p` 排除自身，第 `k` 小距离为 `k-distance(p)`。
- `Nk(p)` 包含所有“平方距离不大于第 `k` 小平方距离”的其他点；并列时实际邻域大小可以大于 `k`。
- 可达距离：`reach-dist(p,o)=max(k-distance(o), distance(p,o))`，下界来自邻点 `o`。
- `lrd(p)=|Nk(p)| / sum(reach-dist(p,o))`。
- `LOF(p)=平均(lrd(o)/lrd(p))`，平均分母是实际邻域大小。
- 分数按 LOF 降序；并列时按 ID 的固定字符串顺序排序。
- 平方距离、和、密度比或 LOF 溢出为非有限数时返回 `NUMERIC_OVERFLOW`，不会输出 Infinity 作为正常分数。

坐标上限为绝对值 `1e100`，用于在计算前明确范围并避免平方后进入 Infinity。整体两个轴同比例放大时距离和密度反向缩放，LOF 不变；只缩放一个轴会改变欧氏几何和 LOF。

## 手算例

点 `(0,0),(1,0),(3,0)`，`k=1`：

- `p0` 与 `p1` 互为最近邻，分数为 1。
- `p3` 的最近邻距离为 2，但其邻点 `p1` 的 k-distance 为 1，得到 LOF 2。

点 `(0,0),(1,0),(2,0)`，`k=1`：

- 中点到左右两点距离并列，尽管 k=1，邻域大小仍是 2。
- 三个点的 LOF 都是 1。

## 错误码

- `VALIDATION_ERROR`：请求结构、坐标或阈值不合法
- `INVALID_K`：k 不在 1 到 n-1
- `DUPLICATE_ID`：点 ID 重复
- `DUPLICATE_POINT`：坐标完全重合
- `NUMERIC_OVERFLOW`：中间值或最终值溢出
- `NOT_FOUND`：数据集、版本、分析或边不存在
- `CONFLICT`：资源冲突
- `ATOMIC_PUBLISH_FAILED`：数据库事务发布失败

## 限制

当前使用朴素全对距离，时间复杂度为 `O(n²)`，面向最多 500 个点；不使用空间树。服务只做本地后端，没有网页界面。结果只描述本次输入样本、k 和原始坐标尺度下的局部相对稀疏程度。
