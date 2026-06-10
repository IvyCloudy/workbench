# Workbench Telemetry Server

Workbench VSCode 插件埋点接收网关（极简自建版）。

## 能力一览

| 能力 | 实现 |
|---|---|
| 接收 | `POST /api/v1/track`，批量上报，单批最多 100 条 |
| 鉴权 | Header `X-Telemetry-Token`（支持多 Token，便于灰度切换）|
| 限流 | 单 IP 600 次/分钟（可调）|
| 落盘 | MySQL，自动建表，单表+索引，按需分区/分表 |
| 健康检查 | `GET /healthz`（存活）/ `GET /readyz`（就绪，探测 MySQL）|
| 查询 | `node scripts/query.js --event=push.success --from=2026-05-30` |
| 日报 | `node scripts/stats-daily.js 2026-05-30`：DAU、Top 事件、错误率 |
| 清理 | `node scripts/cleanup.js --keep-days=90` |
| 自检 | `bash scripts/selfcheck.sh`：启网关 → 上报 → 查表 → 自动收尾 |
| 部署 | Dockerfile + K8s 清单（Deployment/Service/Secret/ConfigMap/CronJob）|

## 接口约定

### `POST /api/v1/track`

请求头：

```
Content-Type: application/json
X-Telemetry-Token: <在 .env / Secret 里配置的 Token>
```

请求体：

```json
{
  "sessionId": "abc123",
  "common": {
    "extName": "workbench",
    "extVersion": "1.2.3",
    "vscodeVersion": "1.95.0",
    "platform": "darwin",
    "machineId": "vscode-machine-id"
  },
  "events": [
    {
      "name": "push.success",
      "level": "info",
      "props": { "rowCount": 100 },
      "measures": { "durationMs": 320 },
      "ts": 1717110000000
    }
  ]
}
```

返回：

```json
{ "ok": true, "accepted": 1, "dropped": 0 }
```

错误码：

| 状态码 | 含义 |
|---|---|
| 400 | 请求体非法 / events 为空 / 全部事件非法 |
| 401 | Token 缺失或不匹配 |
| 413 | 单批超过 `MAX_BATCH_SIZE` |
| 429 | 触发限流，含 `Retry-After` 头 |
| 500 | 写库失败，客户端可重试 |

## 本地开发

```bash
cp .env.example .env
# 修改 .env 中的 MySQL / TELEMETRY_TOKENS

npm install
node scripts/migrate.js   # 首次建表
npm run dev               # 启动开发模式
```

冒烟测试：

```bash
curl -i http://127.0.0.1:8080/healthz

curl -i -X POST http://127.0.0.1:8080/api/v1/track \
  -H 'Content-Type: application/json' \
  -H 'X-Telemetry-Token: please-change-me-to-a-long-random-string' \
  -d '{
    "sessionId":"local-1",
    "common":{"extName":"workbench","extVersion":"1.0.0","platform":"darwin","machineId":"m-local"},
    "events":[{"name":"smoke.test","level":"info","props":{"foo":"bar"},"ts":1717110000000}]
  }'
```

### 一键自检脚本

[scripts/selfcheck.sh](./scripts/selfcheck.sh) 串起完整链路：**加载 .env → MySQL ping → 启网关 → `/healthz` + `/readyz` → 200 上报 + 401 鉴权拦截 → 按唯一 traceId 查表 → 自动收尾**。每次都会生成形如 `sc-<时间戳>-<pid>` 的 traceId 写入 `props.traceId`，查表时精确定位，多次自检互不干扰。

```bash
# 1. 标准自检：临时启网关，跑完即停（CI / 提交前最常用）
bash scripts/selfcheck.sh

# 2. 保留模式：跑完不停，方便后续手工调试
KEEP=1 bash scripts/selfcheck.sh
# 自己手动停： lsof -nP -iTCP:8080 -sTCP:LISTEN -t | xargs kill

# 3. 复用模式：另一个终端已经在跑 `npm run dev`，本脚本只跑 curl + 查表
REUSE=1 bash scripts/selfcheck.sh
```

输出示例：

```
▶ 加载环境变量
  ✅ ENV ok: BASE=http://127.0.0.1:8080 token=wb-telem**** db=workbench_telemetry@127.0.0.1:3306
▶ MySQL 连通性检查        ✅ MySQL 可连接
▶ 启动埋点网关             ✅ 已启动 PID=40006  日志=/tmp/telemetry-selfcheck-*.log
▶ 等待 /healthz 就绪       ✅ /healthz 通过      ✅ /readyz 通过（DB 就绪）
▶ curl 上报 selfcheck.ping ✅ 上报 200 {"ok":true,"accepted":1,"dropped":0}
                          ✅ 鉴权拦截 ok（错误 token 返回 401）
▶ 查 events 表             ✅ 查到事件: 3 selfcheck.ping info sc-1780230482-39974 ...
🎉 自检全部通过
```

退出码：`0` 全通过；非 `0` 任一步骤失败，并打印最近 30 行网关日志（`/tmp/telemetry-selfcheck-*.log`）便于排查。脚本不依赖系统 `mysql` CLI，直接复用项目自带 `mysql2`。

## 容器部署

### 1. 构建镜像

```bash
docker build -t your-registry/workbench-telemetry-server:1.0.0 .
docker push your-registry/workbench-telemetry-server:1.0.0
```

### 2. 准备 MySQL

在公司 MySQL 上执行：

```sql
CREATE DATABASE workbench_telemetry DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'telemetry'@'%' IDENTIFIED BY 'a-long-random-password';
GRANT ALL PRIVILEGES ON workbench_telemetry.* TO 'telemetry'@'%';
FLUSH PRIVILEGES;
```

### 3. 部署到 K8s

```bash
# 修改 deploy/k8s.yaml 中的 image / Secret 后
kubectl apply -f deploy/k8s.yaml

# 或先单独跑一次迁移（也可由首次启动自动建表）
kubectl run telemetry-migrate --rm -it --restart=Never \
  --image=your-registry/workbench-telemetry-server:1.0.0 \
  --env-from=configmap/workbench-telemetry-config \
  --env-from=secret/workbench-telemetry-secret \
  -- node scripts/migrate.js
```

### 4. 客户端接入

VSCode 插件侧已在 [src/services/telemetry.ts](../src/services/telemetry.ts) 实现批量上报、退避、脱敏，
仅需在用户配置中追加：

```jsonc
{
    "workbench.telemetryUrl": "https://telemetry.your-company.com",
    "workbench.telemetryToken": "<同 K8s Secret 中的 TELEMETRY_TOKENS>"
}
```

> 客户端在请求时自动加上 `X-Telemetry-Token` 头并访问 `<telemetryUrl>/api/v1/track`。

## 运维操作

```bash
# 查询某事件最近 100 条
node scripts/query.js --event=push.success --from=2026-05-30 --limit=100

# 查询某机器最近事件
node scripts/query.js --machine=<machineId> --limit=20

# 跑昨日日报
node scripts/stats-daily.js

# 清理 90 天前数据（建议在 CronJob 中执行）
node scripts/cleanup.js --keep-days=90 --batch=10000
```

## 数据分析

提供两条由浅入深的路径，按需取用：

### 1. SQL 分析手册（零安装，今晚就能用）

[scripts/analytics.sql](./scripts/analytics.sql) 内置 8 段开箱即用的分析 SQL，覆盖最常用的指标维度：

| # | 分析主题 | 用途 |
|---|---|---|
| 1 | 今日事件总量 + 同比昨日 | 一眼判断整体活跃度是否异常 |
| 2 | 最近 7 天 Top 10 事件 | 看用户最常做什么 |
| 3 | 24 小时事件趋势（按小时） | 找波峰波谷 / 活跃时段 |
| 4 | 7 天 DAU（按机器去重） | 看用户增长 |
| 5 | 扩展版本分布 | 看升级渗透率 |
| 6 | 平台 / 系统分布 | 看用户群画像 |
| 7 | props 字段 TOP 值 | 业务自定义维度分析（如某命令的参数分布）|
| 8 | 异常事件（error/warn）占比 | 看健康度 |

外加 2 段进阶模板（默认注释）：单用户事件流追踪、次日留存。

> **使用方式**：DBeaver 连上本地 MySQL（库名 `workbench_telemetry`），打开该文件，选中任意一段按 `Cmd/Ctrl + Enter` 即可执行。

### 2. Metabase 可视化看板（10 分钟，docker compose 一键起）

[metabase/](./metabase/) 目录下提供了 docker-compose 文件和详细接入文档，启动后访问 <http://localhost:3001>，把 [analytics.sql](./scripts/analytics.sql) 里的 SQL 一段段粘到 Metabase 的「原生查询」中，就能拼出一个完整的埋点 Dashboard。

```bash
cd metabase
docker compose up -d
# 浏览器打开 http://localhost:3001
```

数据源连接参数、推荐看板列表、常见问题排查见 [metabase/README.md](./metabase/README.md)。

> **零数据迁移**：Metabase 直连本地 MySQL `events` 表，不复制不搬运。

#### 📘 核心 SQL 速查手册

在 Metabase 里搭看板时，强烈建议配合 [metabase/analytics-cookbook.md](./metabase/analytics-cookbook.md) 一起用：

- 6 条核心 SQL（趋势 / Top 事件 / 热力图 / 活跃用户 / 次日留存 / 版本分布），复制即跑
- 每条 SQL 都标注了推荐图表类型与可视化配置要点
- 附带 `events` 表字段速览、Metabase 操作步骤、常见报错对照表
- 进阶技巧：时间范围参数化、JSON 字段下钻、错误事件告警

## 演进路线

- 阶段1（当前）：单进程 + MySQL + 内存限流
- 阶段2：多副本 → 限流切 Redis；高峰期接入消息队列（Kafka）做削峰
- 阶段3：流量上来后，MySQL `events` 表按月分区或迁移到 ClickHouse
- 阶段4：接入公司统一 APM / 日志中心后逐步替换或并行运行
