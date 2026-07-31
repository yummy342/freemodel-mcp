#!/usr/bin/env node
/* ========================================================================
   FreeModel MCP Server — smart model router for Claude Code
   SDK v1.29.0: McpServer + registerTool + Zod

   2026-07-31 Quick Wins applied:
     Q01: isError: true on ALL 24 catch blocks
     Q02: filled empty inputSchemas (key_health, status, models)
     Q03: API_KEY in Authorization header for mcshared calls (not URL)
     Q04: bench_compare parallel via Promise.all
     Q05: unified API_KEY guard
     Q06: centralized timeout constants
   ======================================================================== */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const z = require('zod');
const fs = require('fs');
const path = require('path');
const os = require('os');

/* ═══════════════════════════════════════════════════════════════════
   步骤1: 常量和共享基础设施
   ═══════════════════════════════════════════════════════════════════ */

const SIGNAL_PATH = path.join(process.cwd(), '.freemodel_cleared');

const API_BASE = process.env.FREEMODEL_API || 'https://model.leyijian.com/api/gateway';
const API_KEY  = process.env.FREEMODEL_KEY || '';
const ADMIN_KEY = process.env.FM_ADMIN_KEY || '';
const MC_BASE   = process.env.FREEMODEL_MC_BASE || 'https://model.leyijian.com/mc-shared';
const LOOP_BASE  = process.env.LOOP_URL || 'https://model.leyijian.com/loop';
const OMNI_BASE  = 'https://model.leyijian.com/omni';

/* Q06: 统一超时常量 */
const T = {
  SHORT:   3000,
  MID:     10000,
  LONG:    35000,
  OPS:     120000,
  RUN:     120000,
};

/* Q05: 统一 API_KEY guard */
function guardKey() {
  if (API_KEY) return null;
  return {
    isError: true,
    content: [{ type: 'text',
      text: 'FreeModel API Key not configured.\n' +
            '→ Visit https://model.leyijian.com → Settings → API Keys\n' +
            '→ Copy your sk-xxx key\n' +
            '→ Set FREEMODEL_KEY env var in mcp.json' }]
  };
}

/* Q01: 统一错误格式化 — 分类错误消息, 始终返回 isError: true */
function errReply(category, detail, hint) {
  const prefix = { validation: 'Validation', network: 'Network', api: 'API',
    timeout: 'Timeout', unknown: 'Unexpected' }[category] || 'Error';
  let text = `[${prefix}] ${detail}`;
  if (hint) text += `\n→ ${hint}`;
  return { isError: true, content: [{ type: 'text', text }] };
}

/* ── Q03: mcshared HTTP helpers — API_KEY 改为 X-API-Key header (auth.py line 18) ── */
function mcGet(urlPath, timeout) {
  return fetch(MC_BASE + urlPath, {
    headers: { 'X-API-Key': API_KEY },
    signal: AbortSignal.timeout(timeout || T.MID)
  });
}
function mcPost(urlPath, body, timeout) {
  return fetch(MC_BASE + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout || T.MID)
  });
}

/* ═══════════════════════════════════════════════════════════════════
   步骤2: MCP Server 初始化
   ═══════════════════════════════════════════════════════════════════ */

const server = new McpServer(
  { name: 'freemodel-mcp', version: '1.0.5' },
  { capabilities: { tools: {} } }
);

/* ═══════════════════════════════════════════════════════════════════
   步骤3: freemodel_* 核心工具 (7)
   ═══════════════════════════════════════════════════════════════════ */

/* ── freemodel_key_health ── (Q02: 补齐 inputSchema) */
server.registerTool(
  'freemodel_key_health',
  {
    description: 'Check API key health: subscription status, platform health, and recommended model. Use FIRST before task routing.',
    inputSchema: {
      platform: z.string().optional().describe('Check a specific platform. Omit to check all.')
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async (args) => {
    const g = guardKey(); if (g) return g;
    try {
      let url = API_BASE + '/key-health?api_key=' + encodeURIComponent(API_KEY);
      if (args?.platform) url += '&platform=' + encodeURIComponent(args.platform);
      const r = await fetch(url, { signal: AbortSignal.timeout(T.MID) });
      const d = await r.json();
      if (d.code !== 200) return errReply('api', d.msg || String(d.code),
        'Check API key validity at model.leyijian.com');

      const data = d.data || {};
      const subs = Array.isArray(data.subscriptions) ? data.subscriptions : [];
      const sorted = [...subs].sort((a, b) => (a.priority || 99) - (b.priority || 99));
      const top = sorted[0] || null;
      const isSub = subs.length > 0;

      let text = '';
      text += 'Key Health: ' + (data.mcp ? '🟢' : '⚫') + ' MCP | ' + (data.api ? '🟢' : '🔴') + ' API\n';
      text += `Plan: ${isSub ? 'subscription' : 'free'}\n`;
      if (top) {
        text += `Top Subscription: ${top.platform} (priority ${top.priority})\n`;
        text += `Expires: ${top.expires_at || 'never'}\n`;
        text += `Task types: ${top.task_types || 'all'}\n`;
      }
      if (subs.length) {
        text += '\n--- All Subscriptions ---\n';
        subs.sort((a, b) => (a.priority || 99) - (b.priority || 99))
          .forEach(s => { text += `• ${s.platform} (prio ${s.priority}${s.expires_at ? ', exp ' + s.expires_at : ', never'})\n`; });
      }

      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return errReply('network', e.message, 'Check network or retry. If persists, FreeModel API may be down.');
    }
  }
);

/* ── freemodel_status ── */
server.registerTool(
  'freemodel_status',
  {
    description: 'Get FreeModel session summary: active model, platform, subscription, healthy count.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async () => {
    const g = guardKey(); if (g) return g;
    try {
      const r = await fetch(API_BASE + '/key-health?api_key=' + encodeURIComponent(API_KEY), {
        signal: AbortSignal.timeout(T.MID)
      });
      const d = await r.json();
      if (d.code !== 200) return errReply('api', d.msg || String(d.code), 'Check API key validity.');

      const data = d.data || {};
      const subs = Array.isArray(data.subscriptions) ? data.subscriptions : [];
      const sorted = [...subs].sort((a, b) => (a.priority || 99) - (b.priority || 99));
      const top = sorted[0] || null;
      const isSub = subs.length > 0;

      let text = '── FreeModel Session ──\n';
      text += `Plan: ${isSub ? 'subscription' : 'free'}\n`;
      text += `Subscriptions: ${subs.length ? subs.map(s => s.platform + '(P' + s.priority + ')').join(', ') : 'none'}\n`;
      text += `Active: ${top ? top.platform + ' (P' + top.priority + ')' : 'auto'}\n`;
      text += `Top expires: ${top?.expires_at || 'never'}\n`;
      text += `Keys: ${data.platforms_available || 0} platforms\n`;

      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return errReply('network', e.message, 'FreeModel API may be unreachable.');
    }
  }
);

/* ── freemodel_models ── (Q02: 补齐 inputSchema + filter/search/limit) */
server.registerTool(
  'freemodel_models',
  {
    description: 'List all AI models available to you across platforms. Returns platform and model names.',
    inputSchema: {
      filter: z.enum(['llm','image','audio','embedding','all']).optional()
        .describe('Filter by model type (default all)'),
      search: z.string().optional().describe('Search model name or provider'),
      limit: z.number().min(1).max(200).optional().describe('Max results (default 50)')
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async (args) => {
    const g = guardKey(); if (g) return g;
    try {
      const r = await fetch(API_BASE + '/agent/models?api_key=' + encodeURIComponent(API_KEY), {
        signal: AbortSignal.timeout(T.MID)
      });
      const d = await r.json();
      if (d.code !== 200) return errReply('api', d.msg || String(d.code), '');

      let models = d.data?.models || [];
      const filter = args?.filter || 'all';
      const search = args?.search?.toLowerCase();
      const limit = args?.limit || 50;

      if (filter !== 'all') models = models.filter(m => m.model_type === filter);
      if (search) models = models.filter(m =>
        (m.model_name || '').toLowerCase().includes(search) ||
        (m.provider || '').toLowerCase().includes(search));

      const platforms = (d.data?.platforms || []).join(', ');
      const lines = models.slice(0, limit).map(m =>
        m.provider + ': ' + m.model_name + ' (' + m.model_type + ')');
      return { content: [{ type: 'text',
        text: `Platforms: ${platforms}\n\nModels (${lines.length}):\n${lines.join('\n')}` }] };
    } catch (e) {
      return errReply('network', e.message, '');
    }
  }
);

/* ── freemodel_recommend ── */
server.registerTool(
  'freemodel_recommend',
  {
    description: 'Recommend the best AI model for a given task. Analyzes your task and recommends 2-3 models with reasons.',
    inputSchema: {
      task: z.string().min(3).describe('Task description e.g. "写一个Python爬虫"')
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  async (args) => {
    const g = guardKey(); if (g) return g;
    try {
      const r = await fetch(API_BASE + '/agent/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: API_KEY, task: args.task }),
        signal: AbortSignal.timeout(T.MID)
      });
      const d = await r.json();
      if (d.code !== 200) return errReply('api', d.msg || String(d.code),
        'Task description may be too short or invalid.');

      const recs = (d.data?.recommendations || []).map((r, i) =>
        `${i + 1}. ${r.provider}/${r.model} — ${r.reason} (${r.price_note})`);
      return { content: [{ type: 'text',
        text: `Task: ${args.task}\n\nRecommendations:\n${recs.join('\n')}` }] };
    } catch (e) {
      return errReply('network', e.message, '');
    }
  }
);

/* ── freemodel_route ── */
server.registerTool(
  'freemodel_route',
  {
    description: 'Auto-route a task: classify task type, pick the best model via scoring engine, execute it. One-step smart routing.',
    inputSchema: {
      task: z.string().min(2).describe('The task to execute'),
      system: z.string().optional().describe('System prompt (optional)'),
      temperature: z.number().min(0).max(2).optional().describe('Temperature (default 0.7)'),
      max_tokens: z.number().min(1).max(65536).optional().describe('Max output tokens'),
      task_type: z.enum(['coding','reasoning','writing','creative','chat','multimodal','longform','embedding']).optional()
        .describe('Force task type. Auto-detected if omitted.'),
      preset: z.enum(['balanced','quality-first','budget','subscription']).optional().describe('Scoring preset')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  async (args) => {
    const g = guardKey(); if (g) return g;
    try {
      /* Step 1: recommend */
      const recBody = { api_key: API_KEY, task: args.task };
      if (args.task_type) recBody.task_type = args.task_type;
      if (args.preset) recBody.preset = args.preset;

      const recRes = await fetch(API_BASE + '/agent/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(recBody),
        signal: AbortSignal.timeout(T.MID)
      });
      const recData = await recRes.json();
      if (recData.code !== 200) return errReply('api', recData.msg || String(recData.code), '');

      const picks = recData.data?.recommendations || [];
      if (!picks.length) return errReply('api', 'No suitable model found',
        'Try a different task description or check platform availability.');

      const best = picks[0];
      const taskType = recData.data.task_type || 'chat';
      const taskTier = recData.data.task_tier || 'L2';

      /* Complexity gate → PDCA */
      const COMPLEX_TYPES = new Set(['coding', 'reasoning', 'refactor', 'architect', 'debug']);
      const COMPLEX_TIERS = new Set(['L3', 'L4']);
      const isComplex = COMPLEX_TYPES.has(taskType) || COMPLEX_TIERS.has(taskTier);

      if (isComplex) {
        try {
          const sr = await fetch(LOOP_BASE + '/api/loop/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task: args.task, preset: args.preset || 'balanced' }),
            signal: AbortSignal.timeout(T.MID)
          });
          const sd = await sr.json();
          if (sd.task_id) {
            const pdcaMeta = `[PDCA] ${taskType}/${taskTier} → task ${sd.task_id}`;
            const pdcaText = pdcaMeta + '\nComplex task detected. PDCA loop started.\n' +
              `Run: /workflow pdca-loop.js with task_id=${sd.task_id}\n` +
              `Best model for execution: ${best.provider}/${best.model} (score: ${best.composite})`;
            try { fs.writeFileSync(SIGNAL_PATH, String(Date.now())); } catch (e) {}
            notifyDiscipline();
            return { content: [{ type: 'text', text: pdcaText }] };
          }
        } catch (e) {
          process.stderr.write('[freemodel] PDCA start failed, fallback to direct: ' + e.message + '\n');
        }
      }

      /* Step 2: execute */
      const runBody = {
        api_key: API_KEY, platform: best.provider, model: best.model,
        system: args.system || '', task: args.task,
        temperature: args.temperature != null ? args.temperature : 0.7,
        task_type: taskType
      };
      if (args.max_tokens != null) runBody.max_tokens = args.max_tokens;

      const runRes = await fetch(API_BASE + '/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(runBody),
        signal: AbortSignal.timeout(T.RUN)
      });
      const runData = await runRes.json();
      if (runData.code !== 200) return errReply('api', runData.msg || String(runData.code),
        'Model may be unavailable. Try a different platform or model.');

      const reply = runData.data.reply || '';
      const reasoning = runData.data.reasoning || '';
      const tierWarn = runData.data.tier_warn;

      let meta = `[Routed] ${taskType}/${taskTier} → ${best.provider}/${best.model} (score: ${best.composite}, tier: ${best.tier || 'N/A'})`;
      if (tierWarn) meta += `\n[Warning] ${tierWarn.msg}`;

      let text = meta + '\n\n';
      if (reasoning) text += '[Thinking]\n' + reasoning + '\n\n[Response]\n' + reply;
      else text += reply;

      try { fs.writeFileSync(SIGNAL_PATH, String(Date.now())); } catch (e) {}
      notifyDiscipline();
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return errReply('network', e.message, 'FreeModel API unreachable. Check network or try again.');
    }
  }
);

/* ── freemodel_run ── */
server.registerTool(
  'freemodel_run',
  {
    description: 'Execute a task using a specific AI model from a specific platform. Uses your stored API keys.',
    inputSchema: {
      platform: z.string().min(1).describe('Platform ID: "stepfun","baidu","zhipu","aliyun","silicon","openrouter" etc.'),
      model: z.string().min(1).describe('Model e.g. "step-3.7-flash"'),
      task: z.string().min(2).describe('The task to execute'),
      system: z.string().optional().describe('System prompt (optional)'),
      temperature: z.number().min(0).max(2).optional().describe('Temperature (default 0.7)'),
      max_tokens: z.number().min(1).optional()
        .describe('Max output tokens. Set 4000+ for reasoning models to prevent empty output.'),
      reasoning_effort: z.enum(['low','medium','high']).optional().describe('Reasoning depth for step-3.7-flash.')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  async (args) => {
    const g = guardKey(); if (g) return g;
    try {
      const body = {
        api_key: API_KEY, platform: args.platform, model: args.model,
        system: args.system || '', task: args.task,
        temperature: args.temperature != null ? args.temperature : 0.7
      };
      if (args.max_tokens != null) body.max_tokens = args.max_tokens;
      if (args.reasoning_effort) body.reasoning_effort = args.reasoning_effort;

      const r = await fetch(API_BASE + '/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(T.RUN)
      });
      const d = await r.json();
      if (d.code !== 200) return errReply('api', d.msg || String(d.code),
        'Check platform/model spelling. Model may be unavailable or key expired.');

      const reply = d.data.reply || '';
      const reasoning = d.data.reasoning || '';
      let text = reply;
      if (reasoning) text = '[Thinking]\n' + reasoning + '\n\n[Response]\n' + reply;

      try { fs.writeFileSync(SIGNAL_PATH, String(Date.now())); } catch (e) {}
      notifyTrack(args.task);
      notifyDiscipline();
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return errReply('network', e.message, '');
    }
  }
);

/* ── freemodel_pdca ── */
server.registerTool(
  'freemodel_pdca',
  {
    description: 'Start a PDCA multi-agent task loop. Task is broken into WBS, executed, reviewed, and iterated until quality gates pass. Use for complex multi-step tasks.',
    inputSchema: {
      task: z.string().min(3).describe('Task description to execute with PDCA quality loop'),
      preset: z.enum(['balanced','quality-first','budget']).optional().describe('Loop preset (default balanced)')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  async (args) => {
    const g = guardKey(); if (g) return g;
    try {
      let recallText = '';
      try {
        const rr = await mcGet('/api/knowledge/recall?query=' + encodeURIComponent(args.task) + '&k=3', T.SHORT);
        const rd = await rr.json();
        if (rd.data?.results?.length) {
          recallText = '\n📚 ' + rd.data.results.map(r => r.description).join(' | ');
        }
      } catch (e) { /* recall optional */ }

      const sr = await fetch(LOOP_BASE + '/api/loop/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: args.task.trim(), preset: args.preset || 'balanced' }),
        signal: AbortSignal.timeout(T.MID)
      });
      const sd = await sr.json();

      if (sd.error || !sd.task_id) {
        return errReply('api', sd.error || 'unknown', 'PDCA engine may be down. Try freemodel_run directly.');
      }

      const text = [
        `PDCA Task: ${sd.task_id}  Stage: ${sd.stage}`,
        recallText,
        `Next: run /workflow pdca-loop.js with task_id=${sd.task_id}`,
      ].filter(Boolean).join('\n');

      notifyTrack(args.task);
      notifyDiscipline();
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return errReply('network', e.message, 'Loop API unreachable.');
    }
  }
);

/* ═══════════════════════════════════════════════════════════════════
   步骤4: mcshared 知识图谱工具 (7) — Q03: Authorization header
   ═══════════════════════════════════════════════════════════════════ */

/* ── mcshared_search ── */
server.registerTool(
  'mcshared_search',
  {
    description: 'Search the knowledge graph for relevant memories, code, and decisions. Use before starting any task to recall context.',
    inputSchema: {
      query: z.string().min(1).describe('Search query — keywords describing what you need to recall'),
      k: z.number().min(1).max(50).optional().describe('Number of results (default 5)')
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async (args) => {
    try {
      const r = await mcGet('/api/knowledge/search?q=' + encodeURIComponent(args.query) +
        '&k=' + (args.k || 5), T.SHORT);
      const d = await r.json();
      if (d.code && d.code !== 200) return errReply('api', d.msg || String(d.code), '');
      if (!d.data?.results?.length) return { content: [{ type: 'text', text: 'No matching memories.' }] };
      const lines = d.data.results.map((item, i) =>
        `${i + 1}. ${(item.description || item.content || '').substring(0, 120)}`);
      return { content: [{ type: 'text',
        text: `📚 ${d.data.results.length} memories:\n${lines.join('\n')}` }] };
    } catch (e) {
      return errReply('network', e.message, 'Knowledge graph may be down. Continue without memory recall.');
    }
  }
);

/* ── mcshared_track ── (Q03: key → Authorization header) */
server.registerTool(
  'mcshared_track',
  {
    description: 'Save a completed task to the knowledge graph. Use after finishing any meaningful work.',
    inputSchema: {
      description: z.string().min(1).max(500).describe('One sentence describing what was done'),
      files: z.string().optional().describe('Comma-separated list of changed files (max 3)'),
      outcome: z.enum(['done', 'blocked', 'in_progress']).optional().describe('Task outcome (default done)')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  async (args) => {
    try {
      const r = await mcPost('/api/projects/freemodel/knowledge/track', {
        description: args.description, files: args.files || '', outcome: args.outcome || 'done'
      }, T.SHORT);
      const d = await r.json();
      if (d.ok) return { content: [{ type: 'text', text: `🧠 Saved: #${d.id} — ${d.description}` }] };
      return errReply('api', JSON.stringify(d), '');
    } catch (e) {
      return errReply('network', e.message, '');
    }
  }
);

/* ── mcshared_notifications ── */
server.registerTool(
  'mcshared_notifications',
  {
    description: 'Check notifications: unread count and recent alerts. Use to see system notices, quota warnings, and collaboration updates.',
    inputSchema: {
      limit: z.number().min(1).max(50).optional().describe('Number of notifications to show (default 5)')
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async (args) => {
    try {
      const [ur, nr] = await Promise.all([
        mcGet('/api/notifications/unread-count', T.SHORT).then(r => r.json()).catch(() => null),
        mcGet('/api/notifications/notifications?status=unread&limit=' + (args.limit || 5), T.SHORT)
          .then(r => r.json()).catch(() => null)
      ]);
      if (!ur && !nr) return errReply('api', 'Notifications API unavailable.', '');
      if (ur && ur.code && ur.code !== 200) return errReply('api', ur.msg || 'unread-count failed', '');
      if (nr && nr.code && nr.code !== 200) return errReply('api', nr.msg || 'notifications list failed', '');
      const unread = (ur && (ur.data?.count || ur.unread)) || 0;
      let items = (nr && (nr.data?.items || nr.data)) || [];
      if (!Array.isArray(items)) items = [];
      const lines = items.map((n, i) =>
        `${i + 1}. [${n.level || 'info'}] ${(n.title || n.message || '').substring(0, 100)}`);
      return { content: [{ type: 'text',
        text: `🔔 ${unread} unread\n${lines.length ? lines.join('\n') : 'No notifications.'}` }] };
    } catch (e) {
      return errReply('network', e.message, '');
    }
  }
);

/* ── mcshared_ops_analyze ── */
server.registerTool(
  'mcshared_ops_analyze',
  {
    description: 'Analyze platform SMS/email/notifications, or run a platform health inspection. Two modes: paste raw notification text for LLM parsing, or omit text for health sweep.',
    inputSchema: {
      text: z.string().optional().describe('Raw SMS/email/notification text to analyze. Omit for health sweep.')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async (args) => {
    const g = guardKey(); if (g) return g;
    try {
      const body = { api_key: API_KEY };
      if (args.text) body.text = args.text;
      const r = await fetch(API_BASE + '/ops/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(T.OPS)
      });
      const d = await r.json();
      if (d.code !== 200) return errReply('api', d.msg || String(d.code), '');
      let results = d.data || [];
      if (!Array.isArray(results)) results = [results];
      const lines = results.map((r, i) => {
        const p = r.parsed || {};
        return `${i + 1}. [${p.level || 'info'}] ${p.title || '分析结果'}\n   ${p.recommendation || p.summary || ''}`;
      });
      return { content: [{ type: 'text', text: `🛡 Ops分析完成:\n${lines.join('\n')}` }] };
    } catch (e) {
      return errReply('network', e.message,
        'Ops analysis uses LLM backend, may take up to 120s. Timeout is normal for long texts.');
    }
  }
);

/* ── mcshared_loop_start ── */
server.registerTool(
  'mcshared_loop_start',
  {
    description: 'Start a PDCA quality loop for complex multi-step tasks. Breaks task into WBS, executes, reviews, and iterates until quality gates pass.',
    inputSchema: {
      task: z.string().min(3).describe('Task description for PDCA quality loop'),
      preset: z.enum(['balanced','quality-first','budget']).optional().describe('Loop preset (default balanced)')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  async (args) => {
    try {
      const r = await fetch(LOOP_BASE + '/api/loop/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: args.task, preset: args.preset || 'balanced' }),
        signal: AbortSignal.timeout(T.MID)
      });
      const d = await r.json();
      if (d.error) return errReply('api', d.error, '');
      return { content: [{ type: 'text',
        text: `🔁 PDCA Loop #${d.task_id} — Stage: ${d.stage || 'init'}\nWatch: /workflow pdca-loop.js task_id=${d.task_id}` }] };
    } catch (e) {
      return errReply('network', e.message, '');
    }
  }
);

/* ── mcshared_loop_status ── */
server.registerTool(
  'mcshared_loop_status',
  {
    description: 'Check status of a running PDCA loop or list all active loops.',
    inputSchema: {
      task_id: z.string().optional().describe('Specific task ID to check. Omit to list all active loops.')
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async (args) => {
    try {
      const url = args.task_id
        ? LOOP_BASE + '/api/loop/' + encodeURIComponent(args.task_id)
        : LOOP_BASE + '/api/loop/active';
      const r = await fetch(url, { signal: AbortSignal.timeout(T.SHORT) });
      const d = await r.json();
      if (Array.isArray(d)) {
        if (!d.length) return { content: [{ type: 'text', text: 'No active PDCA loops.' }] };
        const lines = d.map(l => `#${l.task_id} [${l.stage || '?'}] ${(l.task || '').substring(0, 80)}`);
        return { content: [{ type: 'text', text: `🔁 ${d.length} active loops:\n${lines.join('\n')}` }] };
      }
      return { content: [{ type: 'text', text: `Loop #${args.task_id}: ${JSON.stringify(d)}` }] };
    } catch (e) {
      return errReply('network', e.message, '');
    }
  }
);

/* ── mcshared_loop_cancel ── */
server.registerTool(
  'mcshared_loop_cancel',
  {
    description: 'Cancel a running PDCA loop.',
    inputSchema: {
      task_id: z.string().min(1).describe('Task ID of the loop to cancel')
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  },
  async (args) => {
    try {
      const r = await fetch(LOOP_BASE + '/api/loop/' + encodeURIComponent(args.task_id) + '/cancel', {
        method: 'POST',
        signal: AbortSignal.timeout(T.SHORT)
      });
      const d = await r.json();
      return { content: [{ type: 'text', text: `🔁 Cancelled: ${JSON.stringify(d)}` }] };
    } catch (e) {
      return errReply('network', e.message, '');
    }
  }
);

/* ═══════════════════════════════════════════════════════════════════
   步骤5: 论坛工具 (5)
   ═══════════════════════════════════════════════════════════════════ */

/* ── mcshared_forum_topics ── */
server.registerTool(
  'mcshared_forum_topics',
  {
    description: 'List forum topics: 模型评测, 免费额度, 接入教程, 踩坑求助, AI杂谈, 站务公告, 擂台.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async () => {
    try {
      const r = await fetch(API_BASE + '/forum/topics', { signal: AbortSignal.timeout(T.SHORT) });
      const d = await r.json();
      if (d.code !== 200) return errReply('api', d.msg || String(d.code), '');
      const topics = d.data || [];
      const lines = topics.map(t => `#${t.id} ${t.name} (${t.question_count || 0} questions)`);
      return { content: [{ type: 'text', text: `📋 Forum Topics:\n${lines.join('\n')}` }] };
    } catch (e) {
      return errReply('network', e.message, '');
    }
  }
);

/* ── mcshared_forum_feed ── */
server.registerTool(
  'mcshared_forum_feed',
  {
    description: 'Get latest forum questions and answers. Browse recent discussions across topics.',
    inputSchema: {
      topic_id: z.number().optional().describe('Filter by topic ID (omit for all topics)'),
      sort: z.enum(['recent', 'popular']).optional().describe('Sort order (default recent)'),
      limit: z.number().min(1).max(100).optional().describe('Number of questions (default 10)')
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async (args) => {
    try {
      let url = API_BASE + '/forum/questions?limit=' + (args.limit || 10) + '&sort=' + (args.sort || 'recent');
      if (args.topic_id) url += '&topic_id=' + args.topic_id;
      const r = await fetch(url, { signal: AbortSignal.timeout(T.SHORT) });
      const d = await r.json();
      if (d.code !== 200) return errReply('api', d.msg || String(d.code), '');
      let questions = d.data?.rows || d.data || [];
      if (!Array.isArray(questions)) questions = [];
      const lines = questions.map((q, i) =>
        `${i + 1}. [${q.topic_name || '?'}] ${(q.title || '').substring(0, 80)} — ${q.answer_count || 0} answers`);
      return { content: [{ type: 'text', text: `💬 Latest Questions:\n${lines.join('\n')}` }] };
    } catch (e) {
      return errReply('network', e.message, '');
    }
  }
);

/* ── mcshared_forum_ask ── */
server.registerTool(
  'mcshared_forum_ask',
  {
    description: 'Ask a question in the forum. Bots will automatically answer with AI-generated responses.',
    inputSchema: {
      title: z.string().min(1).max(200).describe('Question title (max 200 chars)'),
      body: z.string().optional().describe('Question body/details (optional)'),
      topic_id: z.number().optional()
        .describe('Topic ID: 1=模型评测 2=免费额度 3=接入教程 4=踩坑求助 5=AI杂谈 6=站务公告 248=擂台')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  async (args) => {
    const g = guardKey(); if (g) return g;
    try {
      const tid = args.topic_id || 5;
      const body = { api_key: API_KEY, title: args.title, topic_ids: [tid] };
      if (args.body) body.body = args.body;
      const r = await fetch(API_BASE + '/forum/questions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(T.MID)
      });
      const d = await r.json();
      if (d.code !== 200) return errReply('api', d.msg || String(d.code),
        'Check title length or API key validity.');
      return { content: [{ type: 'text',
        text: `✅ Question posted! ID: ${d.data.id}\nBots will answer shortly (every 5 min).` }] };
    } catch (e) {
      return errReply('network', e.message, '');
    }
  }
);

/* ── mcshared_forum_bots ── */
server.registerTool(
  'mcshared_forum_bots',
  {
    description: 'List active forum AI bots — each bot is an AI model answering questions. Shows model, vendor, score, and status.',
    inputSchema: {
      limit: z.number().min(1).max(100).optional().describe('Number of bots to show (default 10)')
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async (args) => {
    if (!ADMIN_KEY) return errReply('validation', 'FM_ADMIN_KEY not configured.',
      'Set FM_ADMIN_KEY env in mcp.json. Required for admin-only forum endpoints.');
    try {
      const r = await fetch(API_BASE + '/forum/admin/bots?api_key=' + encodeURIComponent(ADMIN_KEY),
        { signal: AbortSignal.timeout(T.SHORT) });
      const d = await r.json();
      if (d.code !== 200) return errReply('api', d.msg || String(d.code), '');
      const bots = (d.data || []).slice(0, args.limit || 10);
      const lines = bots.map((b, i) =>
        `${i + 1}. ${b.username || b.model_id || '?'} [${b.vendor || '?'}] score:${b.final_score || b.weekly_score || '?'}`);
      return { content: [{ type: 'text', text: `🤖 ${bots.length} Forum Bots:\n${lines.join('\n')}` }] };
    } catch (e) {
      return errReply('network', e.message, '');
    }
  }
);

/* ── mcshared_forum_scheduler ── */
server.registerTool(
  'mcshared_forum_scheduler',
  {
    description: 'Manually trigger the forum bot scheduler. Bots will answer unanswered questions and review recent answers.',
    inputSchema: {
      questions: z.number().min(1).max(50).optional().describe('Number of questions to answer (default 5)')
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  },
  async (args) => {
    if (!ADMIN_KEY) return errReply('validation', 'FM_ADMIN_KEY not configured.',
      'Set FM_ADMIN_KEY env in mcp.json.');
    try {
      const r = await fetch(API_BASE + '/forum/admin/scheduler/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: ADMIN_KEY }),
        signal: AbortSignal.timeout(T.OPS)
      });
      const d = await r.json();
      if (d.code !== 200) return errReply('api', d.msg || String(d.code), '');
      return { content: [{ type: 'text',
        text: `📣 Scheduler triggered!\nAnswered: ${d.data?.answered || '?'} questions\nReviewed: ${d.data?.reviewed || '?'} answers` }] };
    } catch (e) {
      return errReply('network', e.message, '');
    }
  }
);

/* ═══════════════════════════════════════════════════════════════════
   步骤6: 评测工具 (3) — Q04: bench_compare 并行
   ═══════════════════════════════════════════════════════════════════ */

/* ── mcshared_bench_run ── */
server.registerTool(
  'mcshared_bench_run',
  {
    description: 'Benchmark a model: measure latency, tokens/sec, and score. Uses your own API key for the target platform.',
    inputSchema: {
      platform: z.string().min(1).describe('Platform to test (e.g. deepseek, aliyun, stepfun, zhipu)'),
      model: z.string().optional().describe('Specific model name. Omit to use default test model.')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  async (args) => {
    const g = guardKey(); if (g) return g;
    try {
      const body = { api_key: API_KEY, platform: args.platform };
      if (args.model) body.model = args.model;
      const r = await fetch(API_BASE + '/bench/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(T.LONG)
      });
      const d = await r.json();
      if (d.code !== 200) return errReply('api', d.msg || String(d.code), '');
      const b = d.data;
      return { content: [{ type: 'text',
        text: `⚡ ${b.platform}/${b.model_name}\n  Latency: ${b.latency_ms}ms | TPS: ${b.tokens_per_sec} | Score: ${b.score}/100 | ${b.status}` }] };
    } catch (e) {
      return errReply('network', e.message, '');
    }
  }
);

/* ── mcshared_bench_leaderboard ── */
server.registerTool(
  'mcshared_bench_leaderboard',
  {
    description: 'View the benchmark leaderboard: top 20 models ranked by speed and throughput score.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async () => {
    try {
      const r = await fetch(API_BASE + '/bench/leaderboard', { signal: AbortSignal.timeout(T.SHORT) });
      const d = await r.json();
      if (d.code !== 200) return errReply('api', d.msg || String(d.code), '');
      const rows = d.data || [];
      if (!rows.length) return { content: [{ type: 'text',
        text: 'No benchmark data yet. Run mcshared_bench_run first!' }] };
      const lines = rows.map((r, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        return `${medal} ${r.platform}/${r.model_name} — ${r.score} pts (${r.latency}ms, ${r.tps} tps, ${r.runs} runs)`;
      });
      return { content: [{ type: 'text', text: `🏆 Bench Leaderboard:\n${lines.join('\n')}` }] };
    } catch (e) {
      return errReply('network', e.message, '');
    }
  }
);

/* ── mcshared_bench_compare ── (Q04: for→Promise.all) */
server.registerTool(
  'mcshared_bench_compare',
  {
    description: 'Compare multiple models head-to-head. Benchmarks each one and ranks by score.',
    inputSchema: {
      platforms: z.string().min(1).describe('Comma-separated platform IDs, e.g. "deepseek,aliyun,stepfun" (max 5)')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  async (args) => {
    try {
      const pfs = args.platforms.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
      if (!pfs.length) return errReply('validation', 'No valid platforms provided.',
        'Provide comma-separated platform IDs, e.g. "deepseek,aliyun"');

      /* Q04: Promise.all 并行 — 3×35s 串行→~35s */
      const results = await Promise.all(pfs.map(pf =>
        fetch(API_BASE + '/bench/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: API_KEY, platform: pf }),
          signal: AbortSignal.timeout(T.LONG)
        }).then(r => r.json())
          .then(d => d.code === 200 ? d.data : { platform: pf, status: 'error', error_msg: d.msg })
          .catch(e => ({ platform: pf, status: 'error', error_msg: e.message }))
      ));

      results.sort((a, b) => (b.score || 0) - (a.score || 0));
      const lines = results.map((r, i) =>
        `${i + 1}. ${r.platform}/${r.model_name || '?'} — ${r.score || '?'} pts ${r.latency_ms || '?'}ms`);
      return { content: [{ type: 'text', text: `⚡ Compare Results:\n${lines.join('\n')}` }] };
    } catch (e) {
      return errReply('network', e.message, '');
    }
  }
);

/* ═══════════════════════════════════════════════════════════════════
   步骤7: 健康检查
   ═══════════════════════════════════════════════════════════════════ */

/* ── mcshared_health_check ── */
server.registerTool(
  'mcshared_health_check',
  {
    description: 'Run a comprehensive platform health check: probe all platforms, show circuit breaker states, quota balances, and unhealthy platforms. Use to diagnose routing issues or verify platform availability.',
    inputSchema: {
      platform: z.string().optional().describe('Check a specific platform. Omit to check all.')
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async (args) => {
    try {
      let url = API_BASE + '/key-health?api_key=' + encodeURIComponent(API_KEY);
      if (args.platform) url += '&platform=' + encodeURIComponent(args.platform);
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const d = await r.json();
      if (d.code !== 200) return errReply('api', d.msg || String(d.code), '');

      const data = d.data || {};
      let text = '🩺 FreeModel Health\n\n';
      text += 'Gateway: ' + (data.mcp ? '🟢' : '⚫') + ' MCP | ' + (data.api ? '🟢' : '⚫') + ' API\n';
      text += 'Key platforms: ' + (data.platforms_available || 0) + '\n';
      if (data.subscriptions?.length) {
        text += '\n── Subscriptions ──\n';
        data.subscriptions.forEach(s => {
          text += '⭐ ' + s.platform + ' P' + s.priority + ' [' + (s.task_types || 'all') + ']';
          if (s.expires_at) text += ' expires ' + String(s.expires_at).slice(0, 10);
          text += '\n';
        });
      }
      try {
        const hr = await fetch(API_BASE + '/health/platforms', { signal: AbortSignal.timeout(T.SHORT) });
        const hd = await hr.json();
        if (hd.code === 200 && hd.data) {
          const platforms = Array.isArray(hd.data) ? hd.data : (hd.data.platforms || []);
          const down = platforms.filter(p => p.status === 'down');
          const degraded = platforms.filter(p => p.status === 'degraded');
          text += '\n── Platform Health ──\n';
          text += '🟢 ' + (platforms.length - down.length - degraded.length) + ' up';
          if (degraded.length) text += ' | 🟡 ' + degraded.length + ' degraded';
          if (down.length) text += ' | 🔴 ' + down.length + ' down';
          text += '\n';
          if (down.length) text += 'DOWN: ' + down.map(p => p.platform).join(', ') + '\n';
          if (degraded.length) text += 'DEGRADED: ' + degraded.map(p => p.platform).join(', ') + '\n';
        }
      } catch (e2) { /* optional */ }
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return errReply('network', e.message, '');
    }
  }
);

/* ═══════════════════════════════════════════════════════════════════
   步骤8: OmniRoute 工具 (2)
   ═══════════════════════════════════════════════════════════════════ */

/* ── mcshared_omni_models ── */
server.registerTool(
  'mcshared_omni_models',
  {
    description: 'List all models available through OmniRoute (99 auto/* models across 8 providers). Shows free models, provider breakdown, and pool health.',
    inputSchema: {
      filter: z.enum(['all', 'free', 'combo']).optional()
        .describe('Filter: all models, free only, or combo/auto models (default all)')
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async (args) => {
    try {
      const r = await fetch(OMNI_BASE + '/v1/models', { signal: AbortSignal.timeout(T.MID) });
      const d = await r.json();
      let models = d.data || [];
      const filter = args.filter || 'all';
      if (filter === 'free') models = models.filter(m => (m.id || '').includes(':free'));
      if (filter === 'combo') models = models.filter(m => (m.owned_by || '') === 'combo');

      const counts = {};
      models.forEach(m => { const p = m.owned_by || '?'; counts[p] = (counts[p] || 0) + 1; });

      let text = `🔮 OmniRoute Models (${models.length} total)\n\nProviders:\n`;
      Object.entries(counts).sort((a, b) => b[1] - a[1])
        .forEach(e => { text += `  ${e[0]}: ${e[1]} models\n`; });
      if (filter === 'all') text += '\nTry /v1/chat/completions with any auto/* model';
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return errReply('network', e.message, '');
    }
  }
);

/* ── mcshared_omni_providers ── */
server.registerTool(
  'mcshared_omni_providers',
  {
    description: 'Check OmniRoute provider pool health: which providers are active, excluded, exhausted. 54 providers in pool across free and combo tiers.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  },
  async () => {
    try {
      const r = await fetch(OMNI_BASE + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'auto/best-coding', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(30000)
      });
      const d = await r.json();
      const diag = d.diagnostics || {};
      let text = '🔮 OmniRoute Provider Pool\n\n';
      text += `Pool size: ${diag.poolSize || '?'}\n`;
      text += `Attempted: ${diag.attempted || '?'}\n`;
      if (diag.excluded?.length) {
        text += '\nExhausted providers:\n';
        diag.excluded.forEach(e => { text += `  🔴 ${e.reason}\n`; });
      }
      text += `\nTerminal: ${diag.terminalReason || 'none'}`;
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return errReply('network', e.message, '');
    }
  }
);

/* ═══════════════════════════════════════════════════════════════════
   步骤9: fire-and-forget 辅助函数
   ═══════════════════════════════════════════════════════════════════ */

function notifyTrack(task) {
  try {
    const desc = String(task || '').substring(0, 120).replace(/[\n\r]/g, ' ');
    fetch(MC_BASE + '/api/projects/freemodel/knowledge/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
      body: JSON.stringify({ description: desc, outcome: 'done' }),
      signal: AbortSignal.timeout(T.SHORT)
    }).catch(e => { process.stderr.write('[freemodel] track failed: ' + e.message + '\n'); });
  } catch (e) {
    process.stderr.write('[freemodel] track error: ' + e.message + '\n');
  }
}

function notifyDiscipline() {
  try {
    fetch(MC_BASE + '/api/discipline/refresh', {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY },
      signal: AbortSignal.timeout(T.SHORT)
    }).catch(e => { process.stderr.write('[freemodel] discipline refresh failed: ' + e.message + '\n'); });
  } catch (e) {
    process.stderr.write('[freemodel] discipline error: ' + e.message + '\n');
  }
}

/* ═══════════════════════════════════════════════════════════════════
   步骤10: Skill auto-install + Start
   ═══════════════════════════════════════════════════════════════════ */

function installSkill() {
  const skillDir = path.join(os.homedir(), '.claude', 'skills', 'freemodel');
  const skillFile = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillFile)) return;

  const src = path.join(__dirname, 'skill.md');
  if (!fs.existsSync(src)) return;

  try {
    fs.mkdirSync(skillDir, { recursive: true });
    fs.copyFileSync(src, skillFile);
    process.stderr.write('[freemodel] Skill installed: ' + skillFile + '\n');
  } catch (e) {
    /* silent — permission issues or read-only fs */
  }
}

async function main() {
  installSkill();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
