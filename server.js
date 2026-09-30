#!/usr/bin/env node
/* FreeModel MCP Server — international gateway (freemodel.online)
 *
 * 这一版只打国际站真实存在的接口，五个工具全部能被一个普通 key 走通：
 *   GET  /v1/models            免鉴权，公开目录（199 条，含模态与上下文长度）
 *   GET  /v1/tiers              需 key，三档（lite/standard/pro）与档内模型
 *   GET  /v1/me                 需 key，订阅、档位权限、用量
 *   POST /v1/chat/completions   需 key，OpenAI 格式对话
 *
 * 与 1.x 的区别：1.x 打的是 /api/gateway/agent/*，那套在国际站是 **BYOK-only**
 * （按账号绑定的 provider key 选模型，没绑就回 No platforms configured）。
 * 这里改成打国际站自己的产品面：档位别名 fm-v1-lite/standard/pro + 公开目录。
 *
 * 配置：FREEMODEL_KEY（在 freemodel.online/console 取）
 *       FREEMODEL_API（可选，默认 https://freemodel.online/v1）
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const z = require('zod');

const API_ROOT = String(process.env.FREEMODEL_API || 'https://freemodel.online/v1').replace(/\/+$/, '');
const API_KEY = process.env.FREEMODEL_KEY || '';
const TIMEOUT_MS = 30000;

const server = new McpServer(
  { name: 'freemodel-mcp', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

/* ── 统一请求：把 HTTP 层面的失败也翻成人能读的话 ──────────────── */
async function api(path, { method = 'GET', body, auth = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    if (!API_KEY) {
      return { ok: false, text: 'FREEMODEL_KEY is not set. Create a key at https://freemodel.online/console and put it in the server env.' };
    }
    headers['Authorization'] = 'Bearer ' + API_KEY;
  }
  let r;
  try {
    r = await fetch(API_ROOT + path, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (e) {
    return { ok: false, text: `Could not reach ${API_ROOT}${path} (${e.name === 'TimeoutError' ? 'timed out' : e.message}). Check FREEMODEL_API.` };
  }
  const raw = await r.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* 非 JSON：原样带出去 */ }
  if (!r.ok) {
    const detail = (json && ((json.error && json.error.message) || json.msg)) || raw.slice(0, 300);
    const hint = r.status === 401
      ? ' The key was rejected — check FREEMODEL_KEY, and that the email on the account has been verified.'
      : r.status === 404 ? ' Route not found — check FREEMODEL_API.' : '';
    return { ok: false, text: `HTTP ${r.status}: ${detail}${hint}` };
  }
  return { ok: true, json, raw };
}

const text = t => ({ content: [{ type: 'text', text: t }] });
const num = v => (v === null || v === undefined ? '—' : v);

/* ── 1. 目录：公开，不需要 key ─────────────────────────────── */
server.registerTool(
  'freemodel_models',
  {
    description: 'List the model catalogue on freemodel.online. Public endpoint, no API key needed. Filter by modality or search text.',
    inputSchema: {
      modality: z.enum(['chat', 'image', 'video', 'tts', 'asr', 'embedding', 'rerank']).optional()
        .describe('Only return this modality'),
      search: z.string().optional().describe('Only return ids containing this text'),
      limit: z.number().int().min(1).max(200).optional().describe('Max rows to print (default 40)')
    }
  },
  async ({ modality, search, limit }) => {
    const r = await api('/models');
    if (!r.ok) return text(r.text);
    const all = (r.json && r.json.data) || [];
    const byModality = {};
    for (const m of all) byModality[m.modality || '?'] = (byModality[m.modality || '?'] || 0) + 1;

    let rows = all;
    if (modality) rows = rows.filter(m => m.modality === modality);
    if (search) rows = rows.filter(m => String(m.id).includes(search));
    const shown = rows.slice(0, limit || 40);

    let out = `Catalogue: ${all.length} models — ` +
      Object.entries(byModality).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') + '\n';
    out += `Matching this filter: ${rows.length}${rows.length > shown.length ? ` (showing ${shown.length})` : ''}\n\n`;
    for (const m of shown) {
      out += `• ${m.id}  [${m.modality || '?'}${m.tier ? ', tier ' + m.tier : ''}` +
        `${m.context_length ? ', ' + m.context_length + ' ctx' : ''}]\n`;
    }
    out += '\nCall any id directly, or use a tier alias: fm-v1-lite (free), fm-v1-standard, fm-v1-pro.';
    return text(out);
  }
);

/* ── 2. 档位：需 key ─────────────────────────────────────── */
server.registerTool(
  'freemodel_tiers',
  {
    description: 'Show the three subscription tiers (lite / standard / pro): model counts, examples, and which ones this key is allowed to call.',
    inputSchema: {}
  },
  async () => {
    const r = await api('/tiers', { auth: true });
    if (!r.ok) return text(r.text);
    const rows = (r.json && r.json.data) || [];
    if (!rows.length) return text('The tiers endpoint returned nothing.');
    let out = 'Tiers (fm-v1-*):\n\n';
    for (const t of rows) {
      out += `• fm-v1-${t.tier}: ${num(t.own)} models in this band, ${num(t.total)} in total counting inherited ones\n`;
      if (t.examples && t.examples.length) out += `  examples: ${t.examples.slice(0, 4).join(', ')}\n`;
    }
    const mods = (r.json && r.json.modalities) || null;
    if (mods) {
      out += `\nNon-chat modalities are reachable by route, not by tier: ` +
        Object.entries(mods.byModality || {}).map(([k, v]) => `${k} ${v}`).join(', ') + '\n';
      out += 'Routes: ' + (mods.aliases || []).map(a => a.name).join(', ') + '\n';
    }
    out += '\nlite is free for any account; standard and pro need a subscription.';
    return text(out);
  }
);

/* ── 3. 账号：需 key ─────────────────────────────────────── */
server.registerTool(
  'freemodel_account',
  {
    description: 'Account status for this key: subscriptions and expiry, which tiers are callable, and usage so far.',
    inputSchema: {}
  },
  async () => {
    const r = await api('/me', { auth: true });
    if (!r.ok) return text(r.text);
    const d = r.json || {};
    let out = `Account: ${d.name || '(unnamed)'}   key ${d.key_masked || ''}\n`;

    const subs = d.subscriptions || {};
    const keys = Object.keys(subs);
    if (!keys.length) {
      out += 'Subscriptions: none — free tier only (fm-v1-lite).\n';
    } else {
      out += 'Subscriptions:\n';
      for (const k of keys) {
        const s = subs[k] || {};
        out += `• ${k}: ${s.active ? 'active' : 'expired'}` +
          (s.active && s.days_left != null ? `, ${s.days_left} days left` : '') +
          `${s.expires_at ? `, expires ${String(s.expires_at).slice(0, 10)}` : ''}\n`;
      }
    }

    const tiers = d.tiers || {};
    const allowed = Object.keys(tiers).filter(t => tiers[t] && tiers[t].allowed);
    out += `Callable tiers: ${allowed.length ? allowed.join(', ') : 'none'}\n`;

    const u = (d.usage && d.usage.total) || {};
    out += `Usage since ${d.since ? String(d.since).slice(0, 10) : '—'}: ` +
      `${num(u.calls)} calls, ${num(u.tokens)} tokens\n`;

    const mods = d.modalities || {};
    if (mods.total) out += `Modal endpoints available: ${mods.total}\n`;
    return text(out);
  }
);

/* ── 4. 对话：需 key ─────────────────────────────────────── */
server.registerTool(
  'freemodel_chat',
  {
    description: 'Send one prompt to the gateway and return the answer. Defaults to the free tier (fm-v1-lite); pass a concrete model id from freemodel_models to pin one.',
    inputSchema: {
      prompt: z.string().describe('The user message'),
      model: z.string().optional().describe('Model id or tier alias. Default fm-v1-lite'),
      system: z.string().optional().describe('Optional system prompt'),
      max_tokens: z.number().int().min(1).max(32000).optional().describe('Max output tokens (default 1024)')
    }
  },
  async ({ prompt, model, system, max_tokens }) => {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });

    const r = await api('/chat/completions', {
      method: 'POST', auth: true,
      body: { model: model || 'fm-v1-lite', messages, max_tokens: max_tokens || 1024 }
    });
    if (!r.ok) return text(r.text);

    const d = r.json || {};
    const choice = (d.choices && d.choices[0]) || {};
    const body = (choice.message && choice.message.content) || '(empty answer)';
    let out = body;
    if (d.usage) out += `\n\n— ${d.model || model || 'fm-v1-lite'}: ${d.usage.prompt_tokens || 0} in / ${d.usage.completion_tokens || 0} out`;
    if (choice.finish_reason && choice.finish_reason !== 'stop') out += ` (finish_reason: ${choice.finish_reason})`;
    return text(out);
  }
);

const transport = new StdioServerTransport();
server.connect(transport).catch((e) => {
  console.error('freemodel-mcp: failed to start —', e && e.message ? e.message : e);
  process.exit(1);
});
