# Changelog

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
