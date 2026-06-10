#!/usr/bin/env bash
# Metabase 一键启停脚本
# 用法: ./scripts/metabase.sh {start|stop|restart|status|logs}
#
# 设计要点：
# - 用本地 JDK 17（Tencent Kona）启动，不影响系统默认 JAVA_HOME
# - 只监听 127.0.0.1:3000，不暴露到局域网
# - jar 与 H2 元数据存放于 ~/Applications/metabase/，与本仓库解耦

set -euo pipefail

# ===== 配置 =====
JAVA_HOME_DIR="${MB_JAVA_HOME:-/Users/myronliu/Documents/jdk-17.0.17.jdk/Contents/Home}"
METABASE_DIR="${MB_HOME:-$HOME/Applications/metabase}"
JAR="$METABASE_DIR/metabase.jar"
DATA_DIR="$METABASE_DIR/data"
LOG_FILE="$METABASE_DIR/metabase.log"
PID_FILE="$METABASE_DIR/metabase.pid"
PORT="${MB_PORT:-3000}"
HOST="${MB_HOST:-127.0.0.1}"

# Metabase 元数据库（H2 文件，存放仪表盘/账号等配置）
export MB_DB_FILE="$DATA_DIR/metabase.db"
export MB_JETTY_HOST="$HOST"
export MB_JETTY_PORT="$PORT"
export MB_ANON_TRACKING_ENABLED=false

# ===== 颜色 =====
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

cmd=${1:-}

start() {
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo -e "${YELLOW}⚠️  Metabase 已在运行 (PID=$(cat "$PID_FILE"))${NC}"
    exit 0
  fi
  if lsof -i ":$PORT" >/dev/null 2>&1; then
    echo -e "${RED}❌ 端口 $PORT 已被占用，先释放再启动${NC}"
    lsof -i ":$PORT"
    exit 1
  fi
  if [[ ! -x "$JAVA_HOME_DIR/bin/java" ]]; then
    echo -e "${RED}❌ JDK 17 未找到: $JAVA_HOME_DIR${NC}"
    echo "    可通过 MB_JAVA_HOME=... 覆盖"
    exit 1
  fi
  if [[ ! -f "$JAR" ]]; then
    echo -e "${RED}❌ jar 不存在: $JAR${NC}"
    echo "    请先下载: curl -L -o $JAR https://downloads.metabase.com/v0.50.30/metabase.jar"
    exit 1
  fi

  mkdir -p "$DATA_DIR"
  echo -e "${GREEN}🚀 启动 Metabase ...${NC}"
  echo "    JDK   : $("$JAVA_HOME_DIR/bin/java" -version 2>&1 | head -1)"
  echo "    JAR   : $JAR"
  echo "    数据  : $DATA_DIR"
  echo "    地址  : http://$HOST:$PORT"
  echo "    日志  : $LOG_FILE"

  nohup "$JAVA_HOME_DIR/bin/java" \
    -Xmx2g \
    -jar "$JAR" \
    >"$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"

  echo -ne "    等待启动 "
  for i in {1..60}; do
    if curl -sf "http://$HOST:$PORT/api/health" >/dev/null 2>&1; then
      echo -e "\n${GREEN}✅ 启动完成！浏览器打开 http://$HOST:$PORT${NC}"
      return 0
    fi
    echo -n "."
    sleep 2
  done
  echo -e "\n${RED}❌ 启动超时（120s），查看日志：tail -f $LOG_FILE${NC}"
  exit 1
}

stop() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo -e "${YELLOW}⚠️  未找到 PID 文件，可能未运行${NC}"
    exit 0
  fi
  pid=$(cat "$PID_FILE")
  if kill -0 "$pid" 2>/dev/null; then
    echo -e "${YELLOW}🛑 停止 Metabase (PID=$pid) ...${NC}"
    kill "$pid"
    for i in {1..15}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
    echo -e "${GREEN}✅ 已停止${NC}"
  else
    echo -e "${YELLOW}⚠️  进程 $pid 已不存在${NC}"
  fi
  rm -f "$PID_FILE"
}

status() {
  if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo -e "${GREEN}● Metabase 运行中${NC} (PID=$(cat "$PID_FILE"))  →  http://$HOST:$PORT"
    if curl -sf "http://$HOST:$PORT/api/health" >/dev/null 2>&1; then
      echo -e "  ${GREEN}健康检查: OK${NC}"
    else
      echo -e "  ${YELLOW}健康检查: 未就绪（可能还在启动）${NC}"
    fi
  else
    echo -e "${RED}○ Metabase 未运行${NC}"
  fi
}

logs() {
  [[ -f "$LOG_FILE" ]] || { echo "暂无日志"; exit 0; }
  tail -f "$LOG_FILE"
}

case "$cmd" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; sleep 1; start ;;
  status)  status ;;
  logs)    logs ;;
  *)
    echo "用法: $0 {start|stop|restart|status|logs}"
    echo
    echo "可选环境变量："
    echo "  MB_JAVA_HOME  JDK 17 路径（默认 ~/Documents/jdk-17.0.17.jdk/Contents/Home）"
    echo "  MB_HOME       数据/jar 目录（默认 ~/Applications/metabase）"
    echo "  MB_PORT       监听端口（默认 3000）"
    echo "  MB_HOST       监听地址（默认 127.0.0.1）"
    exit 1
    ;;
esac
