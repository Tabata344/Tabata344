'use strict';

/* ============================================================
 * Validade Certa — controle de validade para comércio (PWA)
 * Dados salvos localmente (localStorage) no aparelho.
 * ============================================================ */

const STORAGE_KEY = 'validade-certa:v1';
const DEFAULT_DB = {
  products: {},   // id -> { id, barcode, name, category, cost }
  lots: [],       // { id, productId, lot, expiry: 'YYYY-MM-DD', qty, location, createdAt }
  movements: [],  // { id, lotId, productId, type, qty, unitCost, date, note }
  imports: [],    // notas fiscais importadas: { key, number, supplier, date, importedAt, lots }
  settings: { storeName: '', criticalDays: 7, warnDays: 30, lastNotified: '' },
};

const STATUS_LABEL = { vencido: 'Vencido', critico: 'Crítico', atencao: 'Atenção', ok: 'OK' };
const MOVE_LABEL = {
  venda: 'Vendido', promocao: 'Promoção', descarte: 'Descarte',
  devolucao: 'Devolução', ajuste: 'Ajuste',
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
  return {
    products: raw.products || {},
    lots: raw.lots || [],
    movements: raw.movements || [],
    imports: raw.imports || [],
    settings: { ...DEFAULT_DB.settings, ...(raw.settings || {}) },
  };
}
function saveDb() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch (e) {
    toast('Não foi possível salvar: armazenamento cheio ou bloqueado.');
  }
}

/* ---------- consultas ---------- */
function activeLots() {
  return db.lots
    .filter((l) => l.qty > 0)
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
  const exp = $('#form-novo').expiry;
  exp.min = addDaysISO(todayISO(), -365);
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
  if (!p) { $('#product-hint').textContent = ''; return; }
  f.name.value = p.name;
  if (!f.barcode.value && p.barcode) f.barcode.value = p.barcode;
  f.category.value = p.category || '';
  f.cost.value = p.cost ?? '';
  $('#product-hint').textContent = 'Produto já cadastrado — dados preenchidos.';
  f.expiry.focus();
}

/** Cria um lote, ou soma ao lote igual (mesmo produto, lote, validade e local). */
function addLot({ productId, expiry, qty, lot = '', location = '', supplier = '', invoice = '' }) {
  const existing = db.lots.find((l) => l.productId === productId && l.expiry === expiry
    && (l.lot || '') === lot && (l.location || '') === location && l.qty > 0);
  if (existing) { existing.qty += qty; return existing; }
  const created = { id: uid(), productId, lot, expiry, qty, location, supplier, invoice, createdAt: todayISO() };
  db.lots.push(created);
  return created;
}

function onBarcodeChange() {
  const code = $('#form-novo').barcode.value.trim();
  const p = findProductByBarcode(code);
  if (p) fillFromProduct(p);
  else $('#product-hint').textContent = code ? 'Produto novo — preencha o nome.' : '';
}

function onSubmitNovo(e) {
  e.preventDefault();
  const f = e.target;
  const barcode = f.barcode.value.trim();
  const name = f.name.value.trim();
  const qty = parseInt(f.qty.value, 10);
  const expiry = f.expiry.value;
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
  lot.qty -= qty;
  saveDb();
  $('#dlg-baixa').close();
  toast(`Baixa registrada: ${qty} un. (${MOVE_LABEL[f.type.value]}).`);
  rerender();
}

function onDeleteLot() {
  const lot = db.lots.find((l) => l.id === baixaLotId);
  if (!lot) return;
  if (!confirm('Excluir este lote? Use apenas para corrigir um cadastro errado — não entra nos relatórios.')) return;
  db.lots = db.lots.filter((l) => l.id !== baixaLotId);
  saveDb();
  $('#dlg-baixa').close();
  toast('Lote excluído.');
  rerender();
}

/* ---------- leitor de código de barras ---------- */
let scanStop = null;

async function openScanner() {
  const dlg = $('#dlg-scan');
  const video = $('#scan-video');
  const status = $('#scan-status');
  dlg.showModal();
  status.textContent = 'Iniciando câmera…';

  const done = (code) => {
    closeScanner();
    const f = $('#form-novo');
    f.barcode.value = code;
    onBarcodeChange();
    if (!findProductByBarcode(code)) f.name.focus();
    if (navigator.vibrate) navigator.vibrate(80);
  };

  try {
    if ('BarcodeDetector' in window) {
      const formats = await BarcodeDetector.getSupportedFormats();
      const detector = new BarcodeDetector({
        formats: formats.filter((f) => ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'].includes(f)),
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
    db.lots.push({ id: uid(), productId: id, lot: `L${100 + i}`, expiry: addDaysISO(t, d), qty, location, createdAt: t });
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
  fn.barcode.addEventListener('keydown', (e) => {
    // leitores USB/Bluetooth enviam Enter ao final do código
    if (e.key === 'Enter') { e.preventDefault(); onBarcodeChange(); if (!findProductByBarcode(fn.barcode.value.trim())) fn.name.focus(); }
  });
  fn.name.addEventListener('change', () => {
    if (!fn.barcode.value.trim()) {
      const p = findProductByName(fn.name.value);
      if (p) fillFromProduct(p);
    }
  });
  $('#btn-scan').addEventListener('click', openScanner);
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
}

init();
