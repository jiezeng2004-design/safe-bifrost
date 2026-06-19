#!/usr/bin/env node
/**
 * Safe-Bifrost MCP Server — HTTP (Streamable HTTP) transport
 *
 * Binds to 127.0.0.1 only. Never exposes to LAN or public internet.
 * Use with OpenAI tunnel-client or ChatGPT Connector.
 *
 * Each HTTP request gets its own MCP Server + transport instance
 * to avoid "Already connected" errors from reusing a single Server.
 *
 * Config options (in safe-bifrost.config.json):
 *   httpPort: number (default 7331)
 *
 * Run: node dist/httpServer.js
 *   or: npm run start:http
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./tools/registry.js";

// ── Bootstrap ─────────────────────────────────────────────────────

const config = loadConfig();
const port = parseInt(process.env.SAFE_BIFROST_HTTP_PORT || "") ||
  (config as any).httpPort ||
  7331;
const host = "127.0.0.1";

console.error(`[safe-bifrost-http] Workspace: ${config.workspaceRoot}`);
console.error(`[safe-bifrost-http] Listening:  http://${host}:${port}/mcp`);
console.error(`[safe-bifrost-http] ⚠️  Bound to 127.0.0.1 only — not exposed to network`);

// ── Owner token (optional) ────────────────────────────────────────

const httpCfg = (config as any).http || {};
const ownerTokenEnv = httpCfg.ownerTokenEnv || "SAFE_BIFROST_OWNER_TOKEN";
const ownerToken = process.env[ownerTokenEnv] || "";

if (ownerToken) {
  console.error(`[safe-bifrost-http] 🔒 Owner token required (env: ${ownerTokenEnv})`);
} else {
  console.error(`[safe-bifrost-http] ⚠️  No owner token set — all local requests accepted`);
}

function checkOwnerToken(req: IncomingMessage): boolean {
  if (!ownerToken) return true; // no token configured — allow all

  const authHeader = req.headers["authorization"] || "";
  const customHeader = req.headers["x-safe-bifrost-token"] || "";

  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7) === ownerToken;
  }

  if (typeof customHeader === "string" && customHeader.length > 0) {
    return customHeader === ownerToken;
  }

  return false;
}

// ── Helpers ───────────────────────────────────────────────────────

/** Create a fresh MCP Server with tools registered */
function createMcpServer(): Server {
  const server = new Server(
    { name: "safe-bifrost", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  registerTools(server);
  return server;
}

/** Handle one MCP request with its own server+transport lifecycle */
async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Fresh instances per request — no shared state, no "already connected" errors
  const mcpServer = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("[safe-bifrost-http] Request error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  } finally {
    // Always close to free resources
    try {
      await transport.close();
    } catch {
      // best effort
    }
    try {
      await mcpServer.close();
    } catch {
      // best effort
    }
  }
}

// ── HTTP server ───────────────────────────────────────────────────

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.url !== "/mcp" && req.url !== "/mcp/") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Safe-Bifrost MCP Server — use endpoint: /mcp\n");
    return;
  }

  // Owner token check (if configured)
  if (!checkOwnerToken(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized — invalid or missing owner token" }));
    return;
  }

  await handleMcpRequest(req, res);
});

// ── Start ─────────────────────────────────────────────────────────

httpServer.listen(port, host, () => {
  console.error(`[safe-bifrost-http] ✅ Ready`);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.error("[safe-bifrost-http] Shutting down...");
  httpServer.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  httpServer.close(() => process.exit(0));
});
