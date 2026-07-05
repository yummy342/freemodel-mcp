# Contributing to FreeModel MCP

Thanks for your interest in contributing.

## Ways to contribute

- **Add a platform adapter** — new AI provider integrations go in the backend
- **Improve the skill** — routing rules, task detection, model selection logic
- **Report bugs** — open an issue with reproduction steps
- **Improve docs** — README, examples, translations

## Development

```bash
git clone https://github.com/yummy342/freemodel-mcp.git
cd freemodel-mcp
npm install
```

The MCP server is a single file (`server.js`). Test locally by adding it to your Claude Code `mcp.json`:

```json
{
  "mcpServers": {
    "freemodel": {
      "command": "node",
      "args": ["/absolute/path/to/freemodel-mcp/server.js"],
      "env": {
        "FREEMODEL_KEY": "sk-your-key",
        "FREEMODEL_API": "https://model.leyijian.com/api/gateway"
      }
    }
  }
}
```

## Architecture

```
server.js        — MCP server (5 tools, stdio transport)
skill.md         — Claude Code skill definition (routing logic)
```

The MCP server is a thin relay. All routing intelligence lives in the skill (`skill.md`). The server just forwards requests to the FreeModel API.

## Pull requests

1. Fork the repo
2. Create a feature branch
3. Keep changes minimal and focused
4. Open a PR with a clear description

## License

MIT — see [LICENSE](LICENSE).
