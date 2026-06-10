#!/usr/bin/env bash
# ============================================================
# scripts/selfcheck.sh
# 埋点网关一键自检：启网关 → 健康检查 → curl 上报 → 查表验证 → 自动清理
# ----------------------------------------------------------------
# 用法：
#   bash scripts/selfcheck.sh              # 启新网关跑完整自检
#   REUSE=1 bash scripts/selfcheck.sh      # 复用已启动的网关（不会启停）
#   KEEP=1  bash scripts/selfcheck.sh      # 自检结束后保留网关进程不退出
#
# 退出码：
#   0  全部通过
#   非 0 任一步骤失败
# ============================================================
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
LOG_FILE="/tmp/telemetry-selfcheck-$(date +%Y%m%d-%H%M%S).log"
PID_FILE="/tmp/telemetry-selfcheck.pid"

REUSE="${REUSE:-0}"
KEEP="${KEEP:-0}"

# ---------- 工具函数 ----------
c_red()   { printf "\033[31m%s\033[0m\n" "$*"; }
c_grn()   { printf "\033[32m%s\033[0m\n" "$*"; }
c_ylw()   { printf "\033[33m%s\033[0m\n" "$*"; }
c_cyn()   { printf "\033[36m%s\033[0m\n" "$*"; }
step()    { echo; c_cyn "▶ $*"; }
pass()    { c_grn "  ✅ $*"; }
fail()    { c_red "  ❌ $*"; }
warn()    { c_ylw "  ⚠ $*"; }

PID_TO_KILL=""
cleanup() {
    local code=$?
    if [[ "$KEEP" != "1" && "$REUSE" != "1" ]]; then
        if [[ -n "$PID_TO_KILL" ]] && kill -0 "$PID_TO_KILL" 2>/dev/null; then
            echo
            c_ylw "🧹 清理：停止网关进程 PID=$PID_TO_KILL"
            kill "$PID_TO_KILL" 2>/dev/null || true
            sleep 1
            kill -9 "$PID_TO_KILL" 2>/dev/null || true
        fi
        # 端口兜底：若仍有进程占着 PORT（脱离 PID 的子进程），统一清理
        if [[ -n "${PORT:-}" ]]; then
            local stale
            stale=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)
            if [[ -n "$stale" ]]; then
                c_ylw "🧹 端口兜底清理：kill -9 $stale"
                echo "$stale" | xargs -r kill -9 2>/dev/null || true
            fi
        fi
        rm -f "$PID_FILE" 2>/dev/null || true
    fi
    exit $code
}
trap cleanup EXIT INT TERM

# ---------- 0. 加载 .env ----------
step "加载环境变量"
if [[ ! -f "$ENV_FILE" ]]; then
    fail "未找到 $ENV_FILE，先 cp .env.example .env"
    exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8080}"
BASE="http://${HOST}:${PORT}"
# 取 TELEMETRY_TOKENS 的第一个 token 作为自检用 token
SELF_TOKEN="$(echo "${TELEMETRY_TOKENS:-}" | awk -F',' '{print $1}' | tr -d ' ')"
if [[ -z "$SELF_TOKEN" ]]; then
    fail "TELEMETRY_TOKENS 为空，无法鉴权"
    exit 1
fi
pass "ENV ok: BASE=$BASE token=${SELF_TOKEN:0:8}**** db=${MYSQL_DATABASE}@${MYSQL_HOST}:${MYSQL_PORT}"

# ---------- 1. MySQL 连通性 ----------
step "MySQL 连通性检查"
node -e "
const mysql=require('mysql2/promise');
(async()=>{
  try {
    const c=await mysql.createConnection({
      host: process.env.MYSQL_HOST, port: +process.env.MYSQL_PORT,
      user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
    });
    await c.ping();
    await c.end();
  } catch(e){ console.error(e.message); process.exit(1); }
})();
" >>"$LOG_FILE" 2>&1
if [[ $? -eq 0 ]]; then
    pass "MySQL 可连接"
else
    fail "MySQL 连接失败，详见 $LOG_FILE"
    exit 1
fi

# ---------- 2. 启动网关（或复用） ----------
step "启动埋点网关"
if [[ "$REUSE" == "1" ]]; then
    warn "REUSE=1，跳过启动，直接探活已有进程"
else
    # 端口占用预检
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
        fail "端口 $PORT 已被占用，先停掉占用进程或使用 REUSE=1"
        lsof -nP -iTCP:"$PORT" -sTCP:LISTEN || true
        exit 1
    fi
    # 后台启动，stdout/stderr 落日志；不用子 shell 保证 $! 是 node 真实 PID
    pushd "$ROOT_DIR" >/dev/null
    node src/server.js >>"$LOG_FILE" 2>&1 &
    PID_TO_KILL=$!
    popd >/dev/null
    echo "$PID_TO_KILL" >"$PID_FILE"
    sleep 0.3
    if [[ -z "$PID_TO_KILL" ]] || ! kill -0 "$PID_TO_KILL" 2>/dev/null; then
        fail "启动失败，日志：$LOG_FILE"
        tail -n 30 "$LOG_FILE" 2>/dev/null || true
        exit 1
    fi
    pass "已启动 PID=$PID_TO_KILL  日志=$LOG_FILE"
fi

# ---------- 3. 轮询 /healthz ----------
step "等待 /healthz 就绪"
HEALTH_OK=0
for i in $(seq 1 20); do
    if curl -fsS --max-time 2 "$BASE/healthz" >/dev/null 2>&1; then
        HEALTH_OK=1
        pass "/healthz 通过（耗时约 ${i}00ms）"
        break
    fi
    sleep 0.3
done
if [[ "$HEALTH_OK" != "1" ]]; then
    fail "/healthz 未就绪，详见 $LOG_FILE"
    tail -n 30 "$LOG_FILE" || true
    exit 1
fi

# /readyz（连 MySQL 探针）
if curl -fsS --max-time 3 "$BASE/readyz" >/dev/null 2>&1; then
    pass "/readyz 通过（DB 就绪）"
else
    warn "/readyz 失败（不影响后续，但 DB 探针异常）"
fi

# ---------- 4. 上报一个唯一事件 ----------
step "curl 上报一个 selfcheck.ping 事件"
TRACE_ID="sc-$(date +%s)-$$"
EVT_NAME="selfcheck.ping"
PAYLOAD=$(cat <<JSON
{
  "sessionId": "selfcheck-session",
  "common": {
    "extName": "selfcheck",
    "extVersion": "0.0.0",
    "vscodeVersion": "selfcheck",
    "platform": "$(uname | tr '[:upper:]' '[:lower:]')",
    "machineId": "selfcheck-machine"
  },
  "events": [
    {
      "name": "$EVT_NAME",
      "level": "info",
      "props": { "traceId": "$TRACE_ID", "from": "selfcheck.sh" },
      "measures": { "value": 1 },
      "ts": $(date +%s)000
    }
  ]
}
JSON
)
HTTP_RESP=$(curl -sS -o /tmp/sc-resp.json -w "%{http_code}" --max-time 5 \
    -H "Content-Type: application/json" \
    -H "X-Telemetry-Token: $SELF_TOKEN" \
    -X POST "$BASE/api/v1/track" \
    --data "$PAYLOAD" || echo "000")
if [[ "$HTTP_RESP" == "200" ]]; then
    pass "上报 200，响应：$(cat /tmp/sc-resp.json)"
else
    fail "上报 HTTP=$HTTP_RESP 响应：$(cat /tmp/sc-resp.json 2>/dev/null || true)"
    tail -n 30 "$LOG_FILE" || true
    exit 1
fi

# 401 鉴权用例（顺手验证）
HTTP_401=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 \
    -H "Content-Type: application/json" \
    -H "X-Telemetry-Token: bad-token-xxx" \
    -X POST "$BASE/api/v1/track" \
    --data "$PAYLOAD" || echo "000")
if [[ "$HTTP_401" == "401" || "$HTTP_401" == "403" ]]; then
    pass "鉴权拦截 ok（错误 token 返回 $HTTP_401）"
else
    warn "鉴权拦截异常：错误 token 返回 $HTTP_401（期望 401/403）"
fi

# ---------- 5. 查表验证 ----------
step "查 events 表，按 traceId 精确定位"
# 给写入异步 buffer 一点时间（虽然当前是同步 insert，但保险起见）
sleep 0.5
# 强制走 node + mysql2，避免依赖系统 mysql CLI
ROW_OUTPUT=$(EVT_NAME="$EVT_NAME" TRACE_ID="$TRACE_ID" node -e "
const mysql=require('mysql2/promise');
(async()=>{
  const c=await mysql.createConnection({
    host: process.env.MYSQL_HOST, port: +process.env.MYSQL_PORT,
    user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  });
  const [rows]=await c.query(
    \"SELECT id, event_name, level, JSON_UNQUOTE(JSON_EXTRACT(props,'\$.traceId')) AS trace, created_at FROM events WHERE event_name=? AND JSON_UNQUOTE(JSON_EXTRACT(props,'\$.traceId'))=? ORDER BY id DESC LIMIT 1\",
    [process.env.EVT_NAME, process.env.TRACE_ID]
  );
  await c.end();
  if (!rows.length) { process.exit(2); }
  const r=rows[0];
  console.log([r.id,r.event_name,r.level,r.trace,r.created_at].join('\t'));
})().catch(e=>{ console.error(e.message); process.exit(1); });
" 2>>"$LOG_FILE")

if [[ -n "$ROW_OUTPUT" ]]; then
    pass "查到事件: $ROW_OUTPUT"
else
    fail "未在 events 表中查到 traceId=$TRACE_ID 的记录（可能写入异步未刷盘？）"
    tail -n 30 "$LOG_FILE" || true
    exit 1
fi

# ---------- 6. 汇总 ----------
echo
c_grn "================================================================"
c_grn " 🎉 自检全部通过"
c_grn "    base       : $BASE"
c_grn "    traceId    : $TRACE_ID"
c_grn "    log        : $LOG_FILE"
if [[ "$KEEP" == "1" ]]; then
    c_grn "    网关 PID   : $PID_TO_KILL（KEEP=1 已保留，手动 kill）"
    PID_TO_KILL=""   # 让 trap 不再杀
fi
c_grn "================================================================"
