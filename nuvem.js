'use strict';

/* ============================================================
 * Conta e nuvem (Supabase)
 *  - Login por e-mail e senha.
 *  - Uma loja tem vários membros (dono + funcionários por convite).
 *  - Offline primeiro: o app usa os dados do aparelho e sincroniza
 *    quando há internet. Envia o que mudou (comparando com a última
 *    versão sincronizada) e baixa o que mudou na nuvem (updated_at).
 * Depende de app.js (db, saveDb, toast, ...). Carregado antes dele.
 * ============================================================ */

const CLOUD_CFG = window.VALIDADE_CONFIG || {};
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/dist/umd/supabase.js';
const SYNC_KEY = 'validade-certa:sync';
const SYNC_TABLES = ['products', 'lots', 'movements', 'imports'];
const SERVER_TABLE = { products: 'products', lots: 'lots', movements: 'movements', imports: 'nfe_imports' };
const PAGE = 1000;

let sb = null;
let cloudUser = null;
let syncing = false;
let syncAgain = false;
let syncTimer = null;
let applyingRemote = false;
let cloudMsg = { info: '', error: '' };
let cloudState = { status: 'off', lastSync: null };
let cloudMembers = null;
let syncMeta = loadSyncMeta();

/* ---------- estado local da sincronização ---------- */
function emptySyncMeta() {
  return {
    storeId: '', storeName: '', role: '', inviteCode: '', email: '',
    cursor: {}, snap: { products: {}, lots: {}, movements: {}, imports: {}, settings: '' },
  };
}
function loadSyncMeta() {
  try {
    const m = JSON.parse(localStorage.getItem(SYNC_KEY));
    if (m && m.snap) return { ...emptySyncMeta(), ...m };
  } catch (e) { /* ignora */ }
  return emptySyncMeta();
}
function saveSyncMeta() {
  try { localStorage.setItem(SYNC_KEY, JSON.stringify(syncMeta)); } catch (e) { /* ignora */ }
}

const cloudConfigured = () => !!(CLOUD_CFG.supabaseUrl && CLOUD_CFG.supabaseAnonKey);
function cloudConnected() { return !!(cloudUser && syncMeta.storeId); }

/* ---------- conversão aparelho <-> servidor ---------- */
const nn = (v) => (v === '' || v === undefined ? null : v);
const s0 = (v) => (v == null ? '' : String(v));
const numOrNull = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

const TO_SERVER = {
  products: (p) => ({
    id: p.id, barcode: nn(p.barcode), name: p.name || '', category: nn(p.category),
    cost: numOrNull(p.cost), supplier_code: nn(p.supplierCode),
  }),
  lots: (l) => ({
    id: l.id, product_id: l.productId, lot: nn(l.lot), expiry: l.expiry, initial_qty: Number(l.initialQty) || 0,
    location: nn(l.location), supplier: nn(l.supplier), invoice: nn(l.invoice), created_at: nn(l.createdAt),
    deleted: !!l.deleted,
  }),
  movements: (m) => ({
    id: m.id, lot_id: nn(m.lotId), product_id: nn(m.productId), type: m.type, qty: Number(m.qty) || 0,
    unit_cost: Number(m.unitCost) || 0, date: m.date, note: nn(m.note),
  }),
  imports: (i) => ({
    id: i.id, key: nn(i.key), number: nn(i.number), supplier: nn(i.supplier), date: nn(i.date),
    imported_at: nn(i.importedAt), lots: Number(i.lots) || 0,
  }),
};

const FROM_SERVER = {
  products: (r) => {
    const p = { id: r.id, barcode: s0(r.barcode), name: s0(r.name), category: s0(r.category) };
    if (r.cost != null) p.cost = Number(r.cost);
    if (r.supplier_code) p.supplierCode = r.supplier_code;
    return p;
  },
  lots: (r) => {
    const l = {
      id: r.id, productId: r.product_id, lot: s0(r.lot), expiry: r.expiry, initialQty: Number(r.initial_qty) || 0,
      qty: Number(r.initial_qty) || 0, location: s0(r.location), supplier: s0(r.supplier), invoice: s0(r.invoice),
      createdAt: s0(r.created_at),
    };
    if (r.deleted) l.deleted = true;
    return l;
  },
  movements: (r) => ({
    id: r.id, lotId: s0(r.lot_id), productId: s0(r.product_id), type: r.type, qty: Number(r.qty) || 0,
    unitCost: Number(r.unit_cost) || 0, date: r.date, note: s0(r.note),
  }),
  imports: (r) => ({
    id: r.id, key: s0(r.key), number: s0(r.number), supplier: s0(r.supplier), date: s0(r.date),
    importedAt: s0(r.imported_at), lots: Number(r.lots) || 0,
  }),
};

const ser = (t, row) => JSON.stringify(TO_SERVER[t](row));
const serSettings = () => JSON.stringify({
  name: db.settings.storeName || '', critical_days: db.settings.criticalDays, warn_days: db.settings.warnDays,
});

function localRows(t) { return t === 'products' ? Object.values(db.products) : db[t]; }
function findLocal(t, id) { return t === 'products' ? db.products[id] : db[t].find((x) => x.id === id); }
function putLocal(t, row) {
  if (t === 'products') { db.products[row.id] = row; return; }
  const i = db[t].findIndex((x) => x.id === row.id);
  if (i >= 0) db[t][i] = row; else db[t].push(row);
}

function pendingCount() {
  if (!syncMeta.storeId) return 0;
  let n = 0;
  for (const t of SYNC_TABLES) for (const r of localRows(t)) if (syncMeta.snap[t][r.id] !== ser(t, r)) n++;
  if (syncMeta.role === 'owner' && syncMeta.snap.settings !== '__pull__' && serSettings() !== syncMeta.snap.settings) n++;
  return n;
}

/* ---------- cliente Supabase ---------- */
function loadCloudScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to fetch'));
    document.head.appendChild(s);
  });
}

async function ensureClient() {
  if (sb) return sb;
  if (!cloudConfigured()) throw new Error('Nuvem não configurada');
  if (!window.supabase) await loadCloudScript(SUPABASE_JS);
  sb = window.supabase.createClient(CLOUD_CFG.supabaseUrl, CLOUD_CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  sb.auth.onAuthStateChange((event, session) => {
    cloudUser = session?.user || null;
    if (event === 'PASSWORD_RECOVERY') setTimeout(askNewPassword, 300);
    renderCloudPanel();
  });
  return sb;
}

function friendlyError(e) {
  const msg = String(e?.message || e || '');
  if (/invalid login credentials/i.test(msg)) return 'E-mail ou senha incorretos.';
  if (/already registered|already been registered/i.test(msg)) return 'Este e-mail já tem conta. Use “Entrar”.';
  if (/email not confirmed/i.test(msg)) return 'Confirme seu e-mail antes de entrar (veja sua caixa de entrada e o spam).';
  if (/password.*(6|characters)|weak/i.test(msg)) return 'A senha precisa ter pelo menos 6 caracteres.';
  if (/rate limit|too many/i.test(msg)) return 'Muitas tentativas. Aguarde alguns minutos.';
  if (/convite/i.test(msg)) return 'Código de convite inválido.';
  if (/failed to fetch|network|load failed/i.test(msg)) return 'Sem conexão com a internet.';
  return msg || 'Erro inesperado.';
}

/* ---------- sincronização ---------- */
function setCloudState(status) {
  cloudState.status = status;
  renderSyncBadge();
  if (location.hash.startsWith('#ajustes')) renderCloudStatus();
}

function scheduleSync(delay = 1500) {
  if (!cloudConnected()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, delay);
}

/** Chamado por saveDb() a cada alteração local. */
function cloudOnLocalChange() {
  if (applyingRemote || !cloudConnected()) return;
  setCloudState(navigator.onLine ? 'pending' : 'offline');
  scheduleSync();
}

async function syncNow() {
  if (!cloudConnected()) return;
  if (syncing) { syncAgain = true; return; }
  if (!navigator.onLine) { setCloudState('offline'); return; }
  syncing = true;
  setCloudState('syncing');
  try {
    await pushChanges();
    await pullChanges();
    cloudState.lastSync = new Date();
    setCloudState(pendingCount() ? 'pending' : 'idle');
  } catch (e) {
    console.error('sync', e);
    if (e && e.lostAccess) return; // tratado em pullChanges
    cloudMsg.error = friendlyError(e);
    setCloudState(navigator.onLine ? 'error' : 'offline');
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(300); }
  }
}

async function pushChanges() {
  const sid = syncMeta.storeId;
  for (const t of SYNC_TABLES) {
    const changed = localRows(t).filter((r) => syncMeta.snap[t][r.id] !== ser(t, r));
    for (let i = 0; i < changed.length; i += 500) {
      const chunk = changed.slice(i, i + 500);
      const sers = chunk.map((r) => ser(t, r)); // versão enviada (antes de esperar a rede)
      const payload = sers.map((s) => ({ ...JSON.parse(s), store_id: sid }));
      const { error } = await sb.from(SERVER_TABLE[t]).upsert(payload, { onConflict: 'store_id,id' });
      if (error) throw error;
      chunk.forEach((r, k) => { syncMeta.snap[t][r.id] = sers[k]; });
      saveSyncMeta();
    }
  }
  const s = serSettings();
  if (syncMeta.role === 'owner' && syncMeta.snap.settings !== '__pull__' && s !== syncMeta.snap.settings) {
    const { error } = await sb.from('stores').update(JSON.parse(s)).eq('id', sid);
    if (error) throw error;
    syncMeta.snap.settings = s;
    saveSyncMeta();
  }
}

async function pullChanges() {
  const sid = syncMeta.storeId;
  let changed = false;

  const { data: st, error: stErr } = await sb.from('stores').select('*').eq('id', sid).single();
  if (stErr || !st) {
    if (stErr && stErr.code !== 'PGRST116') throw stErr;
    await lostStoreAccess();
    const err = new Error('lost access'); err.lostAccess = true; throw err;
  }
  syncMeta.storeName = st.name;
  syncMeta.inviteCode = st.invite_code;
  const remote = JSON.stringify({ name: st.name || '', critical_days: st.critical_days, warn_days: st.warn_days });
  // Ajustes: o dono manda; para os demais, vale o da nuvem
  if (remote !== syncMeta.snap.settings
      && (syncMeta.snap.settings === '__pull__' || syncMeta.role !== 'owner'
        || serSettings() === syncMeta.snap.settings)) {
    db.settings.storeName = st.name || '';
    db.settings.criticalDays = st.critical_days;
    db.settings.warnDays = st.warn_days;
    changed = true;
  }
  syncMeta.snap.settings = remote;

  for (const t of SYNC_TABLES) {
    let cursor = syncMeta.cursor[t] || '1970-01-01T00:00:00Z';
    let first = true;
    for (;;) {
      let q = sb.from(SERVER_TABLE[t]).select('*').eq('store_id', sid);
      // a 1ª página repete o último instante (gte) para não perder linhas gravadas no mesmo momento
      q = first ? q.gte('updated_at', cursor) : q.gt('updated_at', cursor);
      const { data, error } = await q.order('updated_at', { ascending: true }).limit(PAGE);
      if (error) throw error;
      first = false;
      for (const r of data) {
        const row = FROM_SERVER[t](r);
        const s = ser(t, row);
        const local = findLocal(t, row.id);
        if (local && ser(t, local) !== syncMeta.snap[t][row.id] && ser(t, local) !== s) continue; // alteração local ainda não enviada
        if (!local || ser(t, local) !== s) { putLocal(t, row); changed = true; }
        syncMeta.snap[t][row.id] = s;
      }
      if (data.length) cursor = data[data.length - 1].updated_at;
      syncMeta.cursor[t] = cursor;
      if (data.length < PAGE) break;
    }
  }
  saveSyncMeta();
  if (changed) {
    applyingRemote = true;
    try { saveDb(); } finally { applyingRemote = false; }
    $('#store-name').textContent = db.settings.storeName || 'Controle de validade';
    rerender();
  }
}

async function lostStoreAccess() {
  const name = syncMeta.storeName;
  wipeLocal();
  cloudMsg.error = `Você não tem mais acesso à loja “${name}”. Os dados dela foram removidos deste aparelho.`;
  setCloudState('off');
  route();
  renderCloudPanel();
  toast(cloudMsg.error);
}

function wipeLocal() {
  const keepNotify = db.settings.lastNotified;
  applyingRemote = true;
  try {
    db = structuredClone(DEFAULT_DB);
    db.settings.lastNotified = keepNotify;
    saveDb();
  } finally { applyingRemote = false; }
  const email = syncMeta.email;
  syncMeta = emptySyncMeta();
  syncMeta.email = email;
  saveSyncMeta();
}

/* ---------- conta e loja ---------- */
function localDataCount() { return db.lots.filter((l) => !l.deleted).length + Object.keys(db.products).length; }

async function afterLogin() {
  cloudMsg = { info: '', error: '' };
  syncMeta.email = cloudUser?.email || '';
  const { data, error } = await sb.from('store_members').select('*').eq('user_id', cloudUser.id);
  if (error) throw error;
  if (data && data.length) {
    const m = data.find((x) => x.role === 'owner') || data[0];
    const { data: st, error: e2 } = await sb.from('stores').select('*').eq('id', m.store_id).single();
    if (e2) throw e2;
    await connectStore(st, m.role, false);
  } else {
    renderCloudPanel();
  }
}

/**
 * Liga este aparelho a uma loja. Se o aparelho já tem dados que não são da
 * loja, pergunta se envia para a loja ou descarta.
 */
async function connectStore(store, role, keepLocal) {
  if (!keepLocal && localDataCount() > 0) {
    const send = confirm(`Este aparelho já tem ${db.lots.filter((l) => !l.deleted).length} lote(s) cadastrados.\n\n`
      + `OK = enviar esses dados para a loja “${store.name}”.\n`
      + 'Cancelar = descartar os dados deste aparelho e usar só os da loja.');
    if (!send) wipeLocal();
  }
  const email = cloudUser?.email || syncMeta.email;
  syncMeta = { ...emptySyncMeta(), storeId: store.id, storeName: store.name, role, inviteCode: store.invite_code, email };
  if (role === 'owner' && keepLocal) {
    // loja recém-criada: os ajustes deste aparelho vão para a nuvem
    db.settings.storeName = store.name || db.settings.storeName;
  } else {
    syncMeta.snap.settings = '__pull__'; // força receber os ajustes da loja
  }
  saveSyncMeta();
  applyingRemote = true;
  try { saveDb(); } finally { applyingRemote = false; }
  cloudMembers = null;
  renderCloudPanel();
  await syncNow();
  $('#store-name').textContent = db.settings.storeName || 'Controle de validade';
  rerender();
  if (role === 'owner') loadMembers();
}

async function doSignIn(email, password) {
  await ensureClient();
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  cloudUser = data.user;
  await afterLogin();
}

async function doSignUp(email, password) {
  await ensureClient();
  const { data, error } = await sb.auth.signUp({
    email, password, options: { emailRedirectTo: location.origin + location.pathname },
  });
  if (error) throw error;
  // O Supabase não revela se o e-mail já existe: devolve um usuário sem "identities" e não envia e-mail
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new Error('User already registered');
  }
  if (data.session) {
    cloudUser = data.user;
    await afterLogin();
  } else {
    cloudMsg.info = `Conta criada! Enviamos um e-mail de confirmação para ${email}. Clique no link e depois volte aqui para entrar.`;
  }
}

async function doCreateStore(name) {
  const { data, error } = await sb.rpc('create_store', { p_name: name });
  if (error) throw error;
  db.settings.storeName = data.name;
  await connectStore(data, 'owner', true);
  toast('Loja criada! Os dados deste aparelho foram enviados para a nuvem.');
}

async function doJoinStore(code) {
  const { data, error } = await sb.rpc('join_store', { p_code: code });
  if (error) throw error;
  const { data: me } = await sb.from('store_members').select('*').eq('store_id', data.id).eq('user_id', cloudUser.id);
  await connectStore(data, me?.[0]?.role || 'staff', false);
  toast(`Você entrou na loja “${data.name}”.`);
}

async function doSignOut() {
  const pend = pendingCount();
  if (pend && !confirm(`Há ${pend} alteração(ões) ainda não enviadas para a nuvem (sem internet?). `
    + 'Se sair agora, elas serão perdidas. Sair mesmo assim?')) return;
  if (!confirm('Sair da conta? Os dados da loja serão removidos deste aparelho (continuam salvos na nuvem).')) return;
  try { await sb.auth.signOut(); } catch (e) { /* sai localmente mesmo offline */ }
  cloudUser = null;
  wipeLocal();
  syncMeta.email = '';
  saveSyncMeta();
  cloudMembers = null;
  cloudMsg = { info: '', error: '' };
  setCloudState('off');
  route();
  toast('Você saiu da conta.');
}

async function doResetPassword(email) {
  await ensureClient();
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) throw error;
  cloudMsg.info = `Se ${email} tiver conta, enviamos um link para criar uma nova senha.`;
}

async function askNewPassword() {
  const pw = prompt('Digite sua nova senha (mínimo 6 caracteres):');
  if (!pw) return;
  const { error } = await sb.auth.updateUser({ password: pw });
  toast(error ? friendlyError(error) : 'Senha alterada!');
  if (!error && cloudUser && !syncMeta.storeId) afterLogin().catch(() => {});
}

async function loadMembers() {
  if (!cloudConnected()) return;
  const { data, error } = await sb.from('store_members').select('*').eq('store_id', syncMeta.storeId);
  if (!error) { cloudMembers = data; renderCloudPanel(); }
}

async function removeMember(userId, email) {
  if (!confirm(`Remover ${email || 'este usuário'} da loja? Ele perde o acesso aos dados.`)) return;
  const { error } = await sb.from('store_members').delete().eq('store_id', syncMeta.storeId).eq('user_id', userId);
  if (error) throw error;
  toast('Acesso removido.');
  loadMembers();
}

async function newInviteCode() {
  if (!confirm('Gerar um novo código? O código atual deixa de funcionar (quem já entrou continua na loja).')) return;
  const { data, error } = await sb.rpc('new_invite_code', { p_store: syncMeta.storeId });
  if (error) throw error;
  syncMeta.inviteCode = data;
  saveSyncMeta();
  renderCloudPanel();
}

function shareInvite() {
  const url = location.origin + location.pathname;
  const text = `Use o app Validade Certa da loja “${syncMeta.storeName}”.\n1. Abra ${url}\n`
    + `2. Ajustes → Criar conta\n3. Entre na loja com o código: ${syncMeta.inviteCode}`;
  if (navigator.share) navigator.share({ title: 'Validade Certa', text }).catch(() => {});
  else navigator.clipboard?.writeText(text).then(() => toast('Convite copiado!'), () => toast(text));
}

/* ---------- interface ---------- */
const STATUS_TEXT = {
  off: '', idle: 'Sincronizado', syncing: 'Sincronizando…', pending: 'Alterações a enviar',
  offline: 'Sem internet — salvo no aparelho', error: 'Erro ao sincronizar',
};

function renderSyncBadge() {
  const b = $('#sync-badge');
  if (!b) return;
  if (!cloudConnected()) { b.hidden = true; return; }
  b.hidden = false;
  const icon = { idle: '☁️✓', syncing: '☁️…', pending: '☁️↑', offline: '☁️✕', error: '☁️!' }[cloudState.status] || '☁️';
  b.textContent = icon;
  b.title = STATUS_TEXT[cloudState.status] || '';
  b.className = cloudState.status;
}

function renderCloudStatus() {
  const el = $('#cloud-status');
  if (!el) return;
  const st = cloudState.status;
  const when = cloudState.lastSync ? ` · ${cloudState.lastSync.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : '';
  el.innerHTML = `<span class="dot ${st}"></span><span>${STATUS_TEXT[st] || ''}${st === 'idle' ? when : ''}</span>`;
}

function renderCloudPanel() {
  const el = $('#cloud-panel');
  if (!el) return;
  const msgs = (cloudMsg.info ? `<p class="info-msg">${esc(cloudMsg.info)}</p>` : '')
    + (cloudMsg.error ? `<p class="error-msg">${esc(cloudMsg.error)}</p>` : '');

  // Ajustes da loja: só o dono altera
  const staff = cloudConnected() && syncMeta.role !== 'owner';
  $$('#form-settings input, #form-settings button').forEach((i) => { i.disabled = staff; });
  const note = $('#settings-note');
  if (staff && !note) $('#form-settings h2').insertAdjacentHTML('afterend', '<p class="muted small" id="settings-note">Só o dono da loja pode alterar estes ajustes.</p>');
  if (!staff && note) note.remove();

  if (!cloudConfigured()) {
    el.innerHTML = `<h3>Conta e nuvem</h3>
      <p class="muted small">A sincronização na nuvem ainda não foi configurada neste app.
      Enquanto isso, os dados ficam salvos só neste aparelho.</p>`;
    return;
  }

  if (!cloudUser) {
    el.innerHTML = `<h3>Conta e nuvem</h3>
      <p class="muted small">Entre para guardar os dados na nuvem, usar em vários celulares e com seus funcionários.
      Sem conta, o app funciona só neste aparelho.</p>
      ${msgs}
      <label>E-mail<input type="email" id="cl-email" autocomplete="email" inputmode="email" value="${esc(syncMeta.email)}"></label>
      <label>Senha<input type="password" id="cl-pass" autocomplete="current-password" minlength="6"></label>
      <div class="row wrap">
        <button type="button" class="btn" data-act="signin">Entrar</button>
        <button type="button" class="btn secondary" data-act="signup">Criar conta</button>
      </div>
      <button type="button" class="linkbtn" data-act="reset">Esqueci minha senha</button>`;
    return;
  }

  if (!syncMeta.storeId) {
    el.innerHTML = `<h3>Conta e nuvem</h3>
      <p class="small">Conectado como <b>${esc(cloudUser.email)}</b>.</p>
      ${msgs}
      <p class="muted small">Agora escolha:</p>
      <label>Sou o dono — criar minha loja
        <div class="row"><input id="cl-store" placeholder="Nome da loja" value="${esc(db.settings.storeName)}">
        <button type="button" class="btn" data-act="create">Criar</button></div>
      </label>
      <label>Sou funcionário — tenho um código de convite
        <div class="row"><input id="cl-code" placeholder="Ex.: A1B2C3D4E5" autocapitalize="characters">
        <button type="button" class="btn secondary" data-act="join">Entrar</button></div>
      </label>
      <hr class="divider">
      <button type="button" class="linkbtn" data-act="signout">Sair da conta</button>`;
    return;
  }

  const owner = syncMeta.role === 'owner';
  const members = owner && cloudMembers ? `
      <h3>Pessoas com acesso</h3>
      <ul class="members">${cloudMembers.map((m) => `
        <li><span>${esc(m.email || '(sem e-mail)')}${m.user_id === cloudUser.id ? ' (você)' : ''}
          <span class="tag">${m.role === 'owner' ? 'Dono' : 'Funcionário'}</span></span>
          ${m.role !== 'owner' ? `<button type="button" class="btn small danger ghost" data-act="remove" data-user="${esc(m.user_id)}" data-email="${esc(m.email || '')}">Remover</button>` : ''}
        </li>`).join('')}</ul>` : '';
  el.innerHTML = `<h3>Conta e nuvem</h3>
    <p class="small">Loja <b>${esc(syncMeta.storeName || '(sem nome)')}</b> · ${esc(cloudUser.email)} · ${owner ? 'Dono' : 'Funcionário'}</p>
    ${msgs}
    <div class="row between wrap">
      <div class="cloud-status" id="cloud-status"></div>
      <button type="button" class="btn small secondary" data-act="sync">Sincronizar agora</button>
    </div>
    ${owner ? `
      <h3>Convidar funcionários</h3>
      <div class="invite"><span class="muted small">Código de convite</span><code>${esc(syncMeta.inviteCode)}</code>
        <div class="row"><button type="button" class="btn small" data-act="share">Enviar convite</button>
        <button type="button" class="btn small secondary" data-act="newcode">Novo código</button></div>
      </div>` : ''}
    ${members}
    <hr class="divider">
    <button type="button" class="linkbtn" data-act="signout">Sair da conta</button>`;
  renderCloudStatus();
  if (owner && !cloudMembers) loadMembers();
}

/** Ao abrir Ajustes: redesenha e atualiza a lista de pessoas com acesso. */
function refreshCloudPanel() {
  renderCloudPanel();
  if (cloudConnected() && syncMeta.role === 'owner' && cloudMembers) loadMembers();
}

async function onCloudAction(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const val = (id) => ($(`#${id}`)?.value || '').trim();
  cloudMsg = { info: '', error: '' };
  btn.disabled = true;
  try {
    if (act === 'signin' || act === 'signup') {
      const email = val('cl-email');
      const pass = $('#cl-pass').value;
      if (!email || !pass) throw new Error('Preencha e-mail e senha.');
      syncMeta.email = email;
      if (act === 'signin') await doSignIn(email, pass); else await doSignUp(email, pass);
    } else if (act === 'reset') {
      const email = val('cl-email');
      if (!email) throw new Error('Digite seu e-mail no campo acima e toque de novo em “Esqueci minha senha”.');
      await doResetPassword(email);
    } else if (act === 'create') {
      await doCreateStore(val('cl-store'));
    } else if (act === 'join') {
      if (!val('cl-code')) throw new Error('Digite o código de convite.');
      await doJoinStore(val('cl-code'));
    } else if (act === 'signout') {
      await doSignOut();
    } else if (act === 'sync') {
      await syncNow();
    } else if (act === 'share') {
      shareInvite();
    } else if (act === 'newcode') {
      await newInviteCode();
    } else if (act === 'remove') {
      await removeMember(btn.dataset.user, btn.dataset.email);
    }
  } catch (err) {
    console.error(err);
    cloudMsg.error = friendlyError(err);
  } finally {
    btn.disabled = false;
    renderCloudPanel();
  }
}

/* ---------- início ---------- */
function cloudInit() {
  $('#cloud-panel').addEventListener('click', onCloudAction);
  window.addEventListener('online', () => scheduleSync(300));
  window.addEventListener('offline', () => { if (cloudConnected()) setCloudState('offline'); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(300); });
  setInterval(() => { if (!document.hidden) scheduleSync(0); }, 60000);
  renderCloudPanel();
  if (cloudConfigured()) cloudStart();
}

async function cloudStart() {
  // Só carrega a biblioteca se a pessoa já usou conta neste aparelho (ou veio de um link de e-mail)
  const fromEmailLink = /access_token|type=recovery|type=signup/.test(location.hash);
  const hadSession = Object.keys(localStorage).some((k) => /^sb-.*-auth-token$/.test(k));
  if (!syncMeta.storeId && !fromEmailLink && !hadSession) return;

  try {
    await ensureClient();
    const { data } = await sb.auth.getSession();
    cloudUser = data.session?.user || null;
    if (fromEmailLink) history.replaceState(null, '', '#ajustes');
    if (!cloudUser) { renderCloudPanel(); return; }
    if (syncMeta.storeId) {
      renderSyncBadge();
      await syncNow();
    } else {
      await afterLogin();
    }
  } catch (e) {
    console.error(e);
    // sem internet ao abrir: continua com os dados do aparelho e tenta depois
    if (syncMeta.storeId) {
      cloudUser = cloudUser || { email: syncMeta.email, id: '' };
      setCloudState('offline');
      window.addEventListener('online', () => { sb = null; cloudStart(); }, { once: true });
    }
  }
  renderCloudPanel();
  rerender();
}
