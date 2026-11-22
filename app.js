'use strict';

/* ============================================================
 * Validade Certa — controle de validade para comércio (PWA)
 * Dados salvos localmente (localStorage) no aparelho.
 * ============================================================ */

const STORAGE_KEY = 'validade-certa:v1';
const DEFAULT_DB = {
  products: {},   // id -> { id, barcode, name, category, cost }
  // qty é calculada: initialQty + entradas − saídas (movimentações). Assim duas pessoas
  // podem dar baixa no mesmo lote ao mesmo tempo sem uma sobrescrever a outra.
  lots: [],       // { id, productId, lot, expiry: 'YYYY-MM-DD', initialQty, qty, location, createdAt, deleted? }
  movements: [],  // { id, lotId, productId, type, qty, unitCost, date, note }
  imports: [],    // notas fiscais importadas: { id, key, number, supplier, date, importedAt, lots }
  settings: { storeName: '', criticalDays: 7, warnDays: 30, lastNotified: '' },
};

const STATUS_LABEL = { vencido: 'Vencido', critico: 'Crítico', atencao: 'Atenção', ok: 'OK' };
const MOVE_LABEL = {
  venda: 'Vendido', promocao: 'Promoção', descarte: 'Descarte',
  devolucao: 'Devolução', ajuste: 'Ajuste', entrada: 'Entrada',
};

let db = loadDb();
let lotFilter = 'todos';

/* ---------- utilidades ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDate = (iso) => iso ? iso.split('-').reverse().join('/') : '';

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDaysISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
function daysUntil(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const [ty, tm, td] = todayISO().split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86400000);
}
function statusOf(days) {
  const s = db.settings;
  if (days < 0) return 'vencido';
  if (days <= s.criticalDays) return 'critico';
  if (days <= s.warnDays) return 'atencao';
  return 'ok';
}
function daysText(d) {
  if (d < -1) return `venceu há ${-d} dias`;
  if (d === -1) return 'venceu ontem';
  if (d === 0) return 'vence hoje';
  if (d === 1) return 'vence amanhã';
  return `vence em ${d} dias`;
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------- persistência ---------- */
function loadDb() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (raw && Array.isArray(raw.lots)) return normalizeDb(raw);
  } catch (e) { /* dados corrompidos ou indisponíveis */ }
  return structuredClone(DEFAULT_DB);
}
function normalizeDb(raw) {
  const out = {
    products: raw.products || {},
    lots: raw.lots || [],
    movements: raw.movements || [],
    imports: raw.imports || [],
    settings: { ...DEFAULT_DB.settings, ...(raw.settings || {}) },
  };
  // Migração: versões antigas guardavam só a quantidade atual do lote
  const delta = movementDelta(out.movements);
  out.lots.forEach((l) => {
    if (l.initialQty === undefined) l.initialQty = (Number(l.qty) || 0) - (delta[l.id] || 0);
  });
  out.imports.forEach((i, idx) => {
    if (!i.id) i.id = i.key || `imp-${idx}-${i.importedAt || ''}`;
  });
  recomputeQty(out);
  return out;
}

/** Soma das movimentações por lote: entradas somam, saídas subtraem. */
function movementDelta(movements) {
  const delta = {};
  for (const m of movements) {
    if (!m.lotId) continue;
    delta[m.lotId] = (delta[m.lotId] || 0) + (m.type === 'entrada' ? 1 : -1) * (Number(m.qty) || 0);
  }
  return delta;
}

function recomputeQty(target = db) {
  const delta = movementDelta(target.movements);
  target.lots.forEach((l) => { l.qty = Math.max(0, (Number(l.initialQty) || 0) + (delta[l.id] || 0)); });
}

function saveDb() {
  recomputeQty();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch (e) {
    toast('Não foi possível salvar: armazenamento cheio ou bloqueado.');
  }
  if (typeof cloudOnLocalChange === 'function') cloudOnLocalChange();
}

/* ---------- consultas ---------- */
function activeLots() {
  return db.lots
    .filter((l) => !l.deleted && l.qty > 0)
    .map((l) => {
      const product = db.products[l.productId] || { name: '(produto removido)' };
      const days = daysUntil(l.expiry);
      return { ...l, product, days, status: statusOf(days) };
    })
    .sort((a, b) => a.expiry.localeCompare(b.expiry) || a.product.name.localeCompare(b.product.name));
}

function lotItemHTML(l) {
  const p = l.product;
  const meta = [
    p.barcode && `EAN ${esc(p.barcode)}`,
    l.lot && `Lote ${esc(l.lot)}`,
    l.location && esc(l.location),
    l.supplier && esc(l.supplier) + (l.invoice ? ` (NF ${esc(l.invoice)})` : ''),
  ].filter(Boolean).join(' · ');
  return `
    <li class="lot ${l.status}">
      <div class="info">
        <div class="name">${esc(p.name)}</div>
        <div class="when">${fmtDate(l.expiry)} — ${daysText(l.days)}</div>
        ${meta ? `<div class="meta">${meta}</div>` : ''}
      </div>
      <div class="qty"><b>${l.qty}</b><span>un.</span></div>
      <button class="btn small secondary" data-baixa="${esc(l.id)}">Baixa</button>
    </li>`;
}

/* ---------- views ---------- */
function renderPainel() {
  const lots = activeLots();
  const count = { vencido: 0, critico: 0, atencao: 0, ok: 0 };
  lots.forEach((l) => { count[l.status] += l.qty > 0 ? 1 : 0; });
  const s = db.settings;

  $('#summary').innerHTML = `
    <a class="card vencido" href="#lotes/vencido"><b>${count.vencido}</b><span>Vencidos</span></a>
    <a class="card critico" href="#lotes/critico"><b>${count.critico}</b><span>Até ${s.criticalDays} dias</span></a>
    <a class="card atencao" href="#lotes/atencao"><b>${count.atencao}</b><span>Até ${s.warnDays} dias</span></a>
    <a class="card ok" href="#lotes/ok"><b>${count.ok}</b><span>Em dia</span></a>`;

  const urgent = lots.filter((l) => l.status === 'vencido' || l.status === 'critico');
  $('#urgent').innerHTML = urgent.length
    ? urgent.slice(0, 15).map(lotItemHTML).join('')
      + (urgent.length > 15 ? `<li class="empty"><a href="#lotes/critico">Ver todos (${urgent.length})</a></li>` : '')
    : `<li class="empty">${lots.length ? 'Nada vencendo nos próximos dias. 👍' : 'Nenhum lote cadastrado ainda. Toque em <b>＋ Novo</b> para começar.'}</li>`;

  const value = (arr) => arr.reduce((sum, l) => sum + l.qty * (Number(l.product.cost) || 0), 0);
  const vencidoVal = value(lots.filter((l) => l.status === 'vencido'));
  const riscoVal = value(lots.filter((l) => l.status === 'critico'));
  const atencaoVal = value(lots.filter((l) => l.status === 'atencao'));
  $('#risk').innerHTML = `
    <h2>Valor em risco (custo)</h2>
    <div class="cards">
      <div class="card neutral"><b>${money(vencidoVal)}</b><span>já vencido</span></div>
      <div class="card neutral"><b>${money(riscoVal)}</b><span>vence em até ${s.criticalDays} dias</span></div>
      <div class="card neutral"><b>${money(atencaoVal)}</b><span>vence em até ${s.warnDays} dias</span></div>
      <div class="card neutral"><b>${money(value(lots))}</b><span>estoque total</span></div>
    </div>
    <p class="muted small" style="margin-top:8px">Dica: coloque em promoção ou negocie devolução com o fornecedor os itens críticos.</p>`;
}

function renderLotes() {
  const q = $('#search').value.trim().toLowerCase();
  $$('#filters .chip').forEach((c) => c.classList.toggle('active', c.dataset.f === lotFilter));
  const list = activeLots().filter((l) => {
    if (lotFilter !== 'todos' && l.status !== lotFilter) return false;
    if (!q) return true;
    const hay = [l.product.name, l.product.barcode, l.product.category, l.lot, l.location].join(' ').toLowerCase();
    return hay.includes(q);
  });
  $('#lots').innerHTML = list.length
    ? list.map(lotItemHTML).join('')
    : '<li class="empty">Nenhum lote encontrado.</li>';
}

function fillDatalists() {
  const products = Object.values(db.products);
  $('#product-names').innerHTML = products.map((p) => `<option value="${esc(p.name)}">`).join('');
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort();
  $('#categories').innerHTML = uniq(products.map((p) => p.category)).map((c) => `<option value="${esc(c)}">`).join('');
  $('#locations').innerHTML = uniq(db.lots.map((l) => l.location)).map((c) => `<option value="${esc(c)}">`).join('');
}

function renderNovo() {
  fillDatalists();
  updateExpiryHint();
}

/* Campo de validade digitado (dd/mm/aaaa) em vez do calendário nativo:
 * o calendário do celular abre no dia de hoje e é fácil confirmar sem mudar. */
function maskDate(value) {
  const d = value.replace(/\D/g, '').slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}/${d.slice(2)}`;
  return `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}`;
}

/** Valida a data digitada; devolve 'YYYY-MM-DD' ou '' (com mensagem). */
function readExpiry(value) {
  const iso = parseDateAny(value);
  if (!iso) return { iso: '', error: value.trim() ? 'Data inválida. Use dd/mm/aaaa, ex.: 17/11/2026' : '' };
  const year = Number(iso.slice(0, 4));
  const now = Number(todayISO().slice(0, 4));
  if (year < now - 5 || year > now + 15) return { iso: '', error: `Confira o ano (${year}).` };
  return { iso, error: '' };
}

function updateExpiryHint() {
  const input = $('#form-novo').expiry;
  const hint = $('#expiry-hint');
  const { iso, error } = readExpiry(input.value);
  input.setCustomValidity(error);
  if (!iso) {
    hint.className = `hint ${error ? 'summary-bad' : ''}`;
    hint.textContent = error || 'Digite só os números: 171126 → 17/11/2026. Mês/ano também vale: 1126.';
    return;
  }
  const days = daysUntil(iso);
  hint.className = `hint when-${statusOf(days)}`;
  hint.textContent = `${fmtDate(iso)} — ${daysText(days)}`;
}

function renderRelatorios() {
  const days = Number($('#period').value);
  const since = addDaysISO(todayISO(), -days + 1);
  const moves = db.movements.filter((m) => m.date >= since).sort((a, b) => b.date.localeCompare(a.date));

  const sum = (type) => moves.filter((m) => m.type === type)
    .reduce((acc, m) => ({ qty: acc.qty + m.qty, val: acc.val + m.qty * (m.unitCost || 0) }), { qty: 0, val: 0 });
  const perda = sum('descarte');
  const dev = sum('devolucao');
  const promo = sum('promocao');
  const venda = sum('venda');
  const salvos = promo.qty + venda.qty + dev.qty;
  const total = salvos + perda.qty;
  const taxa = total ? Math.round((salvos / total) * 100) : 0;

  $('#report-cards').innerHTML = `
    <div class="card vencido"><b>${money(perda.val)}</b><span>perdido (${perda.qty} un. descartadas)</span></div>
    <div class="card atencao"><b>${money(dev.val)}</b><span>recuperado em devolução (${dev.qty} un.)</span></div>
    <div class="card ok"><b>${promo.qty + venda.qty}</b><span>un. vendidas antes de vencer</span></div>
    <div class="card neutral"><b>${total ? taxa + '%' : '—'}</b><span>taxa de aproveitamento</span></div>`;

  const byProduct = {};
  moves.filter((m) => m.type === 'descarte').forEach((m) => {
    const p = db.products[m.productId];
    const key = m.productId;
    byProduct[key] ??= { name: p ? p.name : '(produto removido)', qty: 0, val: 0 };
    byProduct[key].qty += m.qty;
    byProduct[key].val += m.qty * (m.unitCost || 0);
  });
  const top = Object.values(byProduct).sort((a, b) => b.val - a.val || b.qty - a.qty).slice(0, 10);
  $('#top-losses').innerHTML = top.length
    ? top.map((t) => `<li>${esc(t.name)} — ${t.qty} un. · ${money(t.val)}</li>`).join('')
    : '<li class="muted" style="list-style:none;margin-left:-1.2rem">Nenhuma perda registrada no período. 🎉</li>';

  $('#movements').innerHTML = moves.length
    ? moves.slice(0, 100).map((m) => {
      const p = db.products[m.productId];
      return `<li class="mv"><span>${fmtDate(m.date)} · ${esc(p ? p.name : '(removido)')} — ${m.qty} un.${m.note ? ` <span class="muted small">(${esc(m.note)})</span>` : ''}</span>
        <span class="tag ${m.type}">${MOVE_LABEL[m.type] || m.type}</span></li>`;
    }).join('')
    : '<li class="muted">Nenhuma movimentação no período.</li>';
}

function renderAjustes() {
  if (typeof refreshCloudPanel === 'function') refreshCloudPanel();
  const f = $('#form-settings');
  f.storeName.value = db.settings.storeName;
  f.criticalDays.value = db.settings.criticalDays;
  f.warnDays.value = db.settings.warnDays;
  const btn = $('#btn-notify');
  if (!('Notification' in window)) {
    btn.disabled = true; btn.textContent = 'Notificações não suportadas neste navegador';
  } else if (Notification.permission === 'granted') {
    btn.textContent = 'Notificações ativadas ✓';
  } else if (Notification.permission === 'denied') {
    btn.textContent = 'Notificações bloqueadas no navegador';
  }
}

const RENDERERS = {
  painel: renderPainel, lotes: renderLotes, novo: renderNovo,
  relatorios: renderRelatorios, ajustes: renderAjustes, importar: renderImportar,
};

function route() {
  const [view = 'painel', arg] = location.hash.replace(/^#/, '').split('/');
  const name = RENDERERS[view] ? view : 'painel';
  if (name === 'lotes' && arg) lotFilter = arg;
  $$('#app > .view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  const tab = name === 'importar' ? 'novo' : name;
  $$('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  RENDERERS[name](arg);
  $('#store-name').textContent = db.settings.storeName || 'Controle de validade';
  window.scrollTo(0, 0);
}

function rerender() {
  const [view = 'painel', arg] = location.hash.replace(/^#/, '').split('/');
  (RENDERERS[view] || renderPainel)(arg);
}

/* ---------- cadastro ---------- */
function findProductByBarcode(code) {
  return code ? Object.values(db.products).find((p) => p.barcode === code) : undefined;
}
function findProductByName(name) {
  const n = name.trim().toLowerCase();
  return Object.values(db.products).find((p) => p.name.trim().toLowerCase() === n);
}

function fillFromProduct(p) {
  const f = $('#form-novo');
  if (!p) { $('#product-hint').textContent = ''; hideLastLot(); return; }
  f.name.value = p.name;
  if (!f.barcode.value && p.barcode) f.barcode.value = p.barcode;
  f.category.value = p.category || '';
  f.cost.value = p.cost ?? '';
  $('#product-hint').textContent = 'Produto já cadastrado — dados preenchidos.';
  showLastLot(p.id);
  f.expiry.focus();
}

/* Sugere o lote e a validade da última entrada do produto (não preenche sozinho,
 * para evitar salvar uma validade antiga por engano). */
function lastLotOf(productId) {
  let last = null;
  db.lots.forEach((l) => {
    if (l.deleted || l.productId !== productId) return;
    if (!last || (l.createdAt || '') >= (last.createdAt || '')) last = l;
  });
  return last;
}

function showLastLot(productId) {
  const box = $('#last-lot');
  const l = lastLotOf(productId);
  if (!l || (!l.lot && !l.expiry)) { hideLastLot(); return; }
  const parts = [l.lot && `lote <b>${esc(l.lot)}</b>`, l.expiry && `validade <b>${fmtDate(l.expiry)}</b>`].filter(Boolean);
  box.innerHTML = `<span>Última entrada: ${parts.join(' · ')}</span>
    <button type="button" class="btn small secondary" id="btn-last-lot">Usar</button>`;
  box.dataset.lot = l.lot || '';
  box.dataset.expiry = l.expiry || '';
  box.hidden = false;
}

function hideLastLot() {
  const box = $('#last-lot');
  if (box) { box.hidden = true; box.innerHTML = ''; }
}

function useLastLot() {
  const box = $('#last-lot');
  const f = $('#form-novo');
  if (box.dataset.lot) f.lot.value = box.dataset.lot;
  if (box.dataset.expiry) { f.expiry.value = fmtDate(box.dataset.expiry); updateExpiryHint(); }
  hideLastLot();
  f.qty.focus();
  f.qty.select();
}

/** Cria um lote, ou soma ao lote igual (mesmo produto, lote, validade e local). */
function addLot({ productId, expiry, qty, lot = '', location = '', supplier = '', invoice = '' }) {
  const existing = db.lots.find((l) => !l.deleted && l.productId === productId && l.expiry === expiry
    && (l.lot || '') === lot && (l.location || '') === location && l.qty > 0);
  if (existing) {
    db.movements.push({
      id: uid(), lotId: existing.id, productId, type: 'entrada', qty,
      unitCost: Number(db.products[productId]?.cost) || 0, date: todayISO(), note: invoice ? `NF ${invoice}` : '',
    });
    existing.qty += qty;
    return existing;
  }
  const created = {
    id: uid(), productId, lot, expiry, initialQty: qty, qty, location, supplier, invoice, createdAt: todayISO(),
  };
  db.lots.push(created);
  return created;
}

let formCode = ''; // código do produto que está no formulário agora
let scanExtra = '';  // "Código 2D lido: ..." para manter junto das outras mensagens

/* ---------- nome do produto pela base pública (Open Food Facts) ----------
 * O código de barras comum é só um número. Para produto novo, consultamos a
 * base gratuita Open Food Facts e preenchemos nome e categoria (o usuário confere). */
const OFF_URL = 'https://world.openfoodfacts.org/api/v2/product/';
const OFF_FIELDS = 'product_name_pt,product_name,generic_name_pt,generic_name,abbreviated_product_name,brands,quantity,categories_tags';
const productLookupCache = {};
const OFF_CATEGORIES = [
  [/beverage|bebida|drink|soda|refrigerante|juice|suco|water|agua|beer|cerveja|wine|vinho|coffee|cafe|tea/, 'Bebidas'],
  [/chocolate|cand|confection|sweet|doce|biscuit|cookie|bolacha|wafer|dessert|sobremesa/, 'Doces e biscoitos'],
  [/dair|milk|leite|yogurt|iogurte|cheese|queijo|butter|manteiga|cream|requeij/, 'Laticínios'],
  [/bread|pao|paes|bakery|cake|bolo/, 'Padaria'],
  [/meat|carne|ham|presunto|sausage|salsicha|linguica|cold-cut|frios|chicken|frango/, 'Frios e carnes'],
  [/frozen|congelad|ice-cream|sorvete/, 'Congelados'],
  [/cereal|pasta|massa|rice|arroz|bean|feijao|sauce|molho|condiment|oil|oleo|azeite|canned|conserva|flour|farinha|sugar|acucar|salt|sal|snack|salgad/, 'Mercearia'],
];

function validName(v) {
  const s = String(v || '').trim();
  return s.length >= 3 && /[a-zà-ú]{2}/i.test(s) ? s : '';
}

function offToProduct(p) {
  const brands = String(p.brands || '').split(',').map((b) => b.trim()).filter(Boolean);
  let name = [p.product_name_pt, p.product_name, p.generic_name_pt, p.generic_name, p.abbreviated_product_name]
    .map(validName).find(Boolean) || '';
  if (!name && brands.length) name = brands[brands.length - 1];
  if (!name) return null;
  if (name === name.toUpperCase()) name = name.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
  const low = name.toLowerCase();
  const norm = (x) => x.toLowerCase().replace(/\s+/g, '');
  if (brands.length && !brands.some((b) => low.includes(b.toLowerCase()))) name += ` ${brands[0]}`;
  const qty = String(p.quantity || '').trim();
  if (qty && !norm(name).includes(norm(qty))) name += ` ${qty}`;
  const tags = (p.categories_tags || []).join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const cat = (OFF_CATEGORIES.find(([re]) => re.test(tags)) || [])[1] || '';
  return { name, category: cat };
}

async function lookupProductOnline(code) {
  if (code in productLookupCache) return productLookupCache[code];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(`${OFF_URL}${encodeURIComponent(code)}?fields=${OFF_FIELDS}`, { signal: ctrl.signal });
    if (r.status === 404) { productLookupCache[code] = null; return null; }
    if (!r.ok) return null;
    const d = await r.json();
    const info = d.status === 1 && d.product ? offToProduct(d.product) : null;
    productLookupCache[code] = info;
    return info;
  } catch (e) {
    return null; // sem internet ou base fora do ar: segue o cadastro manual
  } finally {
    clearTimeout(timer);
  }
}

function setProductHint(msg) {
  $('#product-hint').textContent = msg + (scanExtra ? ` ${scanExtra}` : '');
}

async function suggestNameOnline(code) {
  // só códigos de produto (EAN/UPC/GTIN); códigos internos de balança começam com 2
  if (!gtinValid(code) || (code.length === 13 && code[0] === '2') || !navigator.onLine) return;
  const f = $('#form-novo');
  setProductHint('Produto novo — buscando o nome na base pública…');
  const info = await lookupProductOnline(code);
  if (f.barcode.value.trim() !== code || findProductByBarcode(code)) return; // a pessoa já mudou de produto
  if (!info) { setProductHint('Produto novo — não encontrado na base pública, preencha o nome.'); return; }
  const wasTypingName = document.activeElement === f.name;
  let filled = false;
  if (!f.name.value.trim()) { f.name.value = info.name; filled = true; }
  if (!f.category.value.trim() && info.category) f.category.value = info.category;
  const sameName = f.name.value.trim() === info.name;
  setProductHint(sameName ? 'Nome encontrado na base pública (Open Food Facts) — confira antes de salvar.'
    : 'Produto novo — confira o nome.');
  if (filled && wasTypingName) (f.expiry.value ? f.qty : f.expiry).focus();
}

function onBarcodeChange() {
  const f = $('#form-novo');
  const code = f.barcode.value.trim();
  if (code.length > 14 && parseGS1(code)) { applyScannedCode(code); return; }
  const changed = code !== formCode;
  if (changed) {
    // outro produto: validade e lote do anterior não valem mais
    formCode = code;
    scanExtra = '';
    setPhotoHint('');
    f.expiry.value = '';
    f.lot.value = '';
    updateExpiryHint();
  }
  const p = findProductByBarcode(code);
  if (p) fillFromProduct(p);
  else if (changed) {
    // só muda a mensagem quando o código muda (senão apagaria o "buscando o nome…")
    setProductHint(code ? 'Produto novo — preencha o nome.' : '');
    hideLastLot();
    if (code) suggestNameOnline(code);
  }
}

function onSubmitNovo(e) {
  e.preventDefault();
  const f = e.target;
  const barcode = f.barcode.value.trim();
  const name = f.name.value.trim();
  const qty = parseInt(f.qty.value, 10);
  const { iso: expiry, error } = readExpiry(f.expiry.value);
  if (error) { toast(error); f.expiry.focus(); return; }
  if (!name || !expiry || !(qty > 0)) { toast('Preencha produto, validade e quantidade.'); return; }

  let product = findProductByBarcode(barcode) || (!barcode && findProductByName(name));
  if (!product) {
    product = { id: barcode ? `ean:${barcode}` : `p:${uid()}`, barcode };
    db.products[product.id] = product;
  }
  product.name = name;
  product.category = f.category.value.trim();
  if (f.cost.value !== '') product.cost = Math.max(0, Number(f.cost.value));

  const lotCode = f.lot.value.trim();
  const location = f.location.value.trim();
  addLot({ productId: product.id, expiry, qty, lot: lotCode, location });
  saveDb();

  const days = daysUntil(expiry);
  toast(`${name}: ${qty} un. salvas (${daysText(days)}).`);
  // mantém o local para cadastros em sequência na mesma gôndola
  f.reset();
  f.location.value = location;
  f.qty.value = 1;
  $('#product-hint').textContent = '';
  hideLastLot();
  formCode = '';
  scanExtra = '';
  setPhotoHint('');
  renderNovo();
  f.barcode.focus();
}

/* ---------- baixa ---------- */
let baixaLotId = null;
function openBaixa(lotId) {
  const lot = db.lots.find((l) => l.id === lotId);
  if (!lot) return;
  baixaLotId = lotId;
  const p = db.products[lot.productId] || { name: '' };
  const f = $('#form-baixa');
  f.reset();
  const days = daysUntil(lot.expiry);
  f.type.value = days < 0 ? 'descarte' : 'venda';
  f.qty.max = lot.qty;
  f.qty.value = lot.qty;
  $('#baixa-info').textContent = `${p.name} — ${lot.qty} un. · ${fmtDate(lot.expiry)} (${daysText(days)})`;
  $('#dlg-baixa').showModal();
}

function onSubmitBaixa(e) {
  e.preventDefault();
  const f = e.target;
  const lot = db.lots.find((l) => l.id === baixaLotId);
  if (!lot) { $('#dlg-baixa').close(); return; }
  const qty = parseInt(f.qty.value, 10);
  if (!(qty > 0) || qty > lot.qty) { toast(`Quantidade deve ser entre 1 e ${lot.qty}.`); return; }
  const p = db.products[lot.productId] || {};
  db.movements.push({
    id: uid(), lotId: lot.id, productId: lot.productId, type: f.type.value,
    qty, unitCost: Number(p.cost) || 0, date: todayISO(), note: f.note.value.trim(),
  });
  saveDb(); // recalcula a quantidade do lote a partir das movimentações
  $('#dlg-baixa').close();
  toast(`Baixa registrada: ${qty} un. (${MOVE_LABEL[f.type.value]}).`);
  rerender();
}

function onDeleteLot() {
  const lot = db.lots.find((l) => l.id === baixaLotId);
  if (!lot) return;
  if (!confirm('Excluir este lote? Use apenas para corrigir um cadastro errado — não entra nos relatórios.')) return;
  lot.deleted = true; // marcado (não apagado) para a exclusão chegar aos outros aparelhos
  saveDb();
  $('#dlg-baixa').close();
  toast('Lote excluído.');
  rerender();
}

/* ---------- leitor de código de barras ---------- */
let scanStop = null;

/* ---------- códigos GS1 (DataMatrix, GS1-128, QR) ----------
 * Além do código de barras comum, muitos produtos (todos os medicamentos e
 * cada vez mais alimentos) trazem um código 2D com produto, lote e validade:
 *   (01) GTIN  (17) validade AAMMDD  (10) lote  (21) série  (15) consumir até
 */
const GS = '\x1d';
const GS1_FIXED = {
  '00': 18, '01': 14, '02': 14, '03': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2,
};
const GS1_VAR = { '10': 20, '21': 20, '22': 20, '30': 8, '37': 8, '90': 30, '91': 90, '92': 90, '93': 90, '94': 90, '95': 90, '96': 90, '97': 90, '98': 90, '99': 90 };
const GS1_VAR3 = {
  '240': 30, '241': 30, '250': 30, '251': 30, '400': 30, '401': 30, '403': 30, '420': 20, '421': 12,
  // registro nacional de medicamento (713 = registro ANVISA, usado no IUM dos remédios no Brasil)
  '710': 20, '711': 20, '712': 20, '713': 20, '714': 20, '715': 20,
};

function gs1Def(s) {
  const two = s.slice(0, 2);
  if (GS1_FIXED[two]) return { ai: two, len: GS1_FIXED[two] };
  if (GS1_VAR[two]) return { ai: two, max: GS1_VAR[two] };
  if (/^3[1-6]\d\d/.test(s)) return { ai: s.slice(0, 4), len: 6 };      // pesos e medidas
  if (/^41[0-7]/.test(s)) return { ai: s.slice(0, 3), len: 13 };        // locais (GLN)
  if (/^7003/.test(s)) return { ai: '7003', len: 10 };                   // validade com hora
  const three = s.slice(0, 3);
  if (GS1_VAR3[three]) return { ai: three, max: GS1_VAR3[three] };
  return null;
}

function gtinValid(code) {
  if (!/^\d{8,14}$/.test(code)) return false;
  const d = code.split('').map(Number);
  const check = d.pop();
  const sum = d.reverse().reduce((acc, n, i) => acc + n * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

function gs1Date(v) {
  if (!/^\d{6}$/.test(v)) return '';
  const y = 2000 + Number(v.slice(0, 2));
  const m = Number(v.slice(2, 4));
  let d = Number(v.slice(4, 6));
  if (m < 1 || m > 12) return '';
  if (d === 0) d = new Date(Date.UTC(y, m, 0)).getUTCDate(); // "00" = último dia do mês
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return parseDateAny(iso);
}

/** Lê um código GS1. Devolve { barcode, gtin, lot, expiry, serial } ou null se não for GS1. */
function parseGS1(raw) {
  let s = String(raw || '').trim().replace(/^\][A-Za-z]\d/, '').replace(/^\x1d+/, '');
  const out = {};
  if (s.startsWith('(')) {
    for (const m of s.matchAll(/\((\d{2,4})\)([^(]*)/g)) out[m[1]] = m[2].replace(/\x1d/g, '').trim();
  } else {
    if (!/^\d{4}/.test(s)) return null;
    let i = 0;
    while (i < s.length) {
      if (s[i] === GS) { i++; continue; }
      const def = gs1Def(s.slice(i));
      if (!def) {
        // campo desconhecido: pula até o próximo separador em vez de desistir do resto
        const next = s.indexOf(GS, i);
        if (next < 0) break;
        i = next + 1;
        continue;
      }
      i += def.ai.length;
      let val;
      if (def.len) {
        val = s.substr(i, def.len);
        if (val.length < def.len) break;
      } else {
        let end = s.indexOf(GS, i);
        if (end < 0) end = s.length;
        val = s.slice(i, Math.min(end, i + def.max));
      }
      i += val.length;
      out[def.ai] = val;
    }
  }
  const gtin = out['01'] || out['02'];
  if (!gtin || !gtinValid(gtin)) return null;
  // GTIN-14 começando com 0 = o EAN-13 impresso no código de barras comum
  const barcode = gtin.length === 14 && gtin[0] === '0' ? gtin.slice(1) : gtin;
  return {
    gtin, barcode,
    lot: out['10'] || '',
    expiry: gs1Date(out['17'] || '') || gs1Date(out['15'] || '') || (out['7003'] ? gs1Date(out['7003'].slice(0, 6)) : ''),
    serial: out['21'] || '',
  };
}

/** Acha o produto pelo GTIN em qualquer formato (EAN-13, UPC-12, EAN-8, GTIN-14). */
function findProductByGtin(gtin) {
  const candidates = [...new Set([gtin, gtin.slice(1), gtin.replace(/^0+/, ''), gtin.slice(-13), gtin.slice(-12), gtin.slice(-8)])];
  for (const c of candidates) {
    const p = findProductByBarcode(c);
    if (p) return p;
  }
  return undefined;
}

/** Aplica o que foi lido pela câmera ou pelo leitor USB no formulário de cadastro. */
function applyScannedCode(code) {
  const f = $('#form-novo');
  const g = parseGS1(code);
  if (!g) {
    f.barcode.value = String(code).trim();
    onBarcodeChange();
    if (!findProductByBarcode(f.barcode.value)) f.name.focus();
    return;
  }
  const known = findProductByGtin(g.gtin);
  f.barcode.value = known ? known.barcode : g.barcode;
  onBarcodeChange();
  if (g.expiry) { f.expiry.value = fmtDate(g.expiry); updateExpiryHint(); }
  if (g.lot) f.lot.value = g.lot;
  if (g.expiry || g.lot) hideLastLot();
  const parts = [g.lot && `lote ${g.lot}`, g.expiry && `validade ${fmtDate(g.expiry)}`].filter(Boolean);
  scanExtra = parts.length ? `Código 2D lido: ${parts.join(' · ')}.` : '';
  if (known) setProductHint('Produto já cadastrado.');
  else if (!/buscando|encontrado/.test($('#product-hint').textContent)) setProductHint('Produto novo — preencha o nome.');
  else setProductHint($('#product-hint').textContent.replace(/\s*Código 2D lido:.*$/, ''));
  if (!known) f.name.focus();
  else if (!g.expiry) f.expiry.focus();
  else f.qty.focus();
}

/* ---------- validade e lote pela foto (IA) ---------- */
let photoLot = ''; // lote preenchido pela última foto (para trocar se vier outra foto)

function setPhotoHint(msg, bad = false) {
  const el = $('#photo-hint');
  el.textContent = msg;
  el.classList.toggle('summary-bad', bad);
}

/** Reduz a foto (lado maior até `max` px) e devolve o JPEG em base64. */
async function shrinkImage(file, max = 1280, quality = 0.85) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return { data: canvas.toDataURL('image/jpeg', quality).split(',')[1], mediaType: 'image/jpeg' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function onPhotoLabelClick() {
  if (typeof cloudConnected !== 'function' || !cloudConnected()) {
    setPhotoHint('A leitura por foto usa a nuvem: entre na sua conta em Ajustes.', true);
    return;
  }
  if (!navigator.onLine) { setPhotoHint('Sem internet agora: digite a validade.', true); return; }
  $('#photo-label-file').click();
}

async function onPhotoLabelFile(file) {
  const btn = $('#btn-photo-label');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Lendo a foto…';
  setPhotoHint('');
  try {
    const { data, mediaType } = await shrinkImage(file);
    const r = await readLabelPhoto(data, mediaType);
    const f = $('#form-novo');
    if (r.expiry) { f.expiry.value = fmtDate(r.expiry); updateExpiryHint(); }
    if (r.lot) f.lot.value = r.lot;
    else if (photoLot && f.lot.value === photoLot) f.lot.value = ''; // lote da foto anterior, não desta
    photoLot = r.lot || '';
    if (r.expiry || r.lot) hideLastLot();
    const parts = [
      r.expiry && `validade ${fmtDate(r.expiry)}${r.month_year_only ? ' (só mês/ano na embalagem)' : ''}`,
      r.lot && `lote ${r.lot}`,
    ].filter(Boolean);
    if (r.expiry) {
      setPhotoHint(`Lido da foto: ${parts.join(' · ')}. ${r.confidence === 'high' ? 'Confira antes de salvar.' : 'Confira com atenção!'} ${r.note || ''}`.trim(),
        r.confidence === 'low');
      f.qty.focus();
    } else {
      setPhotoHint(`Não consegui ler a validade nessa foto${parts.length ? ` (li ${parts.join(' · ')})` : ''}. `
        + (r.note || 'Tente de novo com mais luz, sem reflexo e mais perto, ou digite a data.'), true);
    }
  } catch (e) {
    setPhotoHint(e.message || 'Não foi possível ler a foto. Digite a validade.', true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

async function openScanner() {
  const dlg = $('#dlg-scan');
  const video = $('#scan-video');
  const status = $('#scan-status');
  dlg.showModal();
  status.textContent = 'Iniciando câmera…';

  const done = (code) => {
    closeScanner();
    applyScannedCode(code);
    if (navigator.vibrate) navigator.vibrate(80);
  };

  try {
    if ('BarcodeDetector' in window) {
      const formats = await BarcodeDetector.getSupportedFormats();
      const detector = new BarcodeDetector({
        formats: formats.filter((f) => ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code', 'data_matrix'].includes(f)),
      });
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = stream;
      await video.play();
      status.textContent = 'Procurando código…';
      let active = true;
      scanStop = () => { active = false; stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; };
      const tick = async () => {
        if (!active) return;
        try {
          const found = await detector.detect(video);
          if (found.length) { done(found[0].rawValue); return; }
        } catch (e) { /* frame ainda não disponível */ }
        setTimeout(tick, 200);
      };
      tick();
    } else {
      status.textContent = 'Carregando leitor…';
      const { BrowserMultiFormatReader } = await import('https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm');
      const reader = new BrowserMultiFormatReader();
      status.textContent = 'Procurando código…';
      const controls = await reader.decodeFromVideoDevice(undefined, video, (result) => {
        if (result) done(result.getText());
      });
      scanStop = () => controls.stop();
    }
  } catch (err) {
    console.error(err);
    status.textContent = 'Não foi possível acessar a câmera. Verifique a permissão ou digite o código.';
  }
}

function closeScanner() {
  if (scanStop) { scanStop(); scanStop = null; }
  const dlg = $('#dlg-scan');
  if (dlg.open) dlg.close();
}

/* ---------- notificações ---------- */
async function checkDailyAlert() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const today = todayISO();
  if (db.settings.lastNotified === today) return;
  const lots = activeLots();
  const venc = lots.filter((l) => l.status === 'vencido').length;
  const crit = lots.filter((l) => l.status === 'critico').length;
  if (!venc && !crit) return;
  const body = [venc && `${venc} lote(s) vencido(s)`, crit && `${crit} vencendo em até ${db.settings.criticalDays} dias`]
    .filter(Boolean).join(' · ');
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg) await reg.showNotification('Validade Certa', { body, icon: 'icons/icon-192.png', tag: 'daily' });
    else new Notification('Validade Certa', { body });
    db.settings.lastNotified = today;
    saveDb();
  } catch (e) { /* ignora */ }
}

/* ---------- backup ---------- */
function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportCsv() {
  const rows = [['Produto', 'Código de barras', 'Categoria', 'Lote', 'Validade', 'Dias', 'Status', 'Quantidade', 'Local', 'Custo unitário']];
  activeLots().forEach((l) => rows.push([
    l.product.name, l.product.barcode || '', l.product.category || '', l.lot || '', fmtDate(l.expiry),
    l.days, STATUS_LABEL[l.status], l.qty, l.location || '', (Number(l.product.cost) || 0).toFixed(2).replace('.', ','),
  ]));
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  download(`validades-${todayISO()}.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || !Array.isArray(data.lots)) throw new Error('formato');
      if (!confirm('Substituir todos os dados atuais por este backup?')) return;
      db = normalizeDb(data);
      saveDb();
      toast('Backup restaurado.');
      route();
    } catch (e) {
      toast('Arquivo inválido.');
    }
  };
  reader.readAsText(file);
}

function loadDemo() {
  if (typeof cloudConnected === 'function' && cloudConnected()) {
    toast('Dados de exemplo só podem ser usados sem conta conectada.');
    return;
  }
  if (db.lots.length && !confirm('Adicionar dados de exemplo aos dados atuais?')) return;
  const t = todayISO();
  const demo = [
    ['7891000100103', 'Leite integral 1L', 'Laticínios', 4.2, -2, 6, 'Geladeira 1'],
    ['7891025101604', 'Iogurte natural 170g', 'Laticínios', 2.1, 3, 18, 'Geladeira 1'],
    ['7896004000015', 'Pão de forma 500g', 'Padaria', 5.9, 1, 8, 'Gôndola 2'],
    ['7894900011517', 'Refrigerante cola 2L', 'Bebidas', 6.5, 120, 24, 'Gôndola 5'],
    ['7891910000197', 'Biscoito recheado 140g', 'Mercearia', 2.4, 22, 30, 'Gôndola 3'],
    ['7891000053508', 'Achocolatado 400g', 'Mercearia', 7.8, 45, 12, 'Gôndola 3'],
    ['7898080640611', 'Presunto fatiado 200g', 'Frios', 6.9, 6, 10, 'Câmara fria'],
    ['7891149103102', 'Molho de tomate 340g', 'Mercearia', 2.2, 15, 20, 'Gôndola 4'],
  ];
  demo.forEach(([barcode, name, category, cost, d, qty, location], i) => {
    const id = `ean:${barcode}`;
    db.products[id] = { id, barcode, name, category, cost };
    db.lots.push({ id: uid(), productId: id, lot: `L${100 + i}`, expiry: addDaysISO(t, d), initialQty: qty, qty, location, createdAt: t });
  });
  db.movements.push(
    { id: uid(), lotId: '', productId: 'ean:7891000100103', type: 'descarte', qty: 4, unitCost: 4.2, date: addDaysISO(t, -5), note: 'vencido' },
    { id: uid(), lotId: '', productId: 'ean:7891025101604', type: 'promocao', qty: 10, unitCost: 2.1, date: addDaysISO(t, -3), note: '' },
    { id: uid(), lotId: '', productId: 'ean:7896004000015', type: 'devolucao', qty: 5, unitCost: 5.9, date: addDaysISO(t, -8), note: 'troca fornecedor' },
  );
  saveDb();
  toast('Dados de exemplo carregados.');
  location.hash = '#painel';
  route();
}

/* ---------- eventos ---------- */
function bind() {
  window.addEventListener('hashchange', route);
  bindImport();

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-baixa]');
    if (b) openBaixa(b.dataset.baixa);
  });

  $('#search').addEventListener('input', renderLotes);
  $('#filters').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    lotFilter = c.dataset.f;
    history.replaceState(null, '', `#lotes${lotFilter === 'todos' ? '' : '/' + lotFilter}`);
    renderLotes();
  });

  const fn = $('#form-novo');
  fn.addEventListener('submit', onSubmitNovo);
  fn.barcode.addEventListener('change', onBarcodeChange);
  fn.expiry.addEventListener('input', () => {
    const masked = maskDate(fn.expiry.value);
    if (masked !== fn.expiry.value) fn.expiry.value = masked;
    updateExpiryHint();
  });
  fn.barcode.addEventListener('keydown', (e) => {
    // leitores USB/Bluetooth enviam Enter ao final do código
    if (e.key === 'Enter') { e.preventDefault(); applyScannedCode(fn.barcode.value); }
  });
  fn.name.addEventListener('change', () => {
    if (!fn.barcode.value.trim()) {
      const p = findProductByName(fn.name.value);
      if (p) fillFromProduct(p);
    }
  });
  $('#btn-scan').addEventListener('click', openScanner);
  $('#btn-photo-label').addEventListener('click', onPhotoLabelClick);
  $('#photo-label-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) onPhotoLabelFile(file);
  });
  $('#last-lot').addEventListener('click', (e) => { if (e.target.id === 'btn-last-lot') useLastLot(); });
  $('#btn-scan-close').addEventListener('click', closeScanner);
  $('#dlg-scan').addEventListener('close', () => { if (scanStop) { scanStop(); scanStop = null; } });

  $('#form-baixa').addEventListener('submit', onSubmitBaixa);
  $('#btn-baixa-cancel').addEventListener('click', () => $('#dlg-baixa').close());
  $('#btn-delete-lot').addEventListener('click', onDeleteLot);

  $('#period').addEventListener('change', renderRelatorios);

  $('#form-settings').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const crit = parseInt(f.criticalDays.value, 10);
    const warn = parseInt(f.warnDays.value, 10);
    if (!(warn > crit)) { toast('“Atenção” precisa ser maior que “crítico”.'); return; }
    db.settings.storeName = f.storeName.value.trim();
    db.settings.criticalDays = crit;
    db.settings.warnDays = warn;
    saveDb();
    $('#store-name').textContent = db.settings.storeName || 'Controle de validade';
    toast('Ajustes salvos.');
  });

  $('#btn-notify').addEventListener('click', async () => {
    if (!('Notification' in window)) return;
    const perm = await Notification.requestPermission();
    renderAjustes();
    if (perm === 'granted') { db.settings.lastNotified = ''; checkDailyAlert(); toast('Notificações ativadas.'); }
  });

  $('#btn-export').addEventListener('click', () =>
    download(`validade-certa-backup-${todayISO()}.json`, JSON.stringify(db, null, 2), 'application/json'));
  $('#btn-csv').addEventListener('click', exportCsv);
  $('#file-import').addEventListener('change', (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; });
  $('#btn-demo').addEventListener('click', loadDemo);
  $('#btn-clear').addEventListener('click', () => {
    if (typeof cloudConnected === 'function' && cloudConnected()) {
      toast('Conta conectada: para limpar este aparelho, use “Sair da conta”.');
      return;
    }
    if (!confirm('Apagar TODOS os dados deste aparelho? Isso não pode ser desfeito.')) return;
    db = structuredClone(DEFAULT_DB);
    saveDb();
    toast('Dados apagados.');
    route();
  });

  // Atualiza quando o app volta ao primeiro plano (ex.: virou o dia)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { $('#today').textContent = fmtDate(todayISO()); rerender(); checkDailyAlert(); }
  });
}

/* ---------- init ---------- */
function init() {
  $('#today').textContent = fmtDate(todayISO());
  bind();
  if (!location.hash) history.replaceState(null, '', '#painel');
  route();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  checkDailyAlert();
  if (typeof cloudInit === 'function') cloudInit();
}

init();
