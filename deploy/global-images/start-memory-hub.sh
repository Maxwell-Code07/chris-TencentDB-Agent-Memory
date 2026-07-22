#!/usr/bin/env bash
# 单独拉起 memory-hub（panel + knowledge 合并镜像，端口 8125 + 8424）。
#
# 依赖：memory 需要先起来（memory-hub 里 knowledge 调 memory 做 embed/RAG）。
# 如果 memory 容器不存在，此脚本会打 warn 但仍继续（LLM_MODE=proxy 时 memory-hub
# 自身可以启动，只是 knowledge 首次调 memory 时会失败）。
#
# 用法：
#   ./start-memory-hub.sh
#
# 需要以下 LLM 参数（写在 .env）：
#   MEMORY_LLM_BASE_URL / MEMORY_LLM_API_KEY / MEMORY_LLM_MODEL

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

load_env
require_vars \
  MEMORY_HUB_IMAGE PANEL_PORT KNOWLEDGE_PORT PANEL_VOLUME \
  MEMORY_LLM_BASE_URL MEMORY_LLM_API_KEY MEMORY_LLM_MODEL \
  KNOWLEDGE_PUBLIC_BASE_URL

# 与 memory-core 保持一致的 gateway 内部凭据（默认 local，仅本地体验）
MEMORY_CORE_GATEWAY_API_KEY="${MEMORY_CORE_GATEWAY_API_KEY:-local}"

CONTAINER=tdai-memory-hub
NETWORK=tdai-memory-stack

if ! $DOCKER network inspect "$NETWORK" >/dev/null 2>&1; then
  info "创建 docker 网络 $NETWORK"
  $DOCKER network create "$NETWORK" >/dev/null
fi

# memory 未起来时给提醒，不阻塞
if ! $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "tdai-memory-core"; then
  warn "memory-core 容器未运行。memory-hub 能启动，但 knowledge 调 memory 时会失败。"
  warn "建议先 ./start-memory-core.sh 再来这里，或直接 ./start-all.sh"
fi

rm_container_if_exists "$CONTAINER"

# 内部 knowledge 通过 upstream memory 调 LLM 走 custom 模式，直接指向 MEMORY_LLM_*
# LLM_MODE=custom → 不走 memory 的 LLM proxy，而是 knowledge 直连用户提供的端点
info "启动 memory-hub (image=$MEMORY_HUB_IMAGE, panel=$PANEL_PORT knowledge=$KNOWLEDGE_PORT)"
$DOCKER run -d --name "$CONTAINER" \
  --network "$NETWORK" \
  --network-alias memory-hub \
  --add-host=host.docker.internal:host-gateway \
  -p "${PANEL_PORT}:8125" \
  -p "${KNOWLEDGE_PORT}:8424" \
  -v "${PANEL_VOLUME}:/data/knowledge" \
  -e PANEL_PORT=8125 \
  -e KNOWLEDGE_PORT=8424 \
  -e KNOWLEDGE_PUBLIC_BASE_URL="$KNOWLEDGE_PUBLIC_BASE_URL" \
  -e REMOTE_INSTANCE_ID=default \
  -e REMOTE_INSTANCE_NAME=default \
  -e REMOTE_INSTANCE_URL="http://memory-core:8420" \
  -e REMOTE_INSTANCE_KEY="$MEMORY_CORE_GATEWAY_API_KEY" \
  -e LLM_MODE=custom \
  -e LLM_PROTOCOL="${MEMORY_LLM_PROTOCOL:-openai}" \
  -e LLM_API_KEY="$MEMORY_LLM_API_KEY" \
  -e LLM_BASE_URL="$MEMORY_LLM_BASE_URL" \
  -e LLM_MODEL="$MEMORY_LLM_MODEL" \
  -e KNOWLEDGE_LLM_BINDING_SYNC=0 \
  "$MEMORY_HUB_IMAGE" >/dev/null

wait_healthy "$CONTAINER" 120
ok "memory-hub 已启动"
ok "  Panel UI  → http://localhost:${PANEL_PORT}/"
ok "  KS Health → http://localhost:${KNOWLEDGE_PORT}/health"
