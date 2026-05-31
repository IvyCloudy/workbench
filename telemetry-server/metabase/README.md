# Metabase 本地数据看板

> 给 `workbench_telemetry.events` 表配的零成本可视化方案。10 分钟从启动到看图。

---

## 🚀 快速开始（3 步）

### 1. 启动容器

```bash
cd telemetry-server/metabase
docker compose up -d
```

首次启动需要拉镜像 + 初始化（约 1 分钟），可用以下命令观察：

```bash
docker compose logs -f metabase
# 看到 "Metabase Initialization COMPLETE" 即就绪
```

### 2. 打开浏览器

访问 <http://localhost:3001>，按引导完成：

- 第 1 步：创建管理员账号（邮箱+密码自定，本地用即可）
- 第 2 步：选"我稍后添加数据"或直接配置数据源（见下文）

### 3. 添加 MySQL 数据源

在 Metabase 设置里 → 「数据库」→「添加数据库」：

| 字段 | 值 |
|---|---|
| 数据库类型 | **MySQL** |
| 显示名 | `埋点数据` |
| Host | **macOS / Windows**：`host.docker.internal`<br>**Linux**：`172.17.0.1` 或宿主机 IP |
| Port | `3306` |
| 数据库名 | `workbench_telemetry` |
| 用户名 | 你 `.env` 里的 `MYSQL_USER` |
| 密码 | 你 `.env` 里的 `MYSQL_PASSWORD` |

点「保存」即可。Metabase 会自动扫描 `events` 表的字段。

---

## 📊 推荐做的 5 个看板

进入 Metabase 后，点击「+ 新建」→「问题」→「原生查询」，把 [`../scripts/analytics.sql`](../scripts/analytics.sql) 里的 SQL 一段段粘进来，保存为问题。然后建一个 Dashboard 把它们拼起来：

| 顺序 | 看板名 | 用 analytics.sql 的哪段 | 推荐图表类型 |
|---|---|---|---|
| 1 | 今日整体活跃 | @block 1 | 数字卡片（big number）|
| 2 | Top 事件 TOP10 | @block 2 | 横向条形图 |
| 3 | 24h 趋势 | @block 3 | 折线图 |
| 4 | 7 天 DAU | @block 4 | 折线图 |
| 5 | 异常事件占比 | @block 8 | 堆叠面积图 |

**小技巧**：在 Metabase 里建好"问题"后，可以加 Filter 变量（如 `{{day_range}}`），让面板支持时间筛选。

---

## 🧰 常用运维

```bash
# 查看状态
docker compose ps

# 查看日志
docker compose logs -f metabase

# 重启
docker compose restart

# 停止（保留数据，下次开机后看板还在）
docker compose down

# 完全清理（连 Metabase 元数据/账号一起删，慎用）
docker compose down -v
```

---

## ❓ FAQ

**Q1: 容器内连不上宿主机的 MySQL，报 `Communications link failure`？**

- macOS / Windows：用 `host.docker.internal`（compose 里已经配好了 extra_hosts）
- Linux：可能是 MySQL 只监听 `127.0.0.1`。改 `bind-address = 0.0.0.0` 后重启 MySQL，或者用 `--network=host`

**Q2: 想换端口（3001 被占）？**

改 [`docker-compose.yml`](./docker-compose.yml) 里的 `ports: "3001:3000"` 左边那个数字。

**Q3: 不想要 Docker，能直接 jar 启动吗？**

能。下载 [metabase.jar](https://www.metabase.com/start/oss/jar)，`java -jar metabase.jar` 即可。但需要本地有 JDK 11+。

**Q4: 想要更高级的产品分析（漏斗 / 留存）？**

Metabase 没有内置漏斗组件，但 [`analytics.sql`](../scripts/analytics.sql) 的 @block 10 提供了留存 SQL 模板。漏斗可参考 [Metabase 官方 Funnel 文档](https://www.metabase.com/docs/latest/questions/sharing/visualizations/funnel)。

---

## 🔒 安全提示

- 默认监听在 `0.0.0.0:3001`，**不要在生产/公网环境直接暴露**
- 本地用没问题；如果要给团队访问，建议加 nginx 反向代理 + Basic Auth
- Metabase 自身也支持 SSO/LDAP，需要进 `Admin → Authentication` 配置

---

## 📘 常用 SQL 速查

进入 Metabase 后，第一件事推荐打开 👉 [analytics-cookbook.md](./analytics-cookbook.md)

里面收录了 6 条**针对 `events` 真实表结构**编写、复制即跑的核心 SQL：

1. 每日事件量 / UV 趋势（折线）
2. Top 事件类型排行（条形）
3. 小时活跃热力图（Heatmap）
4. 活跃用户 Top 20（表格）
5. 次日留存率（组合图，CTE 写法）
6. 版本分布（饼图）

并附带字段速览、Metabase 操作步骤、排错速查与进阶建议（参数化 / JSON 下钻 / 数据归档）。
