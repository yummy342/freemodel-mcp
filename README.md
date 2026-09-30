# FreeModel MCP

An MCP server for the [FreeModel](https://freemodel.online) gateway: look up the model catalogue, see what your key is allowed to call, and send a prompt — from inside Claude Code or any other MCP client.

```bash
npx freemodel-mcp
```

## The four tools

| Tool | Calls | Key needed |
|---|---|---|
| `freemodel_models` | `GET /v1/models` | no — the catalogue is public |
| `freemodel_tiers` | `GET /v1/tiers` | yes |
| `freemodel_account` | `GET /v1/me` | yes |
| `freemodel_chat` | `POST /v1/chat/completions` | yes |

**`freemodel_models`** — the catalogue, the same endpoint the counts on the site are derived from. Filter by modality (`chat`, `image`, `video`, `tts`, `asr`, `embedding`, `rerank`) or by id substring.

**`freemodel_tiers`** — the three tier aliases and what is in each band: `fm-v1-lite` (free, any account), `fm-v1-standard`, `fm-v1-pro`. These are pools rather than single models: asking for a tier means "any model in this band", which is what lets a request survive one provider going down.

**`freemodel_account`** — subscriptions and when they expire, which tiers this key may call, usage so far.

**`freemodel_chat`** — one prompt, one answer. Defaults to `fm-v1-lite`; pass any id from `freemodel_models` to pin a specific model.

## Quick start

Get a key at [freemodel.online/console](https://freemodel.online/console) → API keys.

### Claude Code (npx)

```json
{
  "mcpServers": {
    "freemodel": {
      "command": "npx",
      "args": ["-y", "freemodel-mcp"],
      "env": { "FREEMODEL_KEY": "sk-your-key" }
    }
  }
}
```

### Codex CLI

```
OPENAI_BASE_URL = https://freemodel.online/v1
OPENAI_API_KEY  = sk-your-key
```

### From source

```bash
git clone https://github.com/yummy342/freemodel-mcp.git
cd freemodel-mcp && npm install
```

```json
{
  "mcpServers": {
    "freemodel": {
      "command": "node",
      "args": ["/path/to/freemodel-mcp/server.js"],
      "env": { "FREEMODEL_KEY": "sk-your-key" }
    }
  }
}
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `FREEMODEL_KEY` | — | Your gateway key. Only the keyed tools need it. |
| `FREEMODEL_API` | `https://freemodel.online/v1` | API root. Change it to point at another deployment. |

The free tier needs no card. `fm-v1-standard` and `fm-v1-pro` need a subscription, which is bought on the account portal at [alli.website](https://alli.website/) — without it those calls are refused with a 402, never billed silently.

## What this package does not do

- **No routing across your own provider keys.** Version 1.x called the `/api/gateway/agent/*` endpoints, which pick among the provider keys attached to an account and answer `No platforms configured` when none are attached. This package talks to the gateway's own catalogue and tiers instead, so a plain key is enough.
- **No streaming yet.** `freemodel_chat` waits for the full answer.
- **No embeddings or image calls.** Those exist on the gateway (`auto/embed`, `auto/image`, and the rest), but this package does not wrap them.

## License

MIT
