# FreeModel MCP

**Stop paying Claude prices for every task. Route coding to DeepSeek, reasoning to Qwen, writing to Gemini — automatically. One API key, 25+ platforms, the right model every time.**

```bash
npx freemodel-mcp
```

FreeModel is a **model router for Claude Code**. It looks at what you're doing — writing code, analyzing data, translating text — and picks the best model for that specific task. Not just the cheapest. Not just the most popular. The one that actually scores highest on the relevant benchmarks.

---

## Why this exists

Every model router does the same thing: "route cheap prompts to cheap models." They classify by complexity (simple → Haiku, complex → Opus) and call it a day.

FreeModel answers a different question: **which model actually performs well on this type of task?**

```
Other routers:                FreeModel:
"How hard is this?"           "What kind of task is this?"
         ↓                              ↓
  simple / medium / hard        coding / reasoning / writing
         ↓                              ↓
  pick cheaper model            pick model that scores highest
  at same complexity            on this task type's benchmarks
```

The difference is data. FreeModel scores every model across six dimensions (Code, Knowledge, Math, Instruction, Safety, Efficiency) using 18 public benchmarks — LiveCodeBench, MMLU-Pro, MATH-500, IFEval, SimpleQA, and more. The scores are public at [model.leyijian.com/classification.html](https://model.leyijian.com/classification.html).

---

## vs. the alternatives

| | mcp-multi-model | claude-code-llm-router | llm-routing | **FreeModel** |
|---|---|---|---|---|
| Routing logic | keyword match in yaml | complexity regression | confidence score | **6-dim benchmark scores** |
| Task types | none | simple/medium/hard | none | **coding, reasoning, writing, chat, creative, multimodal** |
| Model catalog | 12 platforms, manual config | 20 platforms, auto-detect | 20 platforms | **25 platforms, 982 models** |
| Why this model? | "you configured it" | "complexity match" | "confidence score" | **"scores 92 on coding benchmarks"** |
| Tier system | no | no | no | **L1–L5, public rubric** |
| Subscription routing | no | no | no | **yes, auto-prioritizes paid subs** |
| Pricing | static yaml | static | static | **live API prices** |
| Data transparency | N/A | N/A | N/A | **public classification page** |

---

## How it works

### Tier system (L1–L5)

Every model gets a tier based on six-dimension benchmark scores — not marketing copy, not vibes.

| Tier | Label | Threshold | Example |
|------|-------|-----------|---------|
| L1 | Specialist | single-dim excellence | DeepSeek-R1 (Reasoning 95) |
| L2 | Professional | ≥70 composite | Claude Opus 4, GPT-5 |
| L3 | Competent | ≥55 composite | Qwen3-Max, DeepSeek-V4 |
| L4 | Capable | ≥35 composite | GLM-4-Flash, ERNIE-Speed |
| L5 | Basic | <35 composite | Small/fast models |

### Task auto-detection

6 task types detected from the user's prompt before routing:

- **coding** — 写代码、debug、爬虫、API、build、修复
- **reasoning** — 分析、数学、架构、安全审计、规划
- **writing** — 翻译、写作、总结、报告、文档
- **creative** — 头脑风暴、命名、设计、营销
- **chat** — 问答、推荐、对比、讨论 (default)
- **multimodal** — 图片、OCR、视频

Task type → filter to models that score well on relevant benchmarks → pick best price/performance.

### Scoring dimensions

```
Code ────────── LiveCodeBench, SWE-bench, HumanEval
Knowledge ───── MMLU-Pro, GPQA Diamond
Math ────────── MATH-500, AIME 2024
Instruction ─── IFEval, MT-Bench
Safety ──────── SimpleQA, TruthfulQA
Efficiency ──── speed, throughput, cost
```

18 data sources, 6 dimensions, all public.

---

## Quick start

### Option 1: npx (recommended)

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "freemodel": {
      "command": "npx",
      "args": ["-y", "freemodel-mcp"],
      "env": {
        "FREEMODEL_KEY": "sk-your-key"
      }
    }
  }
}
```

Get a key at [model.leyijian.com](https://model.leyijian.com) → Settings → API Keys.

### Option 2: git clone

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
      "env": {
        "FREEMODEL_KEY": "sk-your-key"
      }
    }
  }
}
```

---

## MCP Tools

| Tool | What it does |
|------|-------------|
| `freemodel_key_health` | Subscription status, platform health, recommended model |
| `freemodel_status` | Session summary: active model, healthy count |
| `freemodel_models` | List your available platforms and models |
| `freemodel_recommend` | Describe a task → get 2-3 model picks with reasons |
| `freemodel_run` | Execute on a specific model (platform + model name) |

### With the skill (recommended)

Install the Claude Code skill for full auto-routing:

1. Copy `skill.md` to `~/.claude/skills/freemodel/skill.md`
2. Claude Code auto-loads it on startup
3. Every task is auto-classified → routed to the best model → executed

The skill adds: subscription priority routing, platform health sorting, quota exhaustion prevention, task-type auto-detection, and model fallback chains.

---

## What you need

1. A FreeModel API key ([get one here](https://model.leyijian.com))
2. Add platform keys in the dashboard (DeepSeek, Alibaba, etc.)
3. Node.js ≥ 18

That's it. No API keys in config files — everything lives in your FreeModel account, encrypted.

---

## Privacy

This is a local relay. Prompts go from your machine → FreeModel API → target platform. No telemetry, no analytics. Your platform API keys stay encrypted in your FreeModel account.

---

## The data

All tier scores, benchmark results, and data sources are public:

→ [model.leyijian.com/classification.html](https://model.leyijian.com/classification.html)

---

## License

MIT
