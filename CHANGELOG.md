# Changelog

## 2.0.0 (2026-09-30)

Rewritten against the gateway's own public API. Version 1.x called `/api/gateway/agent/*`,
which on the international deployment is BYOK-only: it picks among the provider keys attached
to an account and answers `No platforms configured` when none are attached, so a plain
gateway key could not use it. The tools are now:

- `freemodel_models` — `GET /v1/models`. Public, no key needed.
- `freemodel_tiers` — `GET /v1/tiers`. The fm-v1-lite / standard / pro bands and what is in them.
- `freemodel_account` — `GET /v1/me`. Subscriptions, expiry, allowed tiers, usage.
- `freemodel_chat` — `POST /v1/chat/completions`. One prompt, one answer.

Breaking: the five 1.x tool names are gone. `skill.md` documented them and is no longer
published with the package (it remains in the repository for reference).

## 1.0.5 (2026-09-30)

- Default API base moved to https://freemodel.online/api/gateway. The previous default,
  model.leyijian.com, no longer resolves — every tool failed with a connection error
  unless FREEMODEL_API was set by hand.
- README and skill.md links repointed; the dead classification.html link is replaced by the
  public model list at https://freemodel.online/v1/models
- README now states plainly that the router picks among the provider keys attached to your
  account, and that none attached means `No platforms configured`

## 1.0.0 (2026-07-05)

- Initial release
- 5 MCP tools: key_health, status, models, recommend, run
- 25+ platforms, 982+ models
- Tier-based routing (L1-L5) with six-dimension benchmark scoring
- Task auto-detection (coding/reasoning/writing/chat/creative/multimodal)
- Subscription priority routing
- Platform health sorting with auto-fallback
- Price-aware model selection via live API
