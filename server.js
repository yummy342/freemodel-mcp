#!/usr/bin/env node
// FreeModel MCP Server — thin wrapper around FreeModel Agent API
// Usage: Add to Claude Code mcp.json, then use tools directly
// SDK v1.29.0 compatible: McpServer + registerTool + Zod

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const z = require('zod');
const fs = require('fs');
const path = require('path');

const SIGNAL_PATH = path.join(process.cwd(), '.freemodel_cleared');

const API_BASE = process.env.FREEMODEL_API || 'https://model.leyijian.com/api/gateway';
const API_KEY = process.env.FREEMODEL_KEY || '';

const server = new McpServer(
  { name: 'freemodel-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ── freemodel_key_health ──
server.registerTool(
  'freemodel_key_health',
  {
    description: 'Check API key health: subscription status, platform health, and recommended model. Use FIRST before task routing.',
    inputSchema: {}
  },
  async () => {
    if (!API_KEY) return { content: [{ type: 'text', text: 'Set FREEMODEL_KEY env var first.' }] };
    try {
      const r = await fetch(API_BASE + '/key-health?api_key=' + encodeURIComponent(API_KEY), {
        signal: AbortSignal.timeout(15000)
      });
      const d = await r.json();
      if (d.code !== 200) return { content: [{ type: 'text', text: 'Error: ' + (d.msg || d.code) }] };

      // Live key-health returns an object: {mcp, api, subscriptions[], platforms_available, recommend, top_platform}
      const data = d.data || {};
      const subs = Array.isArray(data.subscriptions) ? data.subscriptions : [];
      // API returns subscriptions array directly — no nested .recommend or .top_platform
      const sorted = [...subs].sort((a, b) => (a.priority || 99) - (b.priority || 99));
      const top = sorted[0] || null;
      const isSub = subs.length > 0;

      let text = `Key Health: ${data.mcp ? '🟢 MCP' : '⚫ MCP'} | API ok | ${data.platforms_available || 0} platform keys\n`;
      text += `Plan: ${isSub ? 'subscription' : 'free'}\n`;
      if (top) {
        text += `Top Subscription: ${top.platform} (priority ${top.priority})\n`;
        text += `Expires: ${top.expires_at || 'never'}\n`;
        text += `Task types: ${top.task_types || 'all'}\n`;
      }
      if (subs.length) {
        text += `\n--- All Subscriptions ---\n`;
        subs.sort((a, b) => (a.priority || 99) - (b.priority || 99))
          .forEach(s => { text += `• ${s.platform} (prio ${s.priority}${s.expires_at ? ', exp ' + s.expires_at : ', never'})\n`; });
      }

      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Network error: ' + e.message }] };
    }
  }
);

// ── freemodel_status ──
server.registerTool(
  'freemodel_status',
  {
    description: 'Get FreeModel session summary: active model, platform, subscription, healthy count.',
    inputSchema: {}
  },
  async () => {
    if (!API_KEY) return { content: [{ type: 'text', text: 'Set FREEMODEL_KEY env var first.' }] };
    try {
      const r = await fetch(API_BASE + '/key-health?api_key=' + encodeURIComponent(API_KEY), {
        signal: AbortSignal.timeout(15000)
      });
      const d = await r.json();
      if (d.code !== 200) return { content: [{ type: 'text', text: 'Error: ' + (d.msg || d.code) }] };

      const data = d.data || {};
      const subs = Array.isArray(data.subscriptions) ? data.subscriptions : [];
      const sorted = [...subs].sort((a, b) => (a.priority || 99) - (b.priority || 99));
      const top = sorted[0] || null;
      const isSub = subs.length > 0;

      let text = `── FreeModel Session ──\n`;
      text += `Plan: ${isSub ? 'subscription' : 'free'}\n`;
      text += `Subscriptions: ${subs.length ? subs.map(s => s.platform + '(P' + s.priority + ')').join(', ') : 'none'}\n`;
      text += `Active: ${top ? top.platform + ' (P' + top.priority + ')' : 'auto'}\n`;
      text += `Top expires: ${top?.expires_at || 'never'}\n`;
      text += `Keys: ${data.platforms_available || 0} platforms\n`;

      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Network error: ' + e.message }] };
    }
  }
);

// ── freemodel_models ──
server.registerTool(
  'freemodel_models',
  {
    description: 'List all AI models available to you across platforms. Returns platform and model names.',
    inputSchema: {}
  },
  async () => {
    if (!API_KEY) return { content: [{ type: 'text', text: 'Set FREEMODEL_KEY env var first. Get key from https://model.leyijian.com' }] };
    try {
      const r = await fetch(API_BASE + '/agent/models?api_key=' + encodeURIComponent(API_KEY));
      const d = await r.json();
      if (d.code !== 200) return { content: [{ type: 'text', text: 'Error: ' + (d.msg || d.code) }] };
      const platforms = d.data.platforms.join(', ');
      const lines = d.data.models.slice(0, 30).map(m => `${m.provider}: ${m.model_name} (${m.model_type})`).join('\n');
      return { content: [{ type: 'text', text: `Platforms: ${platforms}\n\nModels:\n${lines}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Network error: ' + e.message }] };
    }
  }
);

// ── freemodel_recommend ──
server.registerTool(
  'freemodel_recommend',
  {
    description: 'Recommend the best AI model for a given task. Analyzes your task and recommends 2-3 models with reasons.',
    inputSchema: { task: z.string().describe('Task description e.g. "写一个Python爬虫"') }
  },
  async (args) => {
    if (!API_KEY) return { content: [{ type: 'text', text: 'Set FREEMODEL_KEY env var first.' }] };
    try {
      const r = await fetch(API_BASE + '/agent/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: API_KEY, task: args.task })
      });
      const d = await r.json();
      if (d.code !== 200) return { content: [{ type: 'text', text: 'Error: ' + (d.msg || d.code) }] };
      const recs = d.data.recommendations.map((r, i) =>
        `${i + 1}. ${r.provider}/${r.model} — ${r.reason} (${r.price_note})`
      ).join('\n');
      return { content: [{ type: 'text', text: `Task: ${args.task}\n\nRecommendations:\n${recs}` }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Network error: ' + e.message }] };
    }
  }
);

// ── freemodel_route ── Auto-classify task → pick best model → execute
server.registerTool(
  'freemodel_route',
  {
    description: 'Auto-route a task: classify task type, pick the best model via scoring engine, execute it. One-step smart routing — no need to manually choose platform/model.',
    inputSchema: {
      task: z.string().describe('The task to execute'),
      system: z.string().optional().describe('System prompt (optional)'),
      temperature: z.number().optional().describe('Temperature (default 0.7)'),
      max_tokens: z.number().optional().describe('Max output tokens'),
      task_type: z.string().optional().describe('Force task type: coding/reasoning/writing/creative/chat/multimodal/longform/embedding. Auto-detected if omitted.'),
      preset: z.enum(['balanced','quality-first','budget','subscription']).optional().describe('Scoring preset (default balanced)')
    }
  },
  async (args) => {
    if (!API_KEY) return { content: [{ type: 'text', text: 'Set FREEMODEL_KEY env var first.' }] };
    try {
      // Step 1: Get recommendations
      var recBody = { api_key: API_KEY, task: args.task };
      if (args.task_type) recBody.task_type = args.task_type;
      if (args.preset) recBody.preset = args.preset;
      var recRes = await fetch(API_BASE + '/agent/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(recBody),
        signal: AbortSignal.timeout(15000)
      });
      var recData = await recRes.json();
      if (recData.code !== 200) return { content: [{ type: 'text', text: 'Recommend error: ' + (recData.msg || recData.code) }] };

      var picks = recData.data.recommendations || [];
      if (!picks.length) return { content: [{ type: 'text', text: 'No suitable model found for this task.' }] };

      var best = picks[0];
      var taskType = recData.data.task_type || 'chat';
      var taskTier = recData.data.task_tier || 'L2';

      // Step 2: Execute with best model
      var runBody = {
        api_key: API_KEY, platform: best.provider, model: best.model,
        system: args.system || '', task: args.task,
        temperature: args.temperature || 0.7,
        task_type: taskType
      };
      if (args.max_tokens != null) runBody.max_tokens = args.max_tokens;

      var runRes = await fetch(API_BASE + '/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(runBody),
        signal: AbortSignal.timeout(120000)
      });
      var runData = await runRes.json();
      if (runData.code !== 200) return { content: [{ type: 'text', text: 'Run error: ' + (runData.msg || runData.code) }] };

      var reply = runData.data.reply || '';
      var reasoning = runData.data.reasoning || '';
      var tierWarn = runData.data.tier_warn;

      // Build output with routing metadata
      var meta = `[Routed] ${taskType}/${taskTier} → ${best.provider}/${best.model} (score: ${best.composite}, tier: ${best.tier || 'N/A'})`;
      if (tierWarn) meta += `\n[Warning] ${tierWarn.msg}`;

      var text = meta + '\n\n';
      if (reasoning) text += '[Thinking]\n' + reasoning + '\n\n[Response]\n' + reply;
      else text += reply;

      // Signal cleared for downstream tools
      try { fs.writeFileSync(SIGNAL_PATH, String(Date.now())); } catch (e) {}
      return { content: [{ type: 'text', text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Network error: ' + e.message }] };
    }
  }
);

// ── freemodel_run ──
server.registerTool(
  'freemodel_run',
  {
    description: 'Execute a task using a specific AI model from a specific platform. Uses your stored API keys.',
    inputSchema: {
      platform: z.string().describe('Platform ID: "stepfun","baidu","zhipu","aliyun","silicon","openrouter" etc.'),
      model: z.string().describe('Model e.g. "step-3.7-flash"'),
      task: z.string().describe('The task to execute'),
      system: z.string().optional().describe('System prompt (optional)'),
      temperature: z.number().optional().describe('Temperature (default 0.7)'),
      max_tokens: z.number().optional().describe('Max output tokens. Default varies by platform. Set 4000+ for reasoning models to prevent empty output.'),
      reasoning_effort: z.enum(['low','medium','high']).optional().describe('Reasoning depth for step-3.7-flash. low=faster, high=deeper.')
    }
  },
  async (args) => {
    if (!API_KEY) return { content: [{ type: 'text', text: 'Set FREEMODEL_KEY env var first.' }] };
    try {
      var body = {
        api_key: API_KEY, platform: args.platform, model: args.model,
        system: args.system || '', task: args.task,
        temperature: args.temperature || 0.7
      };
      if (args.max_tokens != null) body.max_tokens = args.max_tokens;
      if (args.reasoning_effort) body.reasoning_effort = args.reasoning_effort;

      const r = await fetch(API_BASE + '/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (d.code !== 200) return { content: [{ type: 'text', text: 'Error: ' + (d.msg || d.code) }] };
      var reply = d.data.reply || '';
      var reasoning = d.data.reasoning || '';
      var text = reply;
      if (reasoning) text = '[Thinking]\n' + reasoning + '\n\n[Response]\n' + reply;
      // 路由成功：写 freemodel_cleared 信号，放行后续脑力工具 (R1.5)
      try { fs.writeFileSync(SIGNAL_PATH, String(Date.now())); } catch (e) {}
      return { content: [{ type: 'text', text: text }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Network error: ' + e.message }] };
    }
  }
);

// ── Start ──
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
