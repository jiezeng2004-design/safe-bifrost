#!/usr/bin/env node
/**
 * Safe-Bifrost MCP Server — stdio transport
 *
 * Run: node dist/index.js
 * Used by OpenAI tunnel-client via `--mcp.command`:
 *   tunnel-client ... --mcp.command "node" --mcp.args "dist/index.js"
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerTools } from "./tools/registry.js";

const config = loadConfig();

console.error(`[safe-bifrost] Workspace: ${config.workspaceRoot}`);
console.error(`[safe-bifrost] Transport: stdio`);

const server = new Server(
  { name: "safe-bifrost", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

registerTools(server);

const transport = new StdioServerTransport();
server.connect(transport).catch((err) => {
  console.error("[safe-bifrost] Fatal:", err);
  process.exit(1);
});

console.error("[safe-bifrost] MCP server ready on stdio");
