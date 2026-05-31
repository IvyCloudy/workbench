#!/usr/bin/env bash
# ============================================================
# scripts/dev-local.sh
# 本地一键启动埋点网关：自动加载 .env 中的变量后运行 node 服务
# 用法：bash scripts/dev-local.sh
# ============================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "❌ 未找到 .env 文件：$ENV_FILE"
    echo "   请先复制 .env.example 为 .env 并填好 MySQL 连接信息"
    exit 1
fi

echo "📄 加载环境变量：$ENV_FILE"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

echo "🩺 健康检查 MySQL: ${MYSQL_HOST}:${MYSQL_PORT} db=${MYSQL_DATABASE} user=${MYSQL_USER}"
node -e "
const mysql=require('mysql2/promise');
(async()=>{
  try {
    const c=await mysql.createConnection({
      host: process.env.MYSQL_HOST,
      port: +process.env.MYSQL_PORT,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
    });
    await c.ping();
    await c.end();
    console.log('  ✅ MySQL 连接成功');
  } catch(e){
    console.error('  ❌ MySQL 连接失败：', e.message);
    process.exit(1);
  }
})();
"

echo "🚀 启动埋点网关：http://${HOST}:${PORT}"
echo "   健康检查：    curl http://${HOST}:${PORT}/healthz"
echo "   上报示例：    见 README.md"
echo "   按 Ctrl+C 停止"
echo "------------------------------------------------------------"
exec node "$ROOT_DIR/src/server.js"
