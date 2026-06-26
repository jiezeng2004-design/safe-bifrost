# OpenAI Tunnel Examples

This directory contains privacy-safe examples for connecting PatchWarden to
ChatGPT through an OpenAI Secure MCP Tunnel.

Do not commit real API keys, tunnel IDs, ChatGPT workspace IDs, account names,
or local private paths.

## Files

- `tunnel-client.example.yaml` - profile snippets for stdio and HTTP mode
- `chatgpt-test-prompt.md` - prompt to verify the connector from ChatGPT

## Recommended Windows Flow

1. Configure `patchwarden.config.json`.
2. Run `npm.cmd run build`.
3. Use `scripts/mcp/patchwarden-mcp-stdio.cmd` as the tunnel MCP command.
4. Start `npm.cmd run watch` in a separate terminal.
5. Start `tunnel-client run` or use `PatchWarden.cmd start core`.
6. Create a ChatGPT Connector using the tunnel channel.
7. After a tunnel/schema refresh, reconnect the Connector and validate from a
   new ChatGPT conversation; an already-open conversation may retain its older
   tool catalog.

For ChatGPT Direct editing, set `enableDirectProfile: true` in the trusted
local config and run `PatchWarden.cmd start direct`. It uses
`scripts/mcp/patchwarden-mcp-direct.cmd`, the separate `patchwarden-direct` Tunnel
Client profile, no Watcher, and an isolated `runtime-direct` status directory.
Use a separate Direct Connector/Tunnel ID so the fixed 17-tool Core catalog and
the 10-tool Direct catalog never overwrite each other's cached schema.

The Windows launcher prompts for the runtime API key once and stores only a
Windows DPAPI-encrypted value under `%APPDATA%\patchwarden`. Use
`PatchWarden.cmd reset-key` to remove the saved credential.

Before the launcher starts the tunnel it performs a real MCP stdio handshake
and requires the exact `chatgpt_core` manifest. Run
`PatchWarden.cmd health` to see the version, profile, tool names, schema
hash, process sources, and any mixed-version warnings. The check is read-only.
The v0.6.1 core manifest contains 17 tools. A different count or schema hash
requires a Connector refresh and validation from a new ChatGPT conversation.

## Architecture

```text
ChatGPT Web
-> ChatGPT Connector
-> OpenAI Secure MCP Tunnel
-> PatchWarden MCP Server
-> watcher
-> local agent
-> .patchwarden/tasks/<task_id>/
-> ChatGPT reads result, diff, and test log
```
