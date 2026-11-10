'use strict';

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
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
const AI_LAYERS = ['activity', 'body', 'emotion', 'people', 'knowledge', 'goal', 'dream'];
// 模型偶尔会返回中文分层名，统一映射回英文 id，避免全部落到「日常活动」
const LAYER_ALIAS = {
  '日常活动': 'activity', '活动': 'activity', '生活琐事': 'activity', '工作事务': 'activity',
  '身体状态': 'body', '生理状态': 'body',
  '情绪暗流': 'emotion', '情绪': 'emotion', '情绪波动': 'emotion',
  '人际互动': 'people', '人际': 'people', '人物': 'people', '关系': 'people', '人际张力': 'people',
  '认知沉淀': 'knowledge', '认知': 'knowledge', '知识': 'knowledge',
  '未来锚点': 'goal', '目标': 'goal', '未来': 'goal',
  '梦境': 'dream', '梦': 'dream', '梦中': 'dream', '清明梦': 'dream'
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
   layer 只能取：activity（日常活动）、body（身体状态）、emotion（情绪暗流）、people（人际互动）、knowledge（认知沉淀）、goal（未来锚点）、dream（梦境）。
   日记中出现具体人物，或出现对话、交流、关系时，至少有一个节点归入 people，标签要包含人物名和事件，不要只写泛化关系。
   日记内容如果是梦、梦境片段、睡梦中的场景或情绪，至少有一个节点必须归入 dream，标签要写清梦里的地点、人物或情节。
   可选 meta：生理状态、工作事务、人际张力、情绪波动、生活琐事、认知收获、梦境片段。
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

// ===== 登录会话：Cookie + 12 小时免登（不再用 Basic Auth 弹窗）=====
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_COOKIE = 'msm_sess';
const sessions = new Map(); // token -> 过期时间戳

function sessionToken(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === SESSION_COOKIE) return part.slice(i + 1).trim();
  }
  return '';
}

function sessionOk(req) {
  const t = sessionToken(req);
  if (!t) return false;
  const exp = sessions.get(t);
  if (!exp) return false;
  if (exp <= Date.now()) {
    sessions.delete(t);
    return false;
  }
  return true;
}

function newSession() {
  const t = crypto.randomBytes(24).toString('hex');
  sessions.set(t, Date.now() + SESSION_TTL_MS);
  if (sessions.size > 2000) {
    const now = Date.now();
    for (const [k, v] of sessions) if (v <= now) sessions.delete(k);
  }
  return t;
}

// 未登录访问页面时下发的登录页（与站点同风格，不依赖浏览器弹窗）
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>记忆海-镜子 · 登录</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:
    radial-gradient(900px 600px at 20% 10%, rgba(90,120,255,.12), transparent 62%),
    radial-gradient(800px 500px at 82% 92%, rgba(255,140,60,.07), transparent 60%), #05060a;
    color:#e8ecf4;font:400 14px/1.6 "PingFang SC","Microsoft YaHei",system-ui,sans-serif;padding:24px}
  .card{width:100%;max-width:330px;padding:26px 24px;border:1px solid rgba(255,255,255,.1);border-radius:14px;
    background:rgba(14,17,26,.86);box-shadow:0 24px 60px rgba(0,0,0,.5)}
  h1{margin:0 0 4px;font-size:17px;letter-spacing:.08em;font-weight:600}
  p{margin:0 0 20px;font-size:11px;color:#5c6477;letter-spacing:.16em}
  label{display:block;font-size:12px;color:#8e97ab;margin-bottom:6px}
  input{width:100%;padding:9px 11px;margin-bottom:14px;border-radius:8px;border:1px solid rgba(255,255,255,.14);
    background:rgba(255,255,255,.04);color:#e8ecf4;font:400 13px/1.4 inherit;outline:none}
  input:focus{border-color:rgba(120,160,255,.55);box-shadow:0 0 0 3px rgba(90,130,255,.1)}
  button{width:100%;padding:10px;border-radius:8px;border:1px solid rgba(255,210,120,.5);
    background:rgba(255,190,90,.12);color:#ffe2a0;font:500 13px/1 inherit;letter-spacing:.06em;cursor:pointer}
  button:hover{background:rgba(255,190,90,.2)}
  button:disabled{opacity:.5;cursor:default}
  .err{min-height:18px;margin-top:12px;font-size:12px;color:#ff8d8d}
</style>
</head>
<body>
<form class="card" id="f" autocomplete="on">
  <h1>记忆海-镜子</h1>
  <p>MEMORY SEA · MIRROR</p>
  <label for="u">账号</label>
  <input id="u" name="user" type="text" autocomplete="username" required>
  <label for="p">密码</label>
  <input id="p" name="pass" type="password" autocomplete="current-password" required>
  <button type="submit" id="b">进入星云</button>
  <div class="err" id="e"></div>
</form>
<script>
(function () {
  var f = document.getElementById('f'), b = document.getElementById('b'), e = document.getElementById('e');
  f.addEventListener('submit', function (ev) {
    ev.preventDefault();
    b.disabled = true; e.textContent = '';
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ user: document.getElementById('u').value, pass: document.getElementById('p').value })
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { s: r.status, j: j }; }); })
      .then(function (x) {
        if (x.s === 200 && x.j.ok) { location.replace('/'); return; }
        e.textContent = x.j.error || ('登录失败（' + x.s + '）');
        b.disabled = false;
      })
      .catch(function () { e.textContent = '网络异常，请重试'; b.disabled = false; });
  });
})();
<\/script>
</body>
</html>`;

function sendLoginPage(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(LOGIN_HTML);
}

// 登录失败限流：同一 IP 15 分钟内错 5 次，锁定 15 分钟，防止无限爆破
const AUTH_MAX_FAILS = 5;
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const authFails = new Map();

// 取客户端 IP：优先反向代理注入的 x-real-ip，其次 x-forwarded-for 首段
function clientIp(req) {
  const real = req.headers['x-real-ip'];
  if (real) return String(real).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// 返回剩余锁定毫秒数，0 表示未锁定
function authBlockedMs(ip) {
  const rec = authFails.get(ip);
  if (!rec || !rec.blockedUntil) return 0;
  const left = rec.blockedUntil - Date.now();
  if (left <= 0) {
    authFails.delete(ip);
    return 0;
  }
  return left;
}

function noteAuthFail(ip, sig) {
  const now = Date.now();
  let rec = authFails.get(ip);
  if (!rec || now - rec.since > AUTH_WINDOW_MS) rec = { count: 0, since: now, blockedUntil: 0, seen: new Map() };
  // 同一组错误凭证重复请求（浏览器缓存旧密码时一次刷新会连打好几个请求）只算一次
  if (sig) {
    if (rec.seen.has(sig)) {
      authFails.set(ip, rec);
      return;
    }
    rec.seen.set(sig, now);
    if (rec.seen.size > 60) rec.seen.clear();
  }
  rec.count += 1;
  if (rec.count >= AUTH_MAX_FAILS) rec.blockedUntil = now + AUTH_WINDOW_MS;
  authFails.set(ip, rec);
  // 防止长期运行后 Map 无限增长
  if (authFails.size > 5000) {
    for (const [k, v] of authFails) {
      if (!v.blockedUntil || v.blockedUntil <= now) authFails.delete(k);
    }
  }
}

function clearAuthFail(ip) {
  authFails.delete(ip);
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

// 归档备份：把当前图谱另存到 data/backups/<名称>-YYYYMMDD-HHmmss.json
// 用于「导入全量覆盖」等破坏性写入，避免只留一份会被下次保存覆盖的 .bak
async function archiveBackup(file) {
  try {
    if (!fs.existsSync(file)) return '';
    const dir = path.join(DATA_DIR, 'backups');
    await fs.promises.mkdir(dir, { recursive: true });
    const d = new Date();
    const p = (v) => ('0' + v).slice(-2);
    const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    const name = path.basename(file, '.json') + '-' + stamp + '.json';
    const target = path.join(dir, name);
    await fs.promises.copyFile(file, target);
    return name;
  } catch (e) {
    console.error('[archive]', e.message);
    return '';
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
  const rawPath = req.url.split('?')[0];

  // 0. 登出：销毁会话并清 Cookie，页面刷新后回到登录页
  if (rawPath === '/api/logout') {
    const t = sessionToken(req);
    if (t) sessions.delete(t);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': SESSION_COOKIE + '=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  // 0.1 登录：校验账号密码，成功则种下 12 小时会话 Cookie
  if (rawPath === '/api/login') {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return send(res, 405, { error: '不支持的方法' });
    }
    const ip = clientIp(req);
    const waitMs = authBlockedMs(ip);
    if (waitMs > 0) {
      res.writeHead(429, {
        'Retry-After': String(Math.ceil(waitMs / 1000)),
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      return res.end(JSON.stringify({ error: '尝试次数过多，请 ' + Math.ceil(waitMs / 60000) + ' 分钟后再试' }));
    }
    const raw = await readBody(req);
    let user = '';
    let pass = '';
    if (/^application\/json/i.test(req.headers['content-type'] || '')) {
      try {
        const j = JSON.parse(raw);
        user = String(j.user || '');
        pass = String(j.pass || '');
      } catch (e) { /* 非法 JSON 按空凭证处理 */ }
    } else {
      const p = new URLSearchParams(raw);
      user = p.get('user') || '';
      pass = p.get('pass') || '';
    }
    if (!AUTH_ENABLED) return send(res, 200, { ok: true });
    if (user !== SITE_USER || pass !== SITE_PASS) {
      noteAuthFail(ip, crypto.createHash('sha1').update(user + ':' + pass).digest('hex'));
      return send(res, 401, { error: '账号或密码错误' });
    }
    clearAuthFail(ip);
    const token = newSession();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Set-Cookie': SESSION_COOKIE + '=' + token + '; Path=/; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000) + '; HttpOnly; SameSite=Lax'
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  // 1. 访问门禁：会话有效放行；未登录时页面给登录页、API 给 401
  if (AUTH_ENABLED && !sessionOk(req)) {
    if (rawPath.startsWith('/api/') || rawPath === '/health') {
      return send(res, 401, { error: '未登录', needLogin: true });
    }
    return sendLoginPage(res);
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
        // backup=1：破坏性写入（如导入全量覆盖）前先归档当前图谱
        const archived = url.searchParams.get('backup') === '1' ? await archiveBackup(files.data) : '';
        await rotateBackup(files.data, files.bak);
        await writeGraph(files.data, graph);
        return send(res, 200, { ok: true, preset: preset, nodes: graph.nodes.length, edges: graph.edges.length, backup: archived || null, savedAt: new Date().toISOString() });
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
