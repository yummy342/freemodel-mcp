#!/usr/bin/env node
// FreeModel MCP Server — thin wrapper around FreeModel Agent API
// Usage: Add to Claude Code mcp.json, then use tools directly
// SDK v1.29.0 compatible: McpServer + registerTool + Zod

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const z = require('zod');

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

      const sub = d.recommend || {};
      const isSub = sub.plan_type === 'subscription';
      const healthy = d.data.filter(p => p.status === 'healthy').length;
      const total = d.data.length;

      let text = `Key Health: ${healthy}/${total} platforms healthy\n`;
      text += `Plan: ${sub.plan_type || 'free'}\n`;
      if (isSub) {
        text += `Subscription: ${sub.preferred_platform} / ${sub.preferred_model}\n`;
        text += `Expires: ${sub.expires_at}\n`;
        text += `Task types: ${(sub.task_types || []).join(', ') || 'all'}\n`;
      }
      text += `\n--- Platform Status ---\n`;
      const statusMap = {};
      d.data.forEach(p => {
        const key = p.platform;
        if (!statusMap[key] || p.status === 'healthy') statusMap[key] = p;
      });
      Object.entries(statusMap).forEach(([name, p]) => {
        const subMark = p.is_subscription ? ' [订阅]' : '';
        text += `${p.status === 'healthy' ? '🟢' : p.status === 'degraded' ? '🟡' : p.status === 'error' ? '🔴' : '⚫'} ${name}${subMark}: ${p.status}${p.msg ? ' (' + p.msg + ')' : ''}\n`;
      });

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

      const sub = d.recommend || {};
      const healthy = d.data.filter(p => p.status === 'healthy');

      let text = `── FreeModel Session ──\n`;
      text += `Plan: ${sub.plan_type || 'free'}\n`;
      text += `Active: ${sub.preferred_model || 'auto'} @ ${sub.preferred_platform || 'best'}\n`;
      text += `Expires: ${sub.expires_at || 'N/A'}\n`;
      text += `Healthy: ${healthy.length}/${d.data.length} platforms\n`;

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