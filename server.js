'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

// 读取项目根目录的 .env（零依赖）：在 .env 里填 Key 后重启服务即可，系统环境变量优先
function loadEnvFile(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq <= 0) continue;
      const key = s.slice(0, eq).trim();
      let val = s.slice(eq + 1).trim();
      if ((val[0] === '"' && val.slice(-1) === '"') || (val[0] === "'" && val.slice(-1) === "'")) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[env]', e.message);
  }
}
loadEnvFile(path.join(ROOT, '.env'));

// 数据目录：云平台通过 DATA_DIR 指向持久卷，统一转成绝对路径
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const PRESETS = { lite: 'graph.json', full: 'graph-full.json' };
const PORT = Number(process.env.PORT) || 8787;
const MAX_BODY = 8 * 1024 * 1024;
const WRITE_TOKEN = process.env.WRITE_TOKEN || '';

// 访问门禁：账号密码只从环境变量（或 .env）读取，绝不硬编码、不下发前端
const SITE_USER = process.env.SITE_USER || 'admin';
const SITE_PASS = process.env.SITE_PASS || '';
const AUTH_ENABLED = !!SITE_PASS;
const AUTH_REALM = 'Private Diary';

// 大模型配置：Key 只从环境变量读取，绝不下发到前端
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_API_URL = process.env.LLM_API_URL || 'https://api.deepseek.com/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat';
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 60000;
// AI 可分配的实体分层，与 index.html 的 TEMPLATE.layers 保持一致
const AI_LAYERS = ['activity', 'body', 'emotion', 'people', 'knowledge', 'goal'];
// 模型偶尔会返回中文分层名，统一映射回英文 id，避免全部落到「日常活动」
const LAYER_ALIAS = {
  '日常活动': 'activity', '活动': 'activity', '生活琐事': 'activity', '工作事务': 'activity',
  '身体状态': 'body', '生理状态': 'body',
  '情绪暗流': 'emotion', '情绪': 'emotion', '情绪波动': 'emotion',
  '人际互动': 'people', '人际': 'people', '人物': 'people', '关系': 'people', '人际张力': 'people',
  '认知沉淀': 'knowledge', '认知': 'knowledge', '知识': 'knowledge',
  '未来锚点': 'goal', '目标': 'goal', '未来': 'goal'
};

// 把日记拆成 2-4 个带语境的事件短语，并强制分配到生活化分层
const LLM_USER_PROMPT = (text) => `你是一个个人生活记忆图谱的提取工具。请阅读以下日记，提取出 2-4 个核心实体，并识别它们之间的关系。
【核心规则】：
1. 不要提取干瘪的泛化标签（例如“失眠”“工作”“家务”“焦虑”）。
2. 必须结合这篇日记的具体语境，提取「带定语的短句或事件短语」，长度 6-14 个字，包含时间、程度、对象或因果线索，让它只属于这一次经历。
   示例：日记写“上夜班后一晚上睡不着” → 提取“夜班后整夜失眠”，不要提取“失眠”。
   示例：日记写“天亮前洗了衣服” → 提取“天亮前独自洗衣服”，不要提取“家务”。
3. links 里的 rel 必须是具体关系词，例如：导致、引发、加剧、缓解、改善、属于、矛盾、回避、依赖、触发；禁止使用“关联”“有关”这类空泛词。
4. 每个节点都必须分配 layer，并尽量给出 meta（2-6 字的固定分类名），用于把同类事件收拢到一个大节点。
   layer 只能取：activity（日常活动）、body（身体状态）、emotion（情绪暗流）、people（人际互动）、knowledge（认知沉淀）、goal（未来锚点）。
   日记中出现具体人物，或出现对话、交流、关系时，至少有一个节点归入 people，标签要包含人物名和事件，不要只写泛化关系。
   可选 meta：生理状态、工作事务、人际张力、情绪波动、生活琐事、认知收获。
5. 绝对不要包含任何 markdown 代码块符号（如 \`\`\`json ），只返回纯净的 JSON 字符串。

JSON 格式要求：
{
  "nodes": [
    {"label": "夜班后整夜失眠", "layer": "body", "meta": "生理状态"},
    {"label": "天亮前独自洗衣服", "layer": "activity", "meta": "生活琐事"}
  ],
  "links": [
    {"source": "夜班后整夜失眠", "target": "天亮前独自洗衣服", "rel": "导致"}
  ]
}

日记内容：
${text}
`;


fs.mkdirSync(DATA_DIR, { recursive: true });

function presetFile(name) {
  const file = PRESETS[name] || PRESETS.lite;
  return { data: path.join(DATA_DIR, file), bak: path.join(DATA_DIR, file + '.bak') };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function send(res, code, body, type) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': type || MIME['.json'],
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function authorized(req) {
  if (!WRITE_TOKEN) return true;
  return req.headers['x-write-token'] === WRITE_TOKEN;
}

// HTTP Basic Auth 门禁：校验 Authorization 头里的 用户名:密码
function basicAuthOk(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  let creds = '';
  try {
    creds = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  } catch (e) {
    return false;
  }
  const idx = creds.indexOf(':');
  if (idx < 0) return false;
  return creds.slice(0, idx) === SITE_USER && creds.slice(idx + 1) === SITE_PASS;
}

function denyAuth(res, msg) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="' + AUTH_REALM + '"',
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(msg);
}

// 判断 target 是否位于 root 目录内（Windows 下不区分大小写）
function isInside(target, root) {
  const t = process.platform === 'win32' ? target.toLowerCase() : target;
  const r = process.platform === 'win32' ? root.toLowerCase() : root;
  return t === r || t.startsWith(r + path.sep);
}

async function readGraph(file) {
  const txt = await fs.promises.readFile(file, 'utf8');
  return JSON.parse(txt);
}

async function rotateBackup(file, bak) {
  try {
    await fs.promises.copyFile(file, bak);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[backup]', e.message);
  }
}

async function writeGraph(file, graph) {
  const tmp = file + '.tmp-' + process.pid;
  await fs.promises.writeFile(tmp, JSON.stringify(graph, null, 2), 'utf8');
  try { await fs.promises.rename(tmp, file); }
  catch (e) {
    if (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES') {
      await fs.promises.rm(file, { force: true });
      await fs.promises.rename(tmp, file);
    } else {
      await fs.promises.rm(tmp, { force: true });
      throw e;
    }
  }
}

function validGraph(g) {
  if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return '缺少 nodes / edges';
  if (g.nodes.length < 1 || g.nodes.length > 5000) return '节点数量超出范围';
  const ids = new Set();
  for (const n of g.nodes) {
    if (!n || typeof n.id !== 'string' || typeof n.title !== 'string' || typeof n.cat !== 'string') return '节点字段不合法';
    if (ids.has(n.id)) return '节点 id 重复：' + n.id;
    ids.add(n.id);
  }
  if (!ids.has('hub')) return '缺少中枢节点 hub';
  for (const e of g.edges) {
    if (!Array.isArray(e) || e.length < 2) return '连线格式不合法';
    if (!ids.has(e[0]) || !ids.has(e[1])) return '连线指向不存在的节点';
    if (e[0] === e[1]) return '连线不能自环';
  }
  return '';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// 清理模型输出：去掉 BOM、Markdown 代码围栏，再截取最外层 JSON
function cleanLLMJson(raw) {
  let s = String(raw || '').trim().replace(/^\uFEFF/, '');
  s = s.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

function normalizeAIParse(obj) {
  if (!obj || !Array.isArray(obj.nodes)) throw new Error('AI 返回缺少 nodes 数组');
  const seen = {};
  const nodes = [];
  obj.nodes.forEach((n) => {
    let label = '';
    let layer = '';
    let meta = '';
    if (typeof n === 'string') {
      label = n.trim().slice(0, 20);
    } else if (n && typeof n === 'object') {
      label = String(n.label || '').trim().slice(0, 20);
      layer = String(n.layer || '').trim().toLowerCase();
      layer = LAYER_ALIAS[layer] || layer;
      meta = String(n.meta || '').trim().slice(0, 8);
    }
    if (!label || seen[label] || nodes.length >= 4) return;
    // 模型给的分层不在白名单时，统一落到「日常活动」，保证前端一定有合法 cat
    if (AI_LAYERS.indexOf(layer) < 0) layer = 'activity';
    seen[label] = 1;
    nodes.push({ label, layer, meta: meta || null });
  });
  if (!nodes.length) throw new Error('AI 没有提取到有效实体');
  const labels = nodes.map((n) => n.label);
  const links = (Array.isArray(obj.links) ? obj.links : [])
    .filter((l) => l && labels.includes(l.source) && labels.includes(l.target) && l.source !== l.target)
    .map((l) => ({ source: l.source, target: l.target, rel: String(l.rel || '关联').trim().slice(0, 8) }))
    .slice(0, 8);
  return { nodes, links };
}

async function callLLM(text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  try {
    const resp = await fetch(LLM_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + LLM_API_KEY
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0.2,
        messages: [
          { role: 'user', content: LLM_USER_PROMPT(text) }
        ]
      }),
      signal: ctrl.signal
    });
    const raw = await resp.text();
    if (!resp.ok) throw new Error('大模型接口 HTTP ' + resp.status + '：' + raw.slice(0, 180));
    let data;
    try { data = JSON.parse(raw); } catch (e) { throw new Error('大模型返回的不是 JSON'); }
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('大模型没有返回内容');
    return normalizeAIParse(cleanLLMJson(content));
  } finally {
    clearTimeout(timer);
  }
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // 数据目录与隐藏文件（如 .env）一律不通过静态服务下发，只走 /api/graph
  if (rel.includes('..') || rel.startsWith('.') || rel.startsWith('data/')) return send(res, 404, { error: 'not found' });
  const file = path.resolve(ROOT, rel);
  if (!isInside(file, ROOT) || isInside(file, path.resolve(DATA_DIR))) return send(res, 404, { error: 'not found' });
  try {
    const st = await fs.promises.stat(file);
    if (!st.isFile()) return send(res, 404, { error: 'not found' });
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, 404, { error: 'not found' });
  }
}

const server = http.createServer(async (req, res) => {
  // 1. 访问门禁：所有请求（页面 + API）先过 Basic Auth
  if (AUTH_ENABLED && !basicAuthOk(req)) {
    return denyAuth(res, 'Access Denied');
  }

  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method || 'GET';

  const preset = url.searchParams.get('preset') || 'lite';
  if (preset !== 'lite' && preset !== 'full') {
    return send(res, 400, { error: '未知版本：' + preset });
  }
  const files = presetFile(preset);

  if (pathname === '/health') {
    return send(res, 200, {
      ok: true,
      saved: fs.existsSync(files.data),
      lite: fs.existsSync(presetFile('lite').data),
      full: fs.existsSync(presetFile('full').data)
    });
  }

  if (pathname === '/api/ai-parse') {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return send(res, 405, { error: '不支持的方法' });
    }
    if (!LLM_API_KEY) {
      return send(res, 500, { error: '服务器未配置 LLM_API_KEY，请在项目根目录的 .env 中填写后重启服务' });
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      if (e.code === 'TOO_LARGE') return send(res, 413, { error: '请求体过大' });
      return send(res, 400, { error: 'JSON 解析失败' });
    }
    const text = body && typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return send(res, 400, { error: '日记内容不能为空' });
    if (text.length > 6000) return send(res, 400, { error: '日记太长，请控制在 6000 字以内' });
    try {
      const result = await callLLM(text);
      return send(res, 200, result);
    } catch (e) {
      const msg = e && e.name === 'AbortError' ? 'AI 解析超时，请稍后重试' : (e.message || 'AI 解析失败');
      console.error('[ai-parse]', msg);
      return send(res, 500, { error: msg });
    }
  }

  // 日记原文备份：追加写入 data/diary_log.md，只用 Node 内置 fs
  if (pathname === '/api/save-diary-txt') {
    if (method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return send(res, 405, { error: '不支持的方法' });
    }
    if (!authorized(req)) return send(res, 401, { error: '写入令牌不正确' });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      if (e.code === 'TOO_LARGE') return send(res, 413, { error: '请求体过大' });
      return send(res, 400, { error: 'JSON 解析失败' });
    }
    const content = body && typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) return send(res, 400, { error: '日记内容不能为空' });
    if (content.length > 20000) return send(res, 400, { error: '日记太长，无法备份' });
    const dateText = (body && typeof body.date === 'string' && body.date.trim()) ? body.date.trim() : new Date().toISOString();
    const tags = (body && Array.isArray(body.tags) ? body.tags : [])
      .map((t) => String(t || '').trim())
      .filter(Boolean)
      .slice(0, 20);
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const block = [
        '',
        '----------------------------------------',
        '### 📅 [' + dateText + ']',
        '**正文**：' + content,
        '**实体标签**：' + (tags.length ? tags.join('、') : '无'),
        '----------------------------------------',
        ''
      ].join('\n');
      await fs.promises.appendFile(path.join(DATA_DIR, 'diary_log.md'), block, 'utf8');
      return send(res, 200, { ok: true, file: 'data/diary_log.md' });
    } catch (e) {
      console.error('[diary-txt]', e.message);
      return send(res, 500, { error: '日记备份写入失败' });
    }
  }

  if (pathname === '/api/graph') {
    try {
      if (method === 'GET') {
        if (!fs.existsSync(files.data)) return send(res, 404, { error: '尚未保存' });
        return send(res, 200, await readGraph(files.data));
      }
      if (method === 'PUT') {
        if (!authorized(req)) return send(res, 401, { error: '写入令牌不正确' });
        let graph;
        try {
          graph = JSON.parse(await readBody(req));
        } catch (e) {
          if (e.code === 'TOO_LARGE') return send(res, 413, { error: '请求体过大' });
          return send(res, 400, { error: 'JSON 解析失败' });
        }
        const bad = validGraph(graph);
        if (bad) return send(res, 400, { error: bad });
        await rotateBackup(files.data, files.bak);
        await writeGraph(files.data, graph);
        return send(res, 200, { ok: true, preset: preset, nodes: graph.nodes.length, edges: graph.edges.length, savedAt: new Date().toISOString() });
      }
      if (method === 'DELETE') {
        if (!authorized(req)) return send(res, 401, { error: '写入令牌不正确' });
        if (fs.existsSync(files.data)) {
          await rotateBackup(files.data, files.bak);
          await fs.promises.rm(files.data, { force: true });
        }
        return send(res, 200, { ok: true, preset: preset, reset: true });
      }
      res.setHeader('Allow', 'GET, PUT, DELETE');
      return send(res, 405, { error: '不支持的方法' });
    } catch (e) {
      console.error('[api]', e);
      return send(res, 500, { error: '服务器内部错误' });
    }
  }

  if (method === 'GET' || method === 'HEAD') return serveStatic(req, res, pathname);
  send(res, 405, { error: '不支持的方法' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('记忆海-镜子已启动  http://localhost:' + PORT + '（监听 0.0.0.0）');
  console.log('数据文件  ' + presetFile('lite').data);
  console.log('全量文件  ' + presetFile('full').data + (WRITE_TOKEN ? '（已启用写入令牌）' : ''));
  console.log('AI 解析  ' + (LLM_API_KEY ? LLM_MODEL + ' @ ' + LLM_API_URL : '未配置 LLM_API_KEY（可在 .env 中填写，/api/ai-parse 不可用）'));
  if (AUTH_ENABLED) {
    console.log('访问门禁  已启用（用户名 ' + SITE_USER + '，密码来自 SITE_PASS）');
  } else {
    console.warn('');
    console.warn('⚠️  警告：未设置 SITE_PASS，访问门禁处于「关闭」状态。');
    console.warn('    当前任何人访问本服务都能看到全部日记与图谱。');
    console.warn('    请在 .env 或部署平台的环境变量中设置 SITE_PASS=你的强密码，然后重启服务。');
    console.warn('');
  }
});
