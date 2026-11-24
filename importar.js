'use strict';

/* ============================================================
 * Importação em lote
 *  - NF-e (XML do fornecedor): cria lotes com produto, quantidade,
 *    custo e, quando informado na nota, lote e validade (<rastro>).
 *  - Planilha (CSV / Excel): cadastro de produtos e, se houver
 *    colunas de validade e quantidade, também os lotes.
 * Depende das funções globais de app.js (db, saveDb, addLot, ...).
 * ============================================================ */

let nfePending = null;    // { notes: [...], items: [...] }
let sheetPending = null;  // { fileName, headers, rows, map }

const UNIT_RE = /^(UN|UND|UNID|UNI|UNIDADE|PC|PCA|PÇ|PEÇA|PECA)$/i;
const XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';

/* ---------- utilidades de leitura ---------- */
async function readText(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    // muitos sistemas brasileiros exportam CSV em Windows-1252 (ANSI)
    return new TextDecoder('windows-1252').decode(buf);
  }
}

function parseNum(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim().replace(/[R$\s]/g, '');
  if (!s) return NaN;
  if (s.includes(',')) return Number(s.replace(/\./g, '').replace(',', '.')); // 1.234,56
  return Number(s);
}

function isoFromParts(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return '';
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return '';
  return dt.toISOString().slice(0, 10);
}

/** Aceita 31/12/2026, 31/12/26, 2026-12-31, 12/2026 (último dia do mês) e datas do Excel. */
function parseDateAny(v) {
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) {
      return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10);
    }
    return '';
  }
  const s = String(v ?? '').trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return isoFromParts(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/))) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return isoFromParts(y, +m[2], +m[1]);
  }
  if ((m = s.match(/^(\d{1,2})[/.-](\d{2}|\d{4})$/))) {
    const y = +m[2] < 100 ? 2000 + +m[2] : +m[2];
    const mo = +m[1];
    if (mo < 1 || mo > 12) return '';
    return isoFromParts(y, mo, new Date(Date.UTC(y, mo, 0)).getUTCDate());
  }
  return '';
}

function cleanCode(v) {
  if (typeof v === 'number') return String(Math.round(v));
  const s = String(v ?? '').trim();
  return /^[\d\s.-]+$/.test(s) ? s.replace(/\D/g, '') : s;
}

const fmtQty = (n) => (Number.isInteger(n) ? String(n) : n.toLocaleString('pt-BR', { maximumFractionDigits: 3 }));

/* ============================================================
 * NF-e
 * ============================================================ */
function parseNfe(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('arquivo XML inválido');
  const first = (el, tag) => el && el.getElementsByTagNameNS('*', tag)[0];
  const txt = (el, tag) => (first(el, tag)?.textContent || '').trim();

  const inf = first(doc, 'infNFe');
  if (!inf) throw new Error('não é uma NF-e');
  const ide = first(inf, 'ide');
  const emit = first(inf, 'emit');
  const note = {
    key: (inf.getAttribute('Id') || '').replace(/^NFe/, ''),
    number: txt(ide, 'nNF'),
    date: (txt(ide, 'dhEmi') || txt(ide, 'dEmi')).slice(0, 10),
    supplier: txt(emit, 'xFant') || txt(emit, 'xNome'),
    cnpj: txt(emit, 'CNPJ') || txt(emit, 'CPF'),
  };

  const items = [];
  for (const det of inf.getElementsByTagNameNS('*', 'det')) {
    const prod = first(det, 'prod');
    if (!prod) continue;
    const ean = [txt(prod, 'cEAN'), txt(prod, 'cEANTrib')].find((v) => /^\d{8,14}$/.test(v)) || '';
    const qCom = Number(txt(prod, 'qCom')) || 0;
    const qTrib = Number(txt(prod, 'qTrib')) || 0;
    const uCom = txt(prod, 'uCom');
    const uTrib = txt(prod, 'uTrib');
    // Se a nota vende em CX/FD mas a unidade tributável é UN, usamos as unidades (ex.: 2 CX = 24 UN)
    const factor = (UNIT_RE.test(uTrib) && !UNIT_RE.test(uCom) && qCom > 0 && qTrib > qCom) ? qTrib / qCom : 1;
    const total = Number(txt(prod, 'vProd')) || 0;
    const base = {
      code: txt(prod, 'cProd'), ean, name: txt(prod, 'xProd'), unit: uCom, nfQty: qCom,
    };
    const rastros = [...prod.getElementsByTagNameNS('*', 'rastro')];
    if (rastros.length) {
      rastros.forEach((r) => {
        const qLote = Number(txt(r, 'qLote')) || 0;
        items.push({
          ...base, nfQty: qLote, total: qCom ? total * (qLote / qCom) : 0,
          lot: txt(r, 'nLote'), expiry: parseDateAny(txt(r, 'dVal')), qty: Math.round(qLote * factor),
        });
      });
    } else {
      items.push({ ...base, total, lot: '', expiry: '', qty: Math.round(qCom * factor) });
    }
  }
  if (!items.length) throw new Error('a nota não tem produtos');
  return { note, items };
}

function nfeProductId(it, cnpj) {
  return it.ean ? `ean:${it.ean}` : `forn:${cnpj}:${it.code}`;
}

async function onNfeFiles(files) {
  const notes = [];
  const items = [];
  const errors = [];
  for (const file of files) {
    try {
      const { note, items: its } = parseNfe(await readText(file));
      if (notes.some((n) => n.key && n.key === note.key)) continue;
      note.duplicate = !!note.key && db.imports.some((i) => i.key === note.key);
      const ni = notes.push(note) - 1;
      its.forEach((it) => {
        const pid = nfeProductId(it, note.cnpj);
        items.push({ ...it, note: ni, productId: pid, known: !!db.products[pid], include: !note.duplicate });
      });
    } catch (e) {
      errors.push(`${file.name}: ${e.message}`);
    }
  }
  if (errors.length) toast(`Não foi possível ler: ${errors.join('; ')}`);
  nfePending = notes.length ? { notes, items } : null;
  renderNfePreview();
  if (nfePending) $('#nfe-preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function nfeItemHTML(it, i) {
  const known = it.known ? ' · <b>já cadastrado</b>' : '';
  const expShown = it.expiryRaw ?? (it.expiry ? fmtDate(it.expiry) : '');
  return `
    <li class="nfe-item ${it.include ? '' : 'off'} ${it.highlight ? 'highlight' : ''}" data-i="${i}">
      <label class="check"><input type="checkbox" data-f="include" ${it.include ? 'checked' : ''}>
        <span class="name">${esc(db.products[it.productId]?.name || it.name)}</span></label>
      <div class="meta">${it.ean ? `EAN ${esc(it.ean)} · ` : `Cód. forn. ${esc(it.code)} · `}Na nota: ${fmtQty(it.nfQty)} ${esc(it.unit)} · ${money(it.total)}${known}</div>
      <div class="grid3">
        <label>Validade<input data-f="expiry" inputmode="numeric" placeholder="dd/mm/aaaa" maxlength="10" value="${esc(expShown)}" class="${it.include && !it.expiry ? 'missing' : ''}"></label>
        <label>Qtd (un.)<input type="number" min="1" step="1" inputmode="numeric" data-f="qty" value="${it.qty}"></label>
        <label>Lote<input data-f="lot" value="${esc(it.lot)}"></label>
      </div>
      <div class="row wrap nfe-actions">
        <button type="button" class="btn small secondary" data-act="foto" ${it.busy ? 'disabled' : ''}>${it.busy ? 'Lendo a foto…' : '📷 Foto da validade'}</button>
        <button type="button" class="btn small secondary" data-act="scan2d">▦ Código 2D</button>
      </div>
      ${it.msg ? `<div class="meta ${it.msgBad ? 'summary-bad' : 'summary-ok'}">${esc(it.msg)}</div>` : ''}
    </li>`;
}

function updateNfeItem(i) {
  const li = $(`#nfe-preview .nfe-item[data-i="${i}"]`);
  if (!li) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = nfeItemHTML(nfePending.items[i], i).trim();
  li.replaceWith(tmp.firstChild);
  updateNfeSummary();
}

function renderNfePreview() {
  const el = $('#nfe-preview');
  if (!nfePending) { el.innerHTML = ''; return; }
  const { notes, items } = nfePending;
  el.innerHTML = `
    <div class="panel nfe-bip">
      <p class="muted small">Para cada produto: pegue a embalagem, toque em <b>▦ Bipar produto</b> para achá-lo na lista
        e depois em <b>📷 Foto da validade</b>. Ou use os botões direto em cada item.</p>
      <button type="button" class="btn" id="nfe-bip">▦ Bipar produto</button>
    </div>` + notes.map((n, ni) => `
    <div class="panel">
      <div class="panel-head"><h3>NF ${esc(n.number)} — ${esc(n.supplier)}</h3><span class="muted small">${fmtDate(n.date)}</span></div>
      ${n.duplicate ? '<p class="warn small">⚠️ Esta nota já foi importada. Os itens vieram desmarcados.</p>' : ''}
      <ul class="lot-list">${items.map((it, i) => (it.note === ni ? nfeItemHTML(it, i) : '')).join('')}</ul>
    </div>`).join('') + `
    <div class="panel form sticky-actions">
      <label>Local (para todos os itens)
        <input id="nfe-location" list="locations" placeholder="Depósito, Gôndola 2…">
      </label>
      <p class="small" id="nfe-summary"></p>
      <div class="row end">
        <button type="button" class="btn secondary" id="nfe-cancel">Cancelar</button>
        <button type="button" class="btn" id="nfe-confirm">Criar lotes</button>
      </div>
    </div>`;
  updateNfeSummary();
}

function updateNfeSummary() {
  const inc = nfePending.items.filter((it) => it.include);
  const missing = inc.filter((it) => !it.expiry || !(it.qty > 0)).length;
  const s = $('#nfe-summary');
  s.className = `small ${missing ? 'summary-bad' : 'summary-ok'}`;
  s.textContent = missing
    ? `${inc.length} item(ns) selecionado(s) — falta validade/quantidade em ${missing}. Preencha ou desmarque.`
    : `${inc.length} item(ns) prontos para virar lotes.`;
}

function onNfeInput(e) {
  // campo que já saiu da tela (o item foi redesenhado): não sobrescreve o que foi lido
  if (!e.target.isConnected) return;
  const li = e.target.closest('.nfe-item');
  if (!li || !nfePending) return;
  const it = nfePending.items[Number(li.dataset.i)];
  const f = e.target.dataset.f;
  if (f === 'include') { it.include = e.target.checked; li.classList.toggle('off', !it.include); }
  else if (f === 'qty') it.qty = parseInt(e.target.value, 10) || 0;
  else if (f === 'expiry') {
    const m = maskDate(e.target.value);
    if (m !== e.target.value) e.target.value = m;
    it.expiryRaw = m;
    it.expiry = readExpiry(m).iso;
  } else if (f === 'lot') it.lot = e.target.value.trim();
  const exp = li.querySelector('[data-f=expiry]');
  exp.classList.toggle('missing', it.include && !it.expiry);
  updateNfeSummary();
}

/* ---------- validade e lote de cada item da nota (foto ou código 2D) ---------- */
let nfePhotoTarget = null; // item que vai receber a foto

/** Mesmo produto? Compara só a parte que identifica o produto: ignora o dígito de
 * embalagem do GTIN-14 (caixa "1789…" = unidade "789…") e o dígito verificador. */
function sameGtin(a, b) {
  const core = (x) => {
    const d = String(x || '').replace(/\D/g, '');
    if (d.length < 8) return '';
    return d.padStart(14, '0').slice(1, 13);
  };
  const ca = core(a);
  return !!ca && ca === core(b);
}

function setNfeItem(i, changes) {
  // se a pessoa está digitando neste item, confirma o digitado ANTES de aplicar a leitura
  const li = $(`#nfe-preview .nfe-item[data-i="${i}"]`);
  if (li && li.contains(document.activeElement)) document.activeElement.blur();
  Object.assign(nfePending.items[i], changes);
  updateNfeItem(i);
}

function onNfeItemPhotoClick(i) {
  if (typeof cloudConnected !== 'function' || !cloudConnected()) {
    setNfeItem(i, { msg: 'A leitura por foto usa a nuvem: entre na sua conta em Ajustes.', msgBad: true });
    return;
  }
  if (!navigator.onLine) { setNfeItem(i, { msg: 'Sem internet agora: digite a validade.', msgBad: true }); return; }
  nfePhotoTarget = i;
  $('#nfe-photo-file').click();
}

async function onNfePhotoFile(file) {
  const i = nfePhotoTarget;
  const pending = nfePending;
  if (i == null || !pending) return;
  const it = pending.items[i];
  setNfeItem(i, { busy: true, msg: 'Lendo a foto… pode levar alguns segundos.', msgBad: false });
  try {
    const { data, mediaType } = await shrinkImage(file);
    const r = await readLabelPhoto(data, mediaType);
    if (nfePending !== pending) return; // a lista foi descartada
    const changes = { busy: false };
    if (r.expiry) { changes.expiry = r.expiry; changes.expiryRaw = fmtDate(r.expiry); }
    if (r.lot) changes.lot = r.lot;
    const parts = [r.expiry && `validade ${fmtDate(r.expiry)}`, r.lot && `lote ${r.lot}`].filter(Boolean);
    const other = r.barcode && it.ean && !sameGtin(r.barcode, it.ean);
    if (!r.expiry) {
      changes.msg = `Não consegui ler a validade${parts.length ? ` (li ${parts.join(' · ')})` : ''}. ${r.note || 'Tente com mais luz e sem reflexo, ou digite.'}`;
      changes.msgBad = true;
    } else {
      changes.msg = `Lido da foto: ${parts.join(' · ')}. `
        + (other ? `Atenção: a foto parece ser de outro produto (código ${r.barcode}).`
          : r.confidence === 'high' ? 'Confira.' : 'Confira com atenção!')
        + (r.note ? ` ${r.note}` : '');
      changes.msgBad = other || r.confidence === 'low';
    }
    setNfeItem(i, changes);
  } catch (e) {
    if (nfePending === pending) setNfeItem(i, { busy: false, msg: e.message || 'Não foi possível ler a foto.', msgBad: true });
  }
}

/** Código 2D (GS1) lido para um item específico da nota. */
function applyNfe2D(i, code) {
  const it = nfePending.items[i];
  const g = parseGS1(code);
  if (!g) { setNfeItem(i, { msg: 'Esse código não traz validade. Use a 📷 Foto da validade.', msgBad: true }); return; }
  if (it.ean && !sameGtin(g.gtin, it.ean)) {
    setNfeItem(i, { msg: `Esse código 2D é de outro produto (código ${g.barcode}). Nada foi preenchido.`, msgBad: true });
    return;
  }
  const changes = {};
  if (g.expiry) { changes.expiry = g.expiry; changes.expiryRaw = fmtDate(g.expiry); }
  if (g.lot) changes.lot = g.lot;
  const parts = [g.expiry && `validade ${fmtDate(g.expiry)}`, g.lot && `lote ${g.lot}`].filter(Boolean);
  changes.msg = parts.length
    ? `Lido do código 2D: ${parts.join(' · ')}.${it.ean ? '' : ' A nota não tem o código deste item: confira se é o produto certo.'}`
    : 'O código 2D não tem validade nem lote. Use a foto.';
  changes.msgBad = !parts.length;
  setNfeItem(i, changes);
}

/** "Bipar produto": acha o produto bipado na lista da nota. */
function nfeLocate(code) {
  if (!nfePending) return;
  const g = parseGS1(code);
  const gtin = g ? g.gtin : String(code).trim();
  const matches = nfePending.items.map((it, i) => (sameGtin(it.ean, gtin) ? i : -1)).filter((i) => i >= 0);
  if (!matches.length) { toast('Esse produto não está nesta nota.'); return; }
  // prefere um item que ainda não tem validade
  const i = matches.find((k) => !nfePending.items[k].expiry) ?? matches[0];
  nfePending.items.forEach((it, k) => { if (it.highlight && k !== i) { it.highlight = false; updateNfeItem(k); } });
  if (g && (g.expiry || g.lot)) {
    nfePending.items[i].highlight = true;
    applyNfe2D(i, code);
  } else {
    setNfeItem(i, { highlight: true, msg: 'Encontrado! Agora toque em 📷 Foto da validade.', msgBad: false });
  }
  $(`#nfe-preview .nfe-item[data-i="${i}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (navigator.vibrate) navigator.vibrate(60);
}

function confirmNfe() {
  const { notes, items } = nfePending;
  const inc = items.filter((it) => it.include);
  if (!inc.length) { toast('Nenhum item selecionado.'); return; }
  const bad = inc.find((it) => !it.expiry || !(it.qty > 0));
  if (bad) {
    toast('Preencha validade e quantidade dos itens marcados (ou desmarque-os).');
    $(`.nfe-item[data-i="${items.indexOf(bad)}"] input[data-f=expiry]`)?.focus();
    return;
  }
  const place = $('#nfe-location').value.trim();
  const perNote = notes.map(() => 0);
  inc.forEach((it) => {
    const n = notes[it.note];
    let p = db.products[it.productId];
    if (!p) {
      p = { id: it.productId, barcode: it.ean, name: it.name, category: '', supplierCode: it.code };
      db.products[p.id] = p;
    }
    if (it.total > 0) p.cost = Math.round((it.total / it.qty) * 100) / 100;
    addLot({ productId: p.id, expiry: it.expiry, qty: it.qty, lot: it.lot, location: place, supplier: n.supplier, invoice: n.number });
    perNote[it.note] += 1;
  });
  notes.forEach((n, ni) => {
    if (!perNote[ni]) return;
    db.imports.push({ id: n.key || uid(), key: n.key, number: n.number, supplier: n.supplier, date: n.date, importedAt: todayISO(), lots: perNote[ni] });
  });
  saveDb();
  nfePending = null;
  toast(`${inc.length} lote(s) criados a partir da nota.`);
  location.hash = '#lotes';
}

function renderNfeHistory() {
  const list = db.imports.slice(-10).reverse();
  $('#nfe-history').innerHTML = `<h3>Notas importadas</h3>` + (list.length
    ? `<ul class="simple-list">${list.map((i) => `<li class="mv"><span>NF ${esc(i.number)} · ${esc(i.supplier)}</span><span class="muted small">${fmtDate(i.importedAt)} · ${i.lots} lote(s)</span></li>`).join('')}</ul>`
    : '<p class="muted small">Nenhuma nota importada ainda.</p>');
}

/* ============================================================
 * Planilha (CSV / Excel)
 * ============================================================ */
const SHEET_FIELDS = [
  { key: 'barcode', label: 'Código de barras', res: [/(ean|gtin|c[oó]d.*barra|barras|barcode)/i] },
  { key: 'name', label: 'Nome do produto *', res: [/descri/i, /nome/i, /^(?!.*c[oó]d).*produto/i] },
  { key: 'category', label: 'Categoria', res: [/(categ|grupo|departamento|se[cç][aã]o|fam[ií]lia)/i] },
  { key: 'cost', label: 'Custo unitário', res: [/(custo|pre[cç]o.*compra|valor.*compra)/i] },
  { key: 'expiry', label: 'Validade', res: [/(validade|vencimento|\bvenc\b|dt.*val)/i] },
  { key: 'qty', label: 'Quantidade', res: [/(qtd|qtde|quant|estoque|saldo)/i] },
  { key: 'lot', label: 'Lote', res: [/\blote\b/i] },
  { key: 'location', label: 'Local', res: [/(local|g[oô]ndola|setor|endere[cç]o|prateleira)/i] },
];

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delim = [';', '\t', ','].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('sem conexão para abrir arquivos do Excel; salve como CSV ou tente online'));
    document.head.appendChild(s);
  });
}

async function readSheet(file) {
  let rows;
  if (/\.xlsx?$/i.test(file.name)) {
    if (!window.XLSX) await loadScript(XLSX_URL);
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
  } else {
    rows = parseCsv(await readText(file));
  }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

function autoMap(headers) {
  const used = new Set();
  const map = {};
  SHEET_FIELDS.forEach((f) => {
    map[f.key] = -1;
    for (const re of f.res) {
      const idx = headers.findIndex((h, i) => !used.has(i) && re.test(String(h)));
      if (idx >= 0) { map[f.key] = idx; used.add(idx); break; }
    }
  });
  return map;
}

function mapRow(r, map) {
  const get = (k) => (map[k] >= 0 ? r[map[k]] ?? '' : '');
  return {
    barcode: cleanCode(get('barcode')),
    name: String(get('name')).trim(),
    category: String(get('category')).trim(),
    cost: parseNum(get('cost')),
    expiry: parseDateAny(get('expiry')),
    rawExpiry: String(get('expiry')).trim(),
    qty: Math.round(parseNum(get('qty'))),
    lot: String(get('lot')).trim(),
    location: String(get('location')).trim(),
  };
}

async function onSheetFile(file) {
  try {
    const rows = await readSheet(file);
    if (rows.length < 2) throw new Error('a planilha precisa de um cabeçalho e pelo menos uma linha');
    const headers = rows[0].map((h) => String(h).trim());
    sheetPending = { fileName: file.name, headers, rows: rows.slice(1), map: autoMap(headers) };
  } catch (e) {
    sheetPending = null;
    toast(`Não foi possível ler a planilha: ${e.message}`);
  }
  renderSheetPreview();
  if (sheetPending) $('#sheet-preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function sheetStats(mapped) {
  let products = 0; let lots = 0; let badDates = 0; let skipped = 0;
  mapped.forEach((m) => {
    if (!m.name && !(m.barcode && findProductByBarcode(m.barcode))) { skipped++; return; }
    products++;
    if (m.expiry && m.qty > 0) lots++;
    else if (m.rawExpiry && !m.expiry) badDates++;
  });
  return { products, lots, badDates, skipped };
}

function renderSheetPreview() {
  const el = $('#sheet-preview');
  if (!sheetPending) { el.innerHTML = ''; return; }
  const { fileName, headers, rows, map } = sheetPending;
  const opts = (sel) => '<option value="-1">— não usar —</option>'
    + headers.map((h, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(h || `Coluna ${i + 1}`)}</option>`).join('');
  const mapped = rows.map((r) => mapRow(r, map));
  const st = sheetStats(mapped);
  const preview = mapped.slice(0, 5).map((m) => {
    const status = m.expiry ? statusOf(daysUntil(m.expiry)) : 'ok';
    const meta = [m.barcode && `EAN ${esc(m.barcode)}`, m.category && esc(m.category),
      Number.isFinite(m.cost) && `custo ${money(m.cost)}`].filter(Boolean).join(' · ');
    return `<li class="lot ${status}"><div class="info">
      <div class="name">${esc(m.name || '(sem nome)')}</div>
      ${m.expiry ? `<div class="when">${fmtDate(m.expiry)} · ${m.qty > 0 ? m.qty + ' un.' : 'sem quantidade'}</div>` : ''}
      ${meta ? `<div class="meta">${meta}</div>` : ''}</div></li>`;
  }).join('');
  const parts = [`<b>${st.products}</b> produto(s)`];
  if (map.expiry >= 0) parts.push(`<b>${st.lots}</b> lote(s) com validade e quantidade`);
  if (st.badDates) parts.push(`<span class="summary-bad">${st.badDates} data(s) não reconhecida(s)</span>`);
  if (st.skipped) parts.push(`${st.skipped} linha(s) sem nome serão ignoradas`);

  el.innerHTML = `
    <div class="panel form">
      <h3>${esc(fileName)} — ${rows.length} linha(s)</h3>
      <p class="muted small">Confira qual coluna da planilha corresponde a cada informação:</p>
      <div class="grid2" id="sheet-map">
        ${SHEET_FIELDS.map((f) => `<label>${f.label}<select data-map="${f.key}">${opts(map[f.key])}</select></label>`).join('')}
      </div>
      <h3>Prévia</h3>
      <ul class="lot-list">${preview}</ul>
      <p class="small">Serão importados: ${parts.join(' · ')}.</p>
      <div class="row end">
        <button type="button" class="btn secondary" id="sheet-cancel">Cancelar</button>
        <button type="button" class="btn" id="sheet-confirm" ${map.name < 0 ? 'disabled' : ''}>Importar</button>
      </div>
    </div>`;
}

function confirmSheet() {
  const { rows, map } = sheetPending;
  if (map.name < 0) { toast('Escolha a coluna com o nome do produto.'); return; }
  let created = 0; let updated = 0; let lots = 0;
  rows.map((r) => mapRow(r, map)).forEach((m) => {
    let p = m.barcode ? findProductByBarcode(m.barcode) : (m.name && findProductByName(m.name));
    if (!p && !m.name) return;
    if (p) updated++;
    else {
      p = { id: m.barcode ? `ean:${m.barcode}` : `p:${uid()}`, barcode: m.barcode };
      db.products[p.id] = p;
      created++;
    }
    if (m.name) p.name = m.name;
    if (m.category) p.category = m.category;
    if (Number.isFinite(m.cost) && m.cost >= 0) p.cost = m.cost;
    if (m.expiry && m.qty > 0) {
      addLot({ productId: p.id, expiry: m.expiry, qty: m.qty, lot: m.lot, location: m.location });
      lots++;
    }
  });
  saveDb();
  sheetPending = null;
  toast(`Importado: ${created} produto(s) novo(s), ${updated} atualizado(s), ${lots} lote(s).`);
  location.hash = lots ? '#lotes' : '#novo';
}

/* ---------- view ---------- */
function renderImportar(arg) {
  const tab = ['planilha', 'fotos'].includes(arg) ? arg : 'nfe';
  $$('#import-tabs .chip').forEach((c) => c.classList.toggle('active', c.dataset.t === tab));
  $('#import-nfe').hidden = tab !== 'nfe';
  $('#import-planilha').hidden = tab !== 'planilha';
  $('#import-fotos').hidden = tab !== 'fotos';
  if (tab === 'fotos') renderFotos();
  fillDatalists();
  renderNfePreview();
  renderNfeHistory();
  renderSheetPreview();
}

function bindImport() {
  $('#nfe-file').addEventListener('change', (e) => {
    if (e.target.files.length) onNfeFiles([...e.target.files]);
    e.target.value = '';
  });
  const nfe = $('#nfe-preview');
  nfe.addEventListener('input', onNfeInput);
  nfe.addEventListener('change', onNfeInput);
  nfe.addEventListener('click', (e) => {
    if (e.target.id === 'nfe-confirm') confirmNfe();
    if (e.target.id === 'nfe-cancel') { nfePending = null; renderNfePreview(); }
    if (e.target.id === 'nfe-bip') openScanner(nfeLocate);
    const act = e.target.closest('[data-act]');
    const li = e.target.closest('.nfe-item');
    if (act && li && nfePending) {
      const i = Number(li.dataset.i);
      if (act.dataset.act === 'foto') onNfeItemPhotoClick(i);
      if (act.dataset.act === 'scan2d') openScanner((code) => applyNfe2D(i, code));
    }
  });
  $('#nfe-photo-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) onNfePhotoFile(file);
  });

  $('#sheet-file').addEventListener('change', (e) => {
    if (e.target.files[0]) onSheetFile(e.target.files[0]);
    e.target.value = '';
  });
  const sp = $('#sheet-preview');
  sp.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-map]');
    if (!sel || !sheetPending) return;
    sheetPending.map[sel.dataset.map] = Number(sel.value);
    renderSheetPreview();
  });
  sp.addEventListener('click', (e) => {
    if (e.target.id === 'sheet-confirm') confirmSheet();
    if (e.target.id === 'sheet-cancel') { sheetPending = null; renderSheetPreview(); }
  });
}
