# OpenAI Tunnel Examples

This directory contains privacy-safe examples for connecting Safe-Bifrost to
ChatGPT through an OpenAI Secure MCP Tunnel.

Do not commit real API keys, tunnel IDs, ChatGPT workspace IDs, account names,
or local private paths.

## Files

- `tunnel-client.example.yaml` - profile snippets for stdio and HTTP mode
- `chatgpt-test-prompt.md` - prompt to verify the connector from ChatGPT

## Recommended Windows Flow

1. Configure `safe-bifrost.config.json`.
2. Run `npm.cmd run build`.
3. Use `scripts/safe-bifrost-mcp-stdio.cmd` as the tunnel MCP command.
4. Start `npm.cmd run watch` in a separate terminal.
5. Start `tunnel-client run`.
6. Create a ChatGPT Connector using the tunnel channel.

## Architecture

```text
ChatGPT Web
-> ChatGPT Connector
-> OpenAI Secure MCP Tunnel
-> Safe-Bifrost MCP Server
-> watcher
-> local agent
-> .safe-bifrost/tasks/<task_id>/
-> ChatGPT reads result, diff, and test log
```
