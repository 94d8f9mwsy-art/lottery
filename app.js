'use strict';

/* ------------------------------------------------------------------ */
/* 基础                                                                */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);

const api = {
  async req(path, opts) {
    let res;
    try {
      res = await fetch('/api' + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
    } catch (e) {
      const err = new Error('网络连接失败，请检查网络后重试');
      err.status = 0;
      throw err;
    }
    const txt = await res.text();
    let data = {};
    try {
      data = txt ? JSON.parse(txt) : {};
    } catch (e) {
      data = {};
    }
    if (!res.ok) {
      const err = new Error(data.error || '请求失败（' + res.status + '）');
      err.status = res.status;
      throw err;
    }
    return data;
  },
  get(p) {
    return this.req(p, { method: 'GET' });
  },
  post(p, b) {
    return this.req(p, { method: 'POST', body: JSON.stringify(b || {}) });
  },
};

const S = {
  state: null,
  me: { me: null, incoming: [], outgoing: [] },
  tab: 'draw',
  token: localStorage.getItem('ls_token') || '',
  adminToken: localStorage.getItem('ls_admin') || '',
  adminOk: false,
  claim: null,
  drawBusy: false,
  pendingRender: false,
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

function adminTokenAlive() {
  if (!S.adminToken) return false;
  const exp = Number(String(S.adminToken).split('.')[0]);
  return exp > Date.now() + 3000;
}

async function adminPost(path, body) {
  try {
    return await api.post(path, Object.assign({ adminToken: S.adminToken }, body || {}));
  } catch (e) {
    if (e.status === 401) {
      S.adminOk = false;
      S.adminToken = '';
      localStorage.removeItem('ls_admin');
      render();
      toast('管理员登录已失效，请重新登录');
    }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 数据加载                                                            */
/* ------------------------------------------------------------------ */

async function load(silent) {
  try {
    const st = await api.get('/state');
    S.state = st;

    if (S.token) {
      try {
        S.me = await api.get('/me?token=' + encodeURIComponent(S.token));
      } catch (e) {
        S.me = { me: null, incoming: [], outgoing: [] };
      }
      if (!S.me || !S.me.me) {
        // 记录已被清零或不存在，允许重新抽签
        S.token = '';
        localStorage.removeItem('ls_token');
        S.me = { me: null, incoming: [], outgoing: [] };
      }
    } else {
      S.me = { me: null, incoming: [], outgoing: [] };
    }

    updateChrome();
    render();
  } catch (e) {
    if (!silent) {
      $('main').innerHTML =
        '<div class="empty-tip">连接服务器失败：' + esc(e.message) + '<br><br>请稍后下拉刷新</div>';
    }
  }
}

function updateChrome() {
  const st = S.state;
  if (!st) return;
  $('appTitle').textContent = st.title;
  $('appSub').textContent = st.subtitle || '';
  document.title = st.title;
  const s = $('appStatus');
  s.textContent = st.locked ? '已暂停' : '进行中';
  s.classList.toggle('off', !!st.locked);
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === S.tab);
  });
  const inc = ((S.me && S.me.incoming) || []).length;
  const b = $('swapBadge');
  b.hidden = inc === 0;
  b.textContent = inc;
}

/* ------------------------------------------------------------------ */
/* 视图                                                                */
/* ------------------------------------------------------------------ */

function render() {
  if (!S.state) return;
  const ae = document.activeElement;
  if (ae && ae.tagName === 'INPUT' && $('main').contains(ae)) {
    S.pendingRender = true;
    return;
  }
  S.pendingRender = false;

  const main = $('main');
  if (S.tab === 'draw') main.innerHTML = viewDraw();
  else if (S.tab === 'swap') main.innerHTML = viewSwap();
  else main.innerHTML = viewAdmin();

  updateChrome();
}

function tilesHtml() {
  const st = S.state;
  const mine = S.me && S.me.me;
  let h = '';
  for (let n = 1; n <= st.total; n++) {
    const d = st.draws.find((x) => x.num === n);
    const a = st.assignments[n];
    if (d) {
      const isMine = mine && mine.id === d.id;
      h +=
        '<div class="tile taken' + (isMine ? ' mine' : '') + '">' +
        '<span class="n">' + n + '</span>' +
        '<span class="m">' + esc(d.name) + '</span></div>';
    } else if (a) {
      h +=
        '<div class="tile assigned">' +
        '<span class="n">' + n + '</span>' +
        '<span class="m">' + esc(a) + '</span></div>';
    } else {
      h += '<div class="tile empty"><span class="n">' + n + '</span><span class="m">待抽</span></div>';
    }
  }
  return h;
}

function myCardHtml() {
  const me = S.me.me;
  return (
    '<div class="mycard">' +
    '<div class="mc-label">你的签</div>' +
    '<div class="mc-row">' +
    '<div>' +
    '<div class="mc-num">' + me.num + '</div>' +
    '<div class="mc-name">' + esc(me.name) + '</div>' +
    '</div>' +
    '<button class="mc-btn" data-act="go-swap">换号</button>' +
    '</div></div>'
  );
}

function viewDraw() {
  const st = S.state;
  const mine = S.me && S.me.me;
  const assignedCount = Object.keys(st.assignments || {}).length;
  let h = '';

  if (st.locked) h += '<div class="banner">抽签已暂停，管理员开启后才能继续抽签。</div>';
  if (mine) h += myCardHtml();

  h +=
    '<div class="stats">' +
    '<div class="stat hi"><b>' + st.remaining + '</b><span>剩余可抽</span></div>' +
    '<div class="stat"><b>' + st.draws.length + '</b><span>已抽出</span></div>' +
    '<div class="stat"><b>' + assignedCount + '</b><span>预指定</span></div>' +
    '</div>';

  h += '<div class="grid">' + tilesHtml() + '</div>';

  if (!mine) {
    if (st.locked) {
      h += '<p class="hint" style="text-align:center;margin-top:16px">管理员暂停了抽签，请稍后再来。</p>';
    } else if (st.remaining === 0) {
      h += '<p class="hint" style="text-align:center;margin-top:16px">号码已经全部抽完了。</p>';
    } else {
      h +=
        '<div style="margin-top:16px">' +
        '<button class="btn btn-primary" data-act="draw">抽 一 个 号 码</button>' +
        '<p class="hint" style="text-align:center">点一下即可抽号，抽到后再填写你的名字</p>' +
        '</div>';
    }
    h += '<button class="btn-text" data-act="recover-open">换了设备？输入名字找回我的签</button>';
  }

  return h;
}

function viewSwap() {
  const st = S.state;
  const me = S.me && S.me.me;

  if (!me) {
    return (
      '<div class="card">' +
      '<h2 class="card-title">还没有你的签</h2>' +
      '<p class="hint" style="margin:0">互换号码需要先有自己的号码。如果你已经抽过签，只是换了手机或清了缓存，输入抽签时用的名字就能找回。</p>' +
      '<div class="field" style="margin-top:14px">' +
      '<input class="input" id="recoverName" maxlength="12" placeholder="抽签时填写的名字" />' +
      '<button class="btn btn-primary btn-sm" data-act="recover">找回</button>' +
      '</div></div>' +
      '<div style="margin-top:12px"><button class="btn btn-ghost" data-act="go-draw">先去抽签</button></div>'
    );
  }

  const incoming = S.me.incoming || [];
  const outgoing = S.me.outgoing || [];
  let h = '';

  h +=
    '<div class="card" style="display:flex;align-items:center;gap:12px">' +
    '<span class="num-chip red" style="width:44px;height:44px;font-size:17px">' + me.num + '</span>' +
    '<div class="who"><b>' + esc(me.name) + '</b><small>当前号码，可在下面找人互换</small></div>' +
    '</div>';

  if (incoming.length) {
    h += '<div class="section-label">等你确认的申请</div>';
    incoming.forEach((r) => {
      h +=
        '<div class="card">' +
        '<div class="row" style="border:none;padding-top:0">' +
        '<span class="num-chip">' + r.fromNum + '</span>' +
        '<div class="who"><b>' + esc(r.fromName) + '</b><small>想用 ' + r.fromNum + ' 号 换你的 ' + r.toNum + ' 号</small></div>' +
        '</div>' +
        '<div class="btn-row" style="margin-top:12px">' +
        '<button class="btn btn-ghost btn-sm" style="flex:1" data-act="swap-reject" data-id="' + r.id + '">拒绝</button>' +
        '<button class="btn btn-primary btn-sm" style="flex:1" data-act="swap-accept" data-id="' + r.id + '">同意互换</button>' +
        '</div></div>';
    });
  }

  if (outgoing.length) {
    h += '<div class="section-label">你发出的申请</div>';
    outgoing.forEach((r) => {
      h +=
        '<div class="card">' +
        '<div class="row" style="border:none;padding-top:0">' +
        '<span class="num-chip gold">' + r.toNum + '</span>' +
        '<div class="who"><b>' + esc(r.toName) + '</b><small>等待对方确认，用 ' + r.fromNum + ' 号换 ' + r.toNum + ' 号</small></div>' +
        '<button class="btn btn-sm btn-ghost" data-act="swap-cancel" data-id="' + r.id + '">撤回</button>' +
        '</div></div>';
    });
  }

  const others = st.draws.filter((d) => d.id !== me.id);
  h += '<div class="section-label">向谁发起换号</div>';
  if (!others.length) {
    h += '<div class="card"><div class="empty-tip">还没有其他人抽签</div></div>';
  } else {
    h += '<div class="card">';
    others.forEach((d) => {
      h +=
        '<div class="row">' +
        '<span class="num-chip">' + d.num + '</span>' +
        '<div class="who"><b>' + esc(d.name) + '</b></div>' +
        '<button class="btn btn-sm btn-soft" data-act="swap-ask" data-id="' + d.id + '">换号</button>' +
        '</div>';
    });
    h += '</div>';
    h += '<p class="hint">发起后对方会在自己的页面看到申请，双方都同意后号码才会互换。</p>';
  }

  return h;
}

function viewAdmin() {
  const st = S.state;

  if (!S.adminOk) {
    return (
      '<div class="card">' +
      '<h2 class="card-title">管理员登录</h2>' +
      '<p class="hint" style="margin:0">登录后可以预指定号码、暂停或开启抽签、清除单条记录、一键清零。</p>' +
      '<div class="field" style="margin-top:14px">' +
      '<input class="input" id="adminPwd" type="password" placeholder="管理员密码" autocomplete="current-password" />' +
      '</div>' +
      '<button class="btn btn-primary" style="margin-top:10px" data-act="admin-login">登录</button>' +
      '</div>'
    );
  }

  let h = '';
  h += '<div class="banner info">管理员模式已开启，所有改动都会实时同步到群成员的页面。</div>';

  /* 状态 */
  h +=
    '<div class="card">' +
    '<h2 class="card-title">抽签状态</h2>' +
    '<div class="row">' +
    '<div class="who"><b>' + (st.locked ? '已暂停' : '进行中') + '</b><small>暂停后成员无法再抽签</small></div>' +
    '<button class="btn btn-sm ' + (st.locked ? 'btn-primary' : 'btn-ghost') + '" data-act="toggle-lock">' +
    (st.locked ? '开启抽签' : '暂停抽签') + '</button>' +
    '</div>' +
    '<div class="row">' +
    '<div class="who"><b>号码总量</b><small>当前 1–' + st.total + '，有记录后不可修改</small></div>' +
    '<input class="input" id="totalInput" type="number" min="2" max="99" value="' + st.total + '" style="width:74px;flex:none;text-align:center" />' +
    '<button class="btn btn-sm btn-ghost" data-act="save-total">保存</button>' +
    '</div></div>';

  /* 预指定 */
  let opts = '';
  const avail = [];
  for (let n = 1; n <= st.total; n++) {
    if (!st.draws.some((d) => d.num === n) && !st.assignments[n]) avail.push(n);
  }
  if (avail.length) opts = avail.map((n) => '<option value="' + n + '">' + n + ' 号</option>').join('');
  else opts = '<option value="">无空号</option>';

  h +=
    '<div class="card">' +
    '<h2 class="card-title">预指定号码</h2>' +
    '<p class="hint" style="margin:0 0 12px">被指定的号码不参与抽签，直接显示对应名字。</p>' +
    '<div class="field">' +
    '<select class="input" id="assignNum"' + (avail.length ? '' : ' disabled') + '>' + opts + '</select>' +
    '<input class="input" id="assignName" maxlength="12" placeholder="名字" />' +
    '<button class="btn btn-primary btn-sm" data-act="assign">指定</button>' +
    '</div>';

  const assignKeys = Object.keys(st.assignments || {}).sort((a, b) => a - b);
  if (assignKeys.length) {
    h += '<div style="margin-top:8px">';
    assignKeys.forEach((k) => {
      h +=
        '<div class="row">' +
        '<span class="num-chip gold">' + k + '</span>' +
        '<div class="who"><b>' + esc(st.assignments[k]) + '</b><small>预指定</small></div>' +
        '<button class="btn btn-sm btn-ghost" data-act="unassign" data-num="' + k + '">取消</button>' +
        '</div>';
    });
    h += '</div>';
  }
  h += '</div>';

  /* 已抽记录 */
  h +=
    '<div class="card">' +
    '<h2 class="card-title">已抽记录（' + st.draws.length + '）</h2>';
  if (!st.draws.length) {
    h += '<div class="empty-tip">还没有人抽签</div>';
  } else {
    st.draws.forEach((d) => {
      h +=
        '<div class="row">' +
        '<span class="num-chip">' + d.num + '</span>' +
        '<div class="who"><b>' + esc(d.name) + '</b></div>' +
        '<button class="btn btn-sm btn-ghost" data-act="remove-draw" data-id="' + d.id + '">清除</button>' +
        '</div>';
    });
  }
  h += '</div>';

  /* 清零 */
  h +=
    '<div class="card">' +
    '<h2 class="card-title">清零</h2>' +
    '<div class="btn-row">' +
    '<button class="btn btn-sm danger" style="flex:1" data-act="reset-draws">清空抽签结果</button>' +
    '<button class="btn btn-sm danger" style="flex:1" data-act="reset-all">全部清零</button>' +
    '</div>' +
    '<p class="hint">「清空抽签结果」保留预指定的号码；「全部清零」连预指定一起清空。操作不可撤销。</p>' +
    '</div>';

  /* 其他 */
  h +=
    '<div class="card">' +
    '<h2 class="card-title">其他</h2>' +
    '<div class="btn-row">' +
    '<button class="btn btn-sm btn-ghost" style="flex:1" data-act="copy-list">复制名单</button>' +
    '<button class="btn btn-sm btn-ghost" style="flex:1" data-act="copy-link">复制邀请链接</button>' +
    '</div>' +
    '<div class="btn-row" style="margin-top:10px">' +
    '<button class="btn btn-sm btn-ghost" style="flex:1" data-act="export-data">导出备份</button>' +
    '<button class="btn btn-sm btn-ghost" style="flex:1" data-act="import-data">导入备份</button>' +
    '</div>' +
    '<div class="btn-row" style="margin-top:10px">' +
    '<button class="btn btn-sm btn-ghost" style="flex:1" data-act="change-pwd">修改管理员密码</button>' +
    '</div>' +
    '<p class="hint">云端免费服务闲置休眠后可能清空数据，建议抽签结束后点一次「导出备份」。</p>' +
    '<button class="btn-text" data-act="admin-logout">退出管理员</button>' +
    '</div>';

  return h;
}

/* ------------------------------------------------------------------ */
/* 弹层                                                                */
/* ------------------------------------------------------------------ */

function closeOverlay() {
  const ov = $('overlay');
  ov.classList.remove('show');
  ov.innerHTML = '';
}

function showReveal(num) {
  const ov = $('overlay');
  ov.innerHTML =
    '<div class="modal">' +
    '<p class="modal-tag">抽 签 结 果</p>' +
    '<div class="roll blur" id="rollNum">' + num + '</div>' +
    '<div id="revealBody" hidden>' +
    '<p class="reveal-tip">你抽到了 <b style="color:#C1413A">' + num + ' 号</b>，填写名字完成登记</p>' +
    '<input class="input" id="nameInput" maxlength="12" placeholder="你的名字" autocomplete="off" />' +
    '<button class="btn btn-primary" id="confirmBtn" data-act="confirm-draw">确认登记</button>' +
    '</div></div>';
  ov.classList.add('show');

  const total = S.state.total;
  const roll = $('rollNum');
  const timer = setInterval(() => {
    if (!document.body.contains(roll)) {
      clearInterval(timer);
      return;
    }
    roll.textContent = 1 + Math.floor(Math.random() * total);
  }, 55);

  setTimeout(() => {
    clearInterval(timer);
    if (!document.body.contains(roll)) return;
    roll.textContent = num;
    roll.classList.remove('blur');
    roll.classList.add('pop');
    const body = $('revealBody');
    if (body) body.hidden = false;
    const inp = $('nameInput');
    if (inp) setTimeout(() => inp.focus(), 60);
  }, 1150);
}

function showDialog(title, desc, onOk, okText) {
  const ov = $('overlay');
  ov.innerHTML =
    '<div class="modal">' +
    '<p class="modal-tag">请 确 认</p>' +
    '<p style="font-size:16px;font-weight:600;margin:6px 0 8px;line-height:1.5">' + esc(title) + '</p>' +
    (desc ? '<p class="reveal-tip" style="margin:0 0 14px">' + esc(desc) + '</p>' : '') +
    '<div class="btn-row">' +
    '<button class="btn btn-ghost" data-act="dlg-cancel">取消</button>' +
    '<button class="btn btn-primary" data-act="dlg-ok">' + esc(okText || '确定') + '</button>' +
    '</div></div>';
  ov.classList.add('show');
  S.dialogOk = onOk;
}

/* ------------------------------------------------------------------ */
/* 抽签                                                                */
/* ------------------------------------------------------------------ */

async function startDraw() {
  if (S.drawBusy) return;
  S.drawBusy = true;
  try {
    // 带上已有的 claimId：抽到的号码在登记前不会变，
    // 刷新页面或再点一次也只会回到同一个号，避免挑号
    const saved = localStorage.getItem('ls_claim') || '';
    const r = await api.post('/draw/start', { token: S.token, claimId: saved });
    S.claim = { id: r.claimId, num: r.num };
    localStorage.setItem('ls_claim', r.claimId);
    showReveal(r.num);
  } catch (e) {
    toast(e.message);
    if (e.status === 409 || e.status === 403) load(true);
  } finally {
    S.drawBusy = false;
  }
}

async function confirmDraw() {
  if (!S.claim) return;
  const input = $('nameInput');
  if (!input) return;
  const name = (input.value || '').trim();
  if (!name) {
    toast('请填写你的名字');
    input.focus();
    return;
  }
  const btn = $('confirmBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '登记中…';
  }
  try {
    const r = await api.post('/draw/confirm', { claimId: S.claim.id, name: name, token: S.token });
    S.token = r.token;
    localStorage.setItem('ls_token', r.token);
    S.claim = null;
    localStorage.removeItem('ls_claim');
    closeOverlay();
    await load(true);
    toast('登记成功，你是 ' + r.participant.num + ' 号');
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '确认登记';
    }
    toast(e.message);
    if (e.status === 410 || e.status === 409) {
      S.claim = null;
      localStorage.removeItem('ls_claim');
      closeOverlay();
      load(true);
    }
  }
}

async function doRecover() {
  const el = $('recoverName');
  const name = (el && el.value ? el.value : '').trim();
  if (!name) {
    toast('请输入抽签时填写的名字');
    return;
  }
  try {
    const r = await api.post('/draw/recover', { name: name });
    S.token = r.token;
    localStorage.setItem('ls_token', r.token);
    await load(true);
    toast('已找回：你是 ' + r.participant.num + ' 号');
  } catch (e) {
    toast(e.message);
  }
}

function openRecover() {
  // 复用换号页的找回入口
  S.tab = 'swap';
  render();
  const el = $('recoverName');
  if (el) el.focus();
}

/* ------------------------------------------------------------------ */
/* 换号                                                                */
/* ------------------------------------------------------------------ */

async function askSwap(id) {
  const me = S.me.me;
  const target = S.state.draws.find((d) => d.id === id);
  if (!me || !target) return;
  showDialog(
    '用你的 ' + me.num + ' 号，换 ' + target.name + ' 的 ' + target.num + ' 号？',
    '对方同意后号码才会互换，期间你可以撤回。',
    async () => {
      try {
        await api.post('/swap/request', { token: S.token, targetId: id });
        closeOverlay();
        await load(true);
        toast('已发送，等待 ' + target.name + ' 确认');
      } catch (e) {
        closeOverlay();
        toast(e.message);
      }
    },
    '发送申请'
  );
}

async function respondSwap(id, accept) {
  try {
    await api.post('/swap/respond', { token: S.token, swapId: id, accept: accept });
    await load(true);
    toast(accept ? '已互换，号码更新完成' : '已拒绝');
  } catch (e) {
    toast(e.message);
    load(true);
  }
}

async function cancelSwap(id) {
  try {
    await api.post('/swap/cancel', { token: S.token, swapId: id });
    await load(true);
    toast('已撤回申请');
  } catch (e) {
    toast(e.message);
  }
}

/* ------------------------------------------------------------------ */
/* 管理员                                                              */
/* ------------------------------------------------------------------ */

async function doAdminLogin() {
  const el = $('adminPwd');
  const pwd = el ? el.value : '';
  if (!pwd) {
    toast('请输入管理员密码');
    return;
  }
  try {
    const r = await api.post('/admin/login', { password: pwd });
    S.adminToken = r.adminToken;
    S.adminOk = true;
    localStorage.setItem('ls_admin', r.adminToken);
    render();
    toast('已进入管理员模式');
  } catch (e) {
    toast(e.message);
  }
}

async function doAssign() {
  const numEl = $('assignNum');
  const nameEl = $('assignName');
  if (!numEl || !nameEl) return;
  const num = Number(numEl.value);
  const name = (nameEl.value || '').trim();
  if (!num) {
    toast('没有可指定的空号');
    return;
  }
  if (!name) {
    toast('请填写名字');
    nameEl.focus();
    return;
  }
  try {
    await adminPost('/admin/assign', { num: num, name: name });
    await load(true);
    toast('已把 ' + num + ' 号指定给 ' + name);
  } catch (e) {
    toast(e.message);
  }
}

function buildListText() {
  const st = S.state;
  const lines = [st.title + '（1–' + st.total + '）'];
  const pad = String(st.total).length;
  for (let n = 1; n <= st.total; n++) {
    const d = st.draws.find((x) => x.num === n);
    const a = st.assignments[n];
    const nm = d ? d.name : a || '';
    lines.push(String(n).padStart(pad, ' ') + '  ' + (nm || '—'));
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 事件                                                                */
/* ------------------------------------------------------------------ */

function switchTab(tab) {
  S.tab = tab;
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.addEventListener('click', async (e) => {
  const tabEl = e.target.closest('.tab');
  if (tabEl) {
    switchTab(tabEl.dataset.tab);
    return;
  }

  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id = el.dataset.id;

  switch (act) {
    case 'draw':
      startDraw();
      break;
    case 'confirm-draw':
      confirmDraw();
      break;
    case 'go-swap':
      switchTab('swap');
      break;
    case 'go-draw':
      switchTab('draw');
      break;
    case 'recover':
      doRecover();
      break;
    case 'recover-open':
      openRecover();
      break;
    case 'swap-ask':
      askSwap(id);
      break;
    case 'swap-accept':
      respondSwap(id, true);
      break;
    case 'swap-reject':
      respondSwap(id, false);
      break;
    case 'swap-cancel':
      cancelSwap(id);
      break;
    case 'dlg-ok': {
      const fn = S.dialogOk;
      S.dialogOk = null;
      if (fn) fn();
      else closeOverlay();
      break;
    }
    case 'dlg-cancel':
      S.dialogOk = null;
      closeOverlay();
      break;
    case 'admin-login':
      doAdminLogin();
      break;
    case 'admin-logout':
      S.adminOk = false;
      S.adminToken = '';
      localStorage.removeItem('ls_admin');
      render();
      toast('已退出管理员');
      break;
    case 'toggle-lock':
      try {
        await adminPost('/admin/config', { locked: !S.state.locked });
        await load(true);
        toast(S.state.locked ? '已暂停抽签' : '已开启抽签');
      } catch (err) {
        toast(err.message);
      }
      break;
    case 'save-total': {
      const t = $('totalInput');
      try {
        await adminPost('/admin/config', { total: Number(t ? t.value : 0) });
        await load(true);
        toast('号码总量已更新');
      } catch (err) {
        toast(err.message);
      }
      break;
    }
    case 'assign':
      doAssign();
      break;
    case 'unassign':
      try {
        await adminPost('/admin/unassign', { num: Number(el.dataset.num) });
        await load(true);
        toast('已取消预指定');
      } catch (err) {
        toast(err.message);
      }
      break;
    case 'remove-draw':
      showDialog(
        '清除这条抽签记录？',
        '清除后该号码会重新进入抽签池。',
        async () => {
          try {
            const r = await adminPost('/admin/remove-draw', { id: id });
            closeOverlay();
            await load(true);
            toast('已清除，' + r.freed + ' 号释放');
          } catch (err) {
            closeOverlay();
            toast(err.message);
          }
        },
        '清除'
      );
      break;
    case 'reset-draws':
      showDialog(
        '清空全部抽签结果？',
        '所有人的号码都会作废，预指定的号码会保留。操作不可撤销。',
        async () => {
          try {
            await adminPost('/admin/reset', { scope: 'draws' });
            closeOverlay();
            await load(true);
            toast('已清空抽签结果');
          } catch (err) {
            closeOverlay();
            toast(err.message);
          }
        },
        '确认清空'
      );
      break;
    case 'reset-all':
      showDialog(
        '全部清零？',
        '抽签结果和预指定号码都会被清空，一切从头开始。操作不可撤销。',
        async () => {
          try {
            await adminPost('/admin/reset', { scope: 'all' });
            closeOverlay();
            await load(true);
            toast('已全部清零');
          } catch (err) {
            closeOverlay();
            toast(err.message);
          }
        },
        '确认清零'
      );
      break;
    case 'copy-list': {
      const ok = await copyText(buildListText());
      toast(ok ? '名单已复制，可直接粘贴到群里' : '复制失败，请手动选择文本');
      break;
    }
    case 'copy-link': {
      const url = location.origin + location.pathname;
      const ok = await copyText(url);
      toast(ok ? '链接已复制，去群里粘贴吧' : '复制失败：' + url);
      break;
    }
    case 'export-data': {
      try {
        const res = await fetch('/api/admin/export?adminToken=' + encodeURIComponent(S.adminToken));
        if (!res.ok) throw new Error('导出失败，请重新登录管理员');
        const text = await res.text();
        const blob = new Blob([text], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '抽签备份-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
        toast('备份已导出到下载文件夹');
      } catch (err) {
        toast(err.message);
      }
      break;
    }
    case 'import-data': {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'application/json,.json';
      inp.onchange = async () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        try {
          const txt = await f.text();
          const data = JSON.parse(txt);
          const r = await adminPost('/admin/import', { data: data });
          await load(true);
          toast('已恢复 ' + r.imported.draws + ' 条记录、' + r.imported.assignments + ' 个预指定');
        } catch (err) {
          toast(err.message || '文件格式不正确');
        }
      };
      inp.click();
      break;
    }
    case 'change-pwd': {
      const pwd = window.prompt('设置新的管理员密码（至少 4 位）');
      if (!pwd) break;
      if (pwd.trim().length < 4) {
        toast('密码至少 4 位');
        break;
      }
      try {
        const r = await adminPost('/admin/password', { password: pwd.trim() });
        if (r.adminToken) {
          S.adminToken = r.adminToken;
          localStorage.setItem('ls_admin', r.adminToken);
        }
        toast('密码已修改');
      } catch (err) {
        toast(err.message);
      }
      break;
    }
    default:
      break;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const t = e.target;
  if (!t || !t.id) return;
  if (t.id === 'nameInput') confirmDraw();
  else if (t.id === 'recoverName') doRecover();
  else if (t.id === 'adminPwd') doAdminLogin();
  else if (t.id === 'assignName') doAssign();
});

document.addEventListener('focusout', () => {
  if (S.pendingRender) setTimeout(() => render(), 0);
});

$('overlay').addEventListener('click', (e) => {
  if (e.target === $('overlay')) {
    // 抽签结果弹层不允许误触关闭
    return;
  }
});

/* ------------------------------------------------------------------ */
/* 实时同步                                                            */
/* ------------------------------------------------------------------ */

function subscribe() {
  if (!window.EventSource) {
    setInterval(() => load(true), 8000);
    return;
  }
  let es;
  try {
    es = new EventSource('/api/events');
  } catch (e) {
    setInterval(() => load(true), 8000);
    return;
  }
  es.onmessage = (ev) => {
    let v = null;
    try {
      v = JSON.parse(ev.data).version;
    } catch (e) {
      return;
    }
    if (S.state && v === S.state.version) return;
    load(true);
  };
  es.onerror = () => {
    // EventSource 会自动重连
  };
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load(true);
});

setInterval(() => {
  if (!document.hidden) load(true);
}, 20000);

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

S.adminOk = adminTokenAlive();

(async function boot() {
  await load(false);
  subscribe();
})();
