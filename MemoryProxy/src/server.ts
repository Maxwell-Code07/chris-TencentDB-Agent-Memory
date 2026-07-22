/** Hono app factory — registers all routes. */

import { Hono } from "hono";
import { handleChatCompletions } from "./handler.js";
import { handleAnthropicMessages } from "./anthropicHandler.js";
import { handleAuxiliaryEndpoint } from "./auxiliaryHandler.js";
import { apiKeyToKeyId, extractBearerToken } from "./opik.js";
import { createSkillBridgeHandler } from "./skill/skill-bridge.js";
import { createMemoryBridgeHandler } from "./memory/memory-bridge.js";
import { createInstanceDestroyHandler } from "./routes/instance-destroy.js";
import { createRateLimitHandlers } from "./routes/rate-limits.js";
import { tryActivateStorage, tryActivateRedis } from "./injection/index.js";
import { getEffectiveBackend } from "./storage/factory.js";
import type { ProxyConfig } from "./types.js";

export function createApp(config: ProxyConfig): Hono {
  const app = new Hono();

  // Eagerly activate storage/bindingRepo so bridge-only requests (no main
  // /v1/messages hits yet) can still recover session state via L2 fallthrough
  // (memory-bridge.ts / skill-bridge.ts §6.1 fix). Idempotent; the injection
  // pipeline will still call these later when the first main request lands.
  if (!tryActivateStorage(config)) {
    tryActivateRedis(config);
  }

  // Health check
  //
  // 多节点场景：storage 请求 cos 但降级到进程内 (fs / memory / sqlite) 时
  // 返回 503 + degraded=true，让 k8s LB 把该 pod 摘掉，避免"两个节点各写各
  // 的内存"这种数据一致性事故。sqlite 也算 process-local——多节点各自本地
  // 文件也是不共享的。见 docs/design/2026-07-13-proxy-multinode-state-audit.md P0-2。
  app.get("/health", (c) => {
    const eff = getEffectiveBackend();
    const wantsShared = config.storage?.enabled && eff.requested === "cos";
    const degraded = wantsShared && eff.effective !== eff.requested;
    const body = {
      status: degraded ? "degraded" : "ok",
      version: "0.2.0",
      upstream: config.upstream.url,
      opik: config.opik.enabled ? config.opik.url : "disabled",
      costGuard: config.costGuard.enabled ? "enabled" : "disabled",
      rateLimit: config.rateLimit.tpm > 0 || config.rateLimit.qpm > 0 ? "enabled" : "disabled",
      storage: {
        enabled: !!config.storage?.enabled,
        requested: eff.requested,
        effective: eff.effective,
        degraded,
        ...(eff.error ? { lastError: eff.error } : {}),
      },
    };
    return c.json(body, degraded ? 503 : 200);
  });

  // Whoami: resolve API key → key ID (plain text, easy to use with curl)
  app.get("/whoami", (c) => {
    // Support: Authorization header (Bearer), x-api-key header, or ?key= query param
    const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
    const bearerToken = extractBearerToken(authHeader);
    const xApiKey = c.req.header("x-api-key") ?? "";
    const queryKey = c.req.query("key") ?? "";

    const apiKey = bearerToken || xApiKey || queryKey;

    if (!apiKey) {
      return c.text("Error: No API key provided. Use ?key=YOUR_KEY\n", 400);
    }

    const keyId = apiKeyToKeyId(apiKey);
    return c.text(keyId + "\n");
  });

// Skill bridge: LLM curls land here, proxy injects auth + identity, forwards to core.
  // MUST be registered before the agent-prefixed `/:agent/v1/*` routes below.
  const bridgeHandler = createSkillBridgeHandler(config);
  app.post("/skill-bridge/*", (c) => bridgeHandler(c));

  // Memory bridge: 同样模式但反代 tdai L0/L1/L2/L3 只读接口。
  // 让 LLM 用 Bash 调 <proxy>/memory-bridge/v3/atomic/search 等，proxy 注入身份。
  const memoryBridgeHandler = createMemoryBridgeHandler(config);
  app.post("/memory-bridge/*", (c) => memoryBridgeHandler(c));

  // ── Ops endpoint（在 catch-all `POST /*` 之前注册） ───────────────────────
  // /v3/instance/proxy-destroy — shark 销毁实例时清理 proxy 侧 COS 缓存 +
  // kernel-sts pool。契约字段跟 core `/v3/instance/destroy` 对齐，路径用
  // `proxy-destroy` 动作与 core 区分。鉴权走 config.admin.apiKey（空则公开）。
  const instanceDestroyHandler = createInstanceDestroyHandler(config);
  app.post("/v3/instance/proxy-destroy", (c) => instanceDestroyHandler(c));

  const rateLimitHandlers = createRateLimitHandlers(config);
  app.get("/v3/admin/rate-limits", rateLimitHandlers.get);
  app.put("/v3/admin/rate-limits", rateLimitHandlers.put);
  app.delete("/v3/admin/rate-limits", rateLimitHandlers.delete);

  // ── Whitelisted primary endpoints ────────────────────────────────────────
  // Anthropic Messages API
  app.post("/v1/messages", (c) => handleAnthropicMessages(c, config));

  // ── Whitelisted auxiliary endpoints (must precede catch-all) ─────────────
  // 这些端点走轻量透传 handler（不进入路由模块，不构成对话回合）。
  // 详见 docs/design/2026-07-02-arbitrary-path-passthrough-design.md
  app.post("/v1/messages/count_tokens", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));

  // Agent-prefixed routes with spaceId — 客户端标准配置格式：
  //   CC:  ANTHROPIC_BASE_URL=http://<proxy>:8096/claude-code/<spaceId>
  //   CB:  OPENAI_BASE_URL=http://<proxy>:8096/codebuddy/<spaceId>
  // 路径示例: /claude-code/mem-example001/v1/messages
  //          /codebuddy/mem-example001/v1/chat/completions
  app.post("/:agent/:spaceId/v1/messages", (c) => handleAnthropicMessages(c, config));
  app.post("/:agent/:spaceId/v1/messages/count_tokens", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/chat/completions", (c) => handleChatCompletions(c, config));

  // Agent-prefixed routes without spaceId (deprecated: no credit reporting)
  app.post("/:agent/v1/messages", (c) => handleAnthropicMessages(c, config));
  app.post("/:agent/v1/chat/completions", (c) => handleChatCompletions(c, config));

  // Legacy /proxy/<spaceId>/ prefix — no agent info, defaults to codebuddy.
  // 保留以兼容不带 agent 前缀的客户端。
  app.post("/proxy/:spaceId/v1/messages", (c) => handleAnthropicMessages(c, config));
  app.post("/proxy/:spaceId/v1/messages/count_tokens", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/*", (c) => handleChatCompletions(c, config));

  // OpenAI-compatible chat completions (catch-all for any remaining POST paths)
  app.post("/*", (c) => handleChatCompletions(c, config));

  return app;
}
