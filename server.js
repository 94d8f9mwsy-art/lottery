'use strict';

/**
 * 抽签排序 —— 零依赖 Node.js 单端口服务
 * - JSON 文件持久化
 * - 号码墙 / 抽签 / 填名字
 * - 管理员：预指定号码、抽签开关、一键清零
 * - 成员之间：双方确认后互换号码
 * - SSE 实时推送
 */

const http = require('http');
const fs = require('fs');
const net = require('net');
const tls = require('tls');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const CLAIM_TTL = 180 * 1000; // 抽到号码后，留给填写名字的时间
// 初始管理员密码：优先取 ADMIN_PASSWORD 环境变量（这样密码不会出现在公开仓库的源码里）；
// 两者都没有时随机生成一次，只在首次建库的启动日志里打印。
const ENV_ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const INITIAL_ADMIN_PASSWORD = ENV_ADMIN_PASSWORD || crypto.randomBytes(4).toString('hex');

/* ------------------------------------------------------------------ */
/* 存储                                                                */
/* ------------------------------------------------------------------ */

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function defaultDb() {
  return {
    version: 1,
    secret: crypto.randomBytes(24).toString('hex'),
    title: '抽签排序',
    subtitle: '每人一个不重复的号',
    total: 14,
    locked: false,
    adminHash: sha256(INITIAL_ADMIN_PASSWORD),
    draws: [], // { id, name, num, token, ts }
    assignments: {}, // num(字符串) -> name
    claims: [], // { id, num, ts }
    swaps: [], // { id, fromId, toId, fromNum, toNum, ts }
    createdAt: Date.now(),
  };
}

let db;

/* ---------- 可选 Redis 存储 ----------
 * 线上免费实例（如 Render Free）硬盘是临时的，服务休眠重启会清空。
 * 配了 REDIS_URL 就把状态存到 Redis；没配则退回本地文件。 */

const STATE_KEY = 'lottery:state';
const REDIS_URL = process.env.REDIS_URL || '';
let redis = null;
let writeChain = Promise.resolve();

function createRedisClient(urlStr) {
  const u = new URL(urlStr);
  const useTls = u.protocol === 'rediss:';
  const host = u.hostname;
  const port = Number(u.port) || 6379;
  const password = u.password ? decodeURIComponent(u.password) : '';
  const username = u.username ? decodeURIComponent(u.username) : '';

  function encode(args) {
    let out = '*' + args.length + '\r\n';
    for (const a of args) {
      const s = String(a);
      out += '$' + Buffer.byteLength(s, 'utf8') + '\r\n' + s + '\r\n';
    }
    return out;
  }

  function connect() {
    return new Promise((resolve, reject) => {
      const sock = useTls ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
      const ready = useTls ? 'secureConnect' : 'connect';
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('Redis 连接超时'));
      }, 10000);
      sock.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      sock.once(ready, () => {
        clearTimeout(timer);
        resolve(sock);
      });
    });
  }

  function exec(sock, args) {
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const cleanup = () => {
        sock.off('data', onData);
        sock.off('error', onErr);
        sock.off('close', onClose);
      };
      const onErr = (e) => {
        cleanup();
        reject(e);
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Redis 连接已关闭'));
      };
      function parse() {
        if (buf.length < 1) return null;
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return null;
        const type = String.fromCharCode(buf[0]);
        const line = buf.slice(1, nl).toString('utf8');
        if (type === '+') {
          buf = buf.slice(nl + 2);
          return { val: line };
        }
        if (type === '-') {
          buf = buf.slice(nl + 2);
          return { err: line };
        }
        if (type === ':') {
          buf = buf.slice(nl + 2);
          return { val: Number(line) };
        }
        if (type === '$') {
          const len = Number(line);
          if (len === -1) {
            buf = buf.slice(nl + 2);
            return { val: null };
          }
          if (buf.length < nl + 2 + len + 2) return null;
          const val = buf.slice(nl + 2, nl + 2 + len).toString('utf8');
          buf = buf.slice(nl + 2 + len + 2);
          return { val };
        }
        throw new Error('无法解析的 Redis 回复');
      }
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        let out;
        try {
          out = parse();
        } catch (e) {
          cleanup();
          reject(e);
          return;
        }
        if (!out) return;
        cleanup();
        if (out.err) reject(new Error(out.err));
        else resolve(out.val);
      };
      sock.on('data', onData);
      sock.on('error', onErr);
      sock.on('close', onClose);
      sock.write(encode(args));
    });
  }

  async function cmd(args) {
    const sock = await connect();
    try {
      if (password) await exec(sock, username ? ['AUTH', username, password] : ['AUTH', password]);
      return await exec(sock, args);
    } finally {
      sock.destroy();
    }
  }

  return {
    ping: () => cmd(['PING']),
    async get(key) {
      const v = await cmd(['GET', key]);
      if (!v) return null;
      try {
        return JSON.parse(v);
      } catch (e) {
        return null;
      }
    },
    async set(key, value) {
      await cmd(['SET', key, JSON.stringify(value)]);
    },
  };
}

function normalizeDb() {
  if (!db.secret) db.secret = crypto.randomBytes(24).toString('hex');
  if (!db.assignments) db.assignments = {};
  if (!db.draws) db.draws = [];
  if (!db.claims) db.claims = [];
  if (!db.swaps) db.swaps = [];
  if (typeof db.total !== 'number') db.total = 14;
  if (!db.adminHash) db.adminHash = sha256(INITIAL_ADMIN_PASSWORD);
  if (typeof db.version !== 'number') db.version = 1;
}

function loadDb() {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    db = defaultDb();
    saveDb();
    return true; // 首次建库
  }
  normalizeDb();
  return false;
}

function saveDbToFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function saveDb() {
  if (redis) {
    const snapshot = JSON.parse(JSON.stringify(db));
    writeChain = writeChain
      .then(() => redis.set(STATE_KEY, snapshot))
      .catch((e) => console.error('[redis] 写入失败:', e.message));
    return;
  }
  saveDbToFile();
}

async function initStore() {
  if (REDIS_URL) {
    try {
      const client = createRedisClient(REDIS_URL);
      await client.ping();
      const saved = await client.get(STATE_KEY);
      let created = false;
      if (saved && typeof saved === 'object') {
        db = saved;
        normalizeDb();
      } else {
        db = defaultDb();
        created = true;
        await client.set(STATE_KEY, db);
      }
      redis = client;
      console.log('状态存储：Redis（重启不丢数据）');
      applyPasswordOverride();
      reportInitialPassword(created);
      return;
    } catch (e) {
      console.error('[redis] 不可用，改用本地文件：', e.message);
    }
  }
  const created = loadDb();
  applyPasswordOverride();
  console.log('状态存储：本地文件 data/db.json');
  reportInitialPassword(created);
}

/**
 * 只在「首次建库」且没有配 ADMIN_PASSWORD 环境变量时，把随机生成的初始密码打印到启动日志。
 * 它只出现在服务器的控制台输出里，不会进入任何接口响应或网页，群成员看不到。
 */
function reportInitialPassword(created) {
  if (ENV_ADMIN_PASSWORD || !created) return;
  console.log('');
  console.log('  ===============================================');
  console.log('   管理员初始密码：' + INITIAL_ADMIN_PASSWORD);
  console.log('   只显示在本次启动日志里，网页上看不到');
  console.log('   登录后请到「管理」页立即修改');
  console.log('  ===============================================');
  console.log('');
}

/** 配了 ADMIN_PASSWORD 环境变量时，用它强制设置管理员密码（忘记密码时的救命通道） */
function applyPasswordOverride() {
  const pwd = (process.env.ADMIN_PASSWORD || '').trim();
  if (pwd.length < 4) return;
  const hash = sha256(pwd);
  if (db.adminHash === hash) return;
  db.adminHash = hash;
  db.secret = crypto.randomBytes(24).toString('hex');
  saveDb();
  console.log('管理员密码已按 ADMIN_PASSWORD 环境变量重置');
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 400;
  }
}

function cleanName(raw) {
  if (typeof raw !== 'string') throw new ApiError('请填写名字');
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/\s+/g, ' ');
  if (!name) throw new ApiError('请填写名字');
  if ([...name].length > 12) throw new ApiError('名字最多 12 个字');
  return name;
}

function getToken(req, body, url) {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  if (body && typeof body.token === 'string' && body.token) return body.token;
  if (url && url.searchParams && url.searchParams.get('token')) return url.searchParams.get('token');
  return '';
}

function cleanClaims() {
  const now = Date.now();
  const before = db.claims.length;
  db.claims = db.claims.filter((c) => now - c.ts < CLAIM_TTL);
  return db.claims.length !== before;
}

function usedNums() {
  const used = new Set();
  db.draws.forEach((d) => used.add(d.num));
  Object.keys(db.assignments).forEach((k) => used.add(Number(k)));
  db.claims.forEach((c) => used.add(c.num));
  return used;
}

function availableNums() {
  const used = usedNums();
  const out = [];
  for (let n = 1; n <= db.total; n++) if (!used.has(n)) out.push(n);
  return out;
}

function nameTaken(name, exceptDrawId) {
  if (db.draws.some((d) => d.name === name && d.id !== exceptDrawId)) return true;
  return Object.values(db.assignments).some((n) => n === name);
}

function publicState() {
  cleanClaims();
  return {
    version: db.version,
    title: db.title,
    subtitle: db.subtitle,
    total: db.total,
    locked: db.locked,
    assignments: db.assignments,
    draws: db.draws
      .map((d) => ({ id: d.id, name: d.name, num: d.num, ts: d.ts }))
      .sort((a, b) => a.num - b.num),
    pendingSwaps: db.swaps.length,
    remaining: availableNums().length,
  };
}

function findMe(token) {
  if (!token) return null;
  return db.draws.find((d) => d.token === token) || null;
}

function requireMe(token) {
  const me = findMe(token);
  if (!me) throw new ApiError('没有找到你的抽签记录，请先抽签或输入名字找回', 401);
  return me;
}

function signAdmin(exp) {
  return crypto.createHmac('sha256', db.secret).update('admin:' + exp).digest('hex');
}

function makeAdminToken() {
  const exp = Date.now() + 8 * 3600 * 1000;
  return exp + '.' + signAdmin(exp);
}

function verifyAdminToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const i = token.indexOf('.');
  const exp = Number(token.slice(0, i));
  const sig = token.slice(i + 1);
  if (!exp || exp < Date.now()) return false;
  const expected = signAdmin(exp);
  if (sig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch (e) {
    return false;
  }
}

function requireAdmin(token) {
  if (!verifyAdminToken(token)) throw new ApiError('管理员登录已失效，请重新登录', 401);
}

function bump() {
  db.version += 1;
  saveDb();
  broadcast();
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

const sseClients = new Set();
const loginGuard = new Map();

function broadcast() {
  const payload = 'data: ' + JSON.stringify({ version: db.version }) + '\n\n';
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch (e) {
      sseClients.delete(res);
    }
  }
}

setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(': ping\n\n');
    } catch (e) {
      sseClients.delete(res);
    }
  }
}, 25000).unref();

/* ------------------------------------------------------------------ */
/* HTTP 基础                                                           */
/* ------------------------------------------------------------------ */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        reject(new ApiError('请求内容过大', 413));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new ApiError('请求格式错误', 400));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// 前端文件既支持放在 public/ 目录，也支持与 server.js 平铺在同一层，
// 这样往 GitHub 上传时可以全选文件一次拖完，不用管文件夹层级。
const FLAT_ROOT_FILES = new Set(['/index.html', '/style.css', '/app.js']);

function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const safeRel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');

  const candidates = [path.join(PUBLIC_DIR, safeRel)];
  if (FLAT_ROOT_FILES.has(rel)) candidates.push(path.join(__dirname, safeRel));

  const tryNext = (i) => {
    if (i >= candidates.length) {
      // 带扩展名的资源找不到就直接 404（避免把源码当页面返回）
      if (path.extname(rel)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 Not Found');
      }
      // 前端路由兜底：返回首页
      for (const home of [path.join(PUBLIC_DIR, 'index.html'), path.join(__dirname, 'index.html')]) {
        if (fs.existsSync(home)) {
          const html = fs.readFileSync(home);
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
          return res.end(html);
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const target = candidates[i];
    fs.readFile(target, (err, data) => {
      if (err) return tryNext(i + 1);
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
      });
      res.end(data);
    });
  };

  tryNext(0);
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api/, '');
  const method = req.method || 'GET';
  const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);
  const token = getToken(req, body, url);
  const adminToken =
    (typeof body.adminToken === 'string' && body.adminToken) ||
    (url.searchParams && url.searchParams.get('adminToken')) ||
    token;

  /* ---------- 实时事件 ---------- */
  if (route === '/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    res.write('data: ' + JSON.stringify({ version: db.version }) + '\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (route === '/health') return sendJson(res, 200, { ok: true });

  if (route === '/state' && method === 'GET') return sendJson(res, 200, publicState());

  /* ---------- 我的信息 ---------- */
  if (route === '/me' && method === 'GET') {
    const me = findMe(token);
    if (!me) return sendJson(res, 200, { me: null, incoming: [], outgoing: [] });
    const incoming = db.swaps
      .filter((s) => s.toId === me.id)
      .map((s) => {
        const from = db.draws.find((d) => d.id === s.fromId);
        return from
          ? { id: s.id, fromId: from.id, fromName: from.name, fromNum: from.num, toNum: me.num, ts: s.ts }
          : null;
      })
      .filter(Boolean);
    const outgoing = db.swaps
      .filter((s) => s.fromId === me.id)
      .map((s) => {
        const to = db.draws.find((d) => d.id === s.toId);
        return to
          ? { id: s.id, toId: to.id, toName: to.name, toNum: to.num, fromNum: me.num, ts: s.ts }
          : null;
      })
      .filter(Boolean);
    return sendJson(res, 200, {
      me: { id: me.id, name: me.name, num: me.num },
      incoming,
      outgoing,
    });
  }

  /* ---------- 抽签：先出号码 ---------- */
  if (route === '/draw/start' && method === 'POST') {
    if (db.locked) throw new ApiError('抽签已暂停，请联系管理员', 403);
    if (findMe(token)) throw new ApiError('你已经抽过签了，不能重复抽', 409);
    cleanClaims();

    // 已经抽到号码、还没登记名字的，继续沿用同一个号码。
    // 抽签一旦出号就定下来，刷新页面或再点一次都不会换，杜绝挑号。
    const prevId = String(body.claimId || '');
    if (prevId) {
      const prev = db.claims.find((c) => c.id === prevId);
      if (prev) return sendJson(res, 200, { claimId: prev.id, num: prev.num, total: db.total, reused: true });
    }

    const pool = availableNums();
    if (!pool.length) throw new ApiError('号码已经抽完了', 409);
    const num = pool[crypto.randomInt(pool.length)];
    const claim = { id: crypto.randomBytes(12).toString('hex'), num, ts: Date.now() };
    db.claims.push(claim);
    saveDb();
    return sendJson(res, 200, { claimId: claim.id, num, total: db.total });
  }

  /* ---------- 抽签：填写名字完成登记 ---------- */
  if (route === '/draw/confirm' && method === 'POST') {
    cleanClaims();
    const claimId = String(body.claimId || '');
    const claim = db.claims.find((c) => c.id === claimId);
    if (!claim) throw new ApiError('这个签号已经失效，请重新抽签', 410);
    if (findMe(token)) throw new ApiError('你已经抽过签了，不能重复抽', 409);
    const name = cleanName(body.name);
    if (nameTaken(name)) throw new ApiError('这个名字已经被使用了，请换一个', 409);
    if (db.draws.some((d) => d.num === claim.num) || db.assignments[claim.num]) {
      throw new ApiError('这个号码已经被占用，请重新抽签', 409);
    }
    db.claims = db.claims.filter((c) => c.id !== claimId);
    const record = {
      id: crypto.randomBytes(9).toString('hex'),
      name,
      num: claim.num,
      token: crypto.randomBytes(18).toString('hex'),
      ts: Date.now(),
    };
    db.draws.push(record);
    bump();
    return sendJson(res, 200, {
      token: record.token,
      participant: { id: record.id, name: record.name, num: record.num },
      state: publicState(),
    });
  }

  /* ---------- 找回自己的签（换设备 / 清缓存） ---------- */
  if (route === '/draw/recover' && method === 'POST') {
    const name = cleanName(body.name);
    const record = db.draws.find((d) => d.name === name);
    if (!record) throw new ApiError('没有找到这个名字的抽签记录', 404);
    record.token = crypto.randomBytes(18).toString('hex');
    bump();
    return sendJson(res, 200, {
      token: record.token,
      participant: { id: record.id, name: record.name, num: record.num },
    });
  }

  /* ---------- 互换号码 ---------- */
  if (route === '/swap/request' && method === 'POST') {
    const me = requireMe(token);
    const targetId = String(body.targetId || '');
    const target = db.draws.find((d) => d.id === targetId);
    if (!target) throw new ApiError('对方还没有抽签记录', 404);
    if (target.id === me.id) throw new ApiError('不能和自己换', 400);
    // 同一个人同一时间只保留一条待确认申请
    db.swaps = db.swaps.filter((s) => s.fromId !== me.id);
    const swap = {
      id: crypto.randomBytes(9).toString('hex'),
      fromId: me.id,
      toId: target.id,
      fromNum: me.num,
      toNum: target.num,
      ts: Date.now(),
    };
    db.swaps.push(swap);
    bump();
    return sendJson(res, 200, { ok: true, swapId: swap.id });
  }

  if (route === '/swap/cancel' && method === 'POST') {
    const me = requireMe(token);
    const swapId = String(body.swapId || '');
    const before = db.swaps.length;
    db.swaps = db.swaps.filter(
      (s) => s.id !== swapId || (s.fromId !== me.id && s.toId !== me.id)
    );
    if (db.swaps.length === before) throw new ApiError('这条申请已经不存在了', 404);
    bump();
    return sendJson(res, 200, { ok: true });
  }

  if (route === '/swap/respond' && method === 'POST') {
    const me = requireMe(token);
    const swapId = String(body.swapId || '');
    const swap = db.swaps.find((s) => s.id === swapId);
    if (!swap) throw new ApiError('这条申请已经不存在了', 404);
    if (swap.toId !== me.id) throw new ApiError('这条申请不是发给你的', 403);
    if (body.accept !== true) {
      db.swaps = db.swaps.filter((s) => s.id !== swapId);
      bump();
      return sendJson(res, 200, { ok: true, accepted: false });
    }
    const a = db.draws.find((d) => d.id === swap.fromId);
    const b = db.draws.find((d) => d.id === swap.toId);
    if (!a || !b) {
      db.swaps = db.swaps.filter((s) => s.id !== swapId);
      bump();
      throw new ApiError('对方的抽签记录已不存在，无法互换', 409);
    }
    const tmp = a.num;
    a.num = b.num;
    b.num = tmp;
    db.swaps = [];
    bump();
    return sendJson(res, 200, { ok: true, accepted: true });
  }

  /* ---------- 管理员 ---------- */
  if (route === '/admin/login' && method === 'POST') {
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    const g = loginGuard.get(ip) || { fails: 0, lockUntil: 0 };
    if (g.lockUntil > Date.now()) {
      const wait = Math.ceil((g.lockUntil - Date.now()) / 1000);
      throw new ApiError('密码错误次数过多，请 ' + wait + ' 秒后再试', 429);
    }
    const pwd = typeof body.password === 'string' ? body.password : '';
    if (!pwd) throw new ApiError('请输入管理员密码');
    if (sha256(pwd) !== db.adminHash) {
      g.fails += 1;
      if (g.fails >= 5) {
        g.lockUntil = Date.now() + 60 * 1000;
        g.fails = 0;
      }
      loginGuard.set(ip, g);
      throw new ApiError('密码不正确', 401);
    }
    loginGuard.delete(ip);
    return sendJson(res, 200, { adminToken: makeAdminToken() });
  }

  if (route === '/admin/assign' && method === 'POST') {
    requireAdmin(adminToken);
    const num = Number(body.num);
    const name = cleanName(body.name);
    if (!Number.isInteger(num) || num < 1 || num > db.total)
      throw new ApiError('号码超出范围');
    if (db.draws.some((d) => d.num === num))
      throw new ApiError(num + ' 号已经被抽走了，请先清除那条记录');
    if (nameTaken(name)) throw new ApiError('这个名字已经被使用了');
    db.assignments[num] = name;
    db.claims = db.claims.filter((c) => c.num !== num);
    bump();
    return sendJson(res, 200, { ok: true, state: publicState() });
  }

  if (route === '/admin/unassign' && method === 'POST') {
    requireAdmin(adminToken);
    const num = Number(body.num);
    delete db.assignments[num];
    bump();
    return sendJson(res, 200, { ok: true, state: publicState() });
  }

  if (route === '/admin/remove-draw' && method === 'POST') {
    requireAdmin(adminToken);
    const id = String(body.id || '');
    const before = db.draws.length;
    const removed = db.draws.find((d) => d.id === id);
    db.draws = db.draws.filter((d) => d.id !== id);
    if (db.draws.length === before) throw new ApiError('没有找到这条记录', 404);
    db.swaps = db.swaps.filter((s) => s.fromId !== id && s.toId !== id);
    bump();
    return sendJson(res, 200, { ok: true, freed: removed.num, state: publicState() });
  }

  if (route === '/admin/config' && method === 'POST') {
    requireAdmin(adminToken);
    if (typeof body.title === 'string') {
      const t = body.title.trim().slice(0, 24);
      if (t) db.title = t;
    }
    if (typeof body.subtitle === 'string') db.subtitle = body.subtitle.trim().slice(0, 40);
    if (typeof body.locked === 'boolean') db.locked = body.locked;
    if (body.total !== undefined) {
      const n = Number(body.total);
      if (!Number.isInteger(n) || n < 2 || n > 99) throw new ApiError('号码总量需在 2–99 之间');
      if (n !== db.total) {
        if (db.draws.length || Object.keys(db.assignments).length)
          throw new ApiError('已经有人抽签或已有预指定，请先清零再修改号码总量');
        db.total = n;
      }
    }
    bump();
    return sendJson(res, 200, { ok: true, state: publicState() });
  }

  if (route === '/admin/reset' && method === 'POST') {
    requireAdmin(adminToken);
    const scope = body.scope === 'draws' ? 'draws' : 'all';
    db.draws = [];
    db.claims = [];
    db.swaps = [];
    if (scope === 'all') db.assignments = {};
    bump();
    return sendJson(res, 200, { ok: true, state: publicState() });
  }

  /* ---------- 备份：导出 / 导入 ---------- */
  if (route === '/admin/export' && method === 'GET') {
    requireAdmin(adminToken);
    return sendJson(res, 200, {
      exportedAt: new Date().toISOString(),
      title: db.title,
      subtitle: db.subtitle,
      total: db.total,
      locked: db.locked,
      assignments: db.assignments,
      draws: db.draws,
    });
  }

  if (route === '/admin/import' && method === 'POST') {
    requireAdmin(adminToken);
    const data = body.data;
    if (!data || typeof data !== 'object') throw new ApiError('数据格式不正确');
    const total = Number(data.total);
    if (!Number.isInteger(total) || total < 2 || total > 99) throw new ApiError('号码总量不合法');

    const safeName = (v) => {
      try {
        return cleanName(v);
      } catch (e) {
        return null;
      }
    };

    const usedNum = new Set();
    const usedName = new Set();
    const draws = [];
    const srcDraws = Array.isArray(data.draws) ? data.draws : [];
    for (const d of srcDraws) {
      if (!d || typeof d !== 'object') continue;
      const num = Number(d.num);
      const name = safeName(d.name);
      if (!name || !Number.isInteger(num) || num < 1 || num > total) continue;
      if (usedNum.has(num) || usedName.has(name)) continue;
      usedNum.add(num);
      usedName.add(name);
      draws.push({
        id: typeof d.id === 'string' && d.id ? d.id : crypto.randomBytes(9).toString('hex'),
        name,
        num,
        token: typeof d.token === 'string' && d.token ? d.token : crypto.randomBytes(18).toString('hex'),
        ts: Number(d.ts) || Date.now(),
      });
    }

    const assignments = {};
    const srcAssign = data.assignments && typeof data.assignments === 'object' ? data.assignments : {};
    for (const key of Object.keys(srcAssign)) {
      const num = Number(key);
      const name = safeName(srcAssign[key]);
      if (!name || !Number.isInteger(num) || num < 1 || num > total) continue;
      if (usedNum.has(num) || usedName.has(name)) continue;
      usedNum.add(num);
      usedName.add(name);
      assignments[num] = name;
    }

    db.total = total;
    if (typeof data.title === 'string' && data.title.trim()) db.title = data.title.trim().slice(0, 24);
    if (typeof data.subtitle === 'string') db.subtitle = data.subtitle.trim().slice(0, 40);
    db.locked = !!data.locked;
    db.draws = draws;
    db.assignments = assignments;
    db.claims = [];
    db.swaps = [];
    bump();
    return sendJson(res, 200, {
      ok: true,
      state: publicState(),
      imported: { draws: draws.length, assignments: Object.keys(assignments).length },
    });
  }

  if (route === '/admin/password' && method === 'POST') {
    requireAdmin(adminToken);
    const pwd = typeof body.password === 'string' ? body.password.trim() : '';
    if (pwd.length < 4) throw new ApiError('密码至少 4 位');
    db.adminHash = sha256(pwd);
    // 换密码同时轮换签名密钥，让其他设备上的旧登录立即失效
    db.secret = crypto.randomBytes(24).toString('hex');
    bump();
    return sendJson(res, 200, { ok: true, adminToken: makeAdminToken() });
  }

  throw new ApiError('接口不存在', 404);
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      if (res.headersSent) {
        try {
          res.end();
        } catch (e) {}
        return;
      }
      const status = err instanceof ApiError ? err.status : 500;
      if (status >= 500) console.error('[api]', err);
      sendJson(res, status, { error: err.message || '服务器异常' });
    });
    return;
  }
  serveStatic(res, url.pathname);
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

initStore().then(() => {
  server.listen(PORT, HOST, () => {
    console.log('抽签排序 已启动，端口 ' + PORT);
  });
});

process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));
