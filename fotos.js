'use strict';

/* ============================================================
 * Várias fotos de uma vez
 * Cada foto mostra o verso de um produto (código de barras + validade).
 * A IA lê cada foto (função ler-etiqueta); o app monta uma lista para
 * conferir e salva tudo junto, como na importação da nota fiscal.
 * Depende de app.js / nuvem.js (db, addLot, readLabelPhoto, shrinkImage...).
 * ============================================================ */

const BATCH_MAX = 30;      // fotos por vez
const BATCH_PARALLEL = 3;  // leituras ao mesmo tempo
let batch = null;          // { running, items: [...] }

const FOTO_STATUS = {
  fila: 'Na fila…', lendo: 'Lendo a foto…', pronto: '', erro: '', cancelado: 'Leitura cancelada — preencha à mão ou desmarque.',
};

function onFotosFiles(files) {
  if (typeof cloudConnected !== 'function' || !cloudConnected()) {
    toast('A leitura por foto usa a nuvem: entre na sua conta em Ajustes.');
    return;
  }
  if (!navigator.onLine) { toast('Sem internet agora.'); return; }
  if (batch && batch.running) { toast('Aguarde terminar ou cancele a leitura atual.'); return; }
  if (files.length > BATCH_MAX) toast(`Vou ler as primeiras ${BATCH_MAX} fotos. Envie o resto depois.`);
  batch = {
    running: true,
    items: files.slice(0, BATCH_MAX).map((file, i) => ({
      i, file, status: 'fila', thumb: '', barcode: '', name: '', nameSource: '', category: '',
      expiry: '', lot: '', qty: 1, include: true, msg: '', confidence: '',
    })),
  };
  renderFotos();
  $('#fotos-preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
  processBatch(batch);
}

async function processBatch(b) {
  let next = 0;
  const worker = async () => {
    while (b.running && next < b.items.length) {
      const it = b.items[next++];
      await processItem(b, it);
    }
  };
  await Promise.all(Array.from({ length: BATCH_PARALLEL }, worker));
  b.items.forEach((it) => { if (it.status === 'fila') { it.status = 'cancelado'; it.include = false; } });
  b.running = false;
  if (batch === b) renderFotos();
}

async function processItem(b, it) {
  it.status = 'lendo';
  updateFotoItem(it);
  try {
    it.thumb = `data:image/jpeg;base64,${(await shrinkImage(it.file, 240, 0.7)).data}`;
    updateFotoItem(it);
    const photo = await shrinkImage(it.file);
    const r = await readLabelPhoto(photo.data, photo.mediaType);
    if (batch !== b) return; // lista descartada
    it.barcode = r.barcode || '';
    it.expiry = r.expiry ? fmtDate(r.expiry) : '';
    it.lot = r.lot || '';
    it.confidence = r.confidence;
    it.msg = r.note || '';
    if (r.month_year_only && it.expiry) it.msg = `Só mês/ano na embalagem. ${it.msg}`.trim();
    // nome: produto já cadastrado > base pública > o que a IA leu na embalagem
    const known = it.barcode && findProductByGtin(it.barcode);
    if (known) {
      it.name = known.name; it.nameSource = 'cadastro'; it.barcode = known.barcode || it.barcode;
    } else if (it.barcode) {
      const info = await lookupProductOnline(it.barcode);
      if (info) { it.name = info.name; it.category = info.category; it.nameSource = 'base pública'; }
    }
    if (!it.name && r.product_name) { it.name = r.product_name; it.nameSource = 'foto'; }
    if (!it.expiry) it.msg = it.msg || 'Não consegui ler a validade — digite.';
    it.status = 'pronto';
  } catch (e) {
    it.status = 'erro';
    it.msg = e.message || 'Não foi possível ler esta foto.';
    if (/limite/i.test(it.msg)) b.running = false; // limite do dia: para as próximas
  }
  if (batch === b) { updateFotoItem(it); updateFotosSummary(); }
}

function fotoValid(it) {
  return it.include && it.name.trim() && readExpiry(it.expiry).iso && it.qty > 0;
}

function fotoItemHTML(it) {
  const busy = it.status === 'fila' || it.status === 'lendo';
  const dis = busy ? 'disabled' : '';
  const statusMsg = FOTO_STATUS[it.status] || '';
  const conf = it.status === 'pronto' && it.expiry
    ? (it.confidence === 'high' ? 'Lido da foto — confira.' : 'Confira com atenção!') : '';
  const msg = [statusMsg, conf, it.msg, it.nameSource && it.name ? `Nome: ${it.nameSource}.` : ''].filter(Boolean).join(' ');
  const bad = it.status === 'erro' || (it.status === 'pronto' && (!it.expiry || it.confidence === 'low'));
  const missingExp = it.include && !busy && !readExpiry(it.expiry).iso;
  const missingName = it.include && !busy && !it.name.trim();
  return `
    <li class="nfe-item foto-item ${it.include ? '' : 'off'}" data-i="${it.i}">
      <div class="foto-head">
        ${it.thumb ? `<img src="${it.thumb}" alt="Foto ${it.i + 1}">` : '<div class="foto-ph">📷</div>'}
        <div class="foto-info">
          <label class="check"><input type="checkbox" data-f="include" ${it.include ? 'checked' : ''} ${dis}>
            <span class="name">${esc(it.name || (busy ? `Foto ${it.i + 1}` : '(sem nome)'))}</span></label>
          <div class="meta ${bad ? 'summary-bad' : ''}">${esc(msg)}</div>
        </div>
      </div>
      <div class="grid2">
        <label>Código de barras<input data-f="barcode" inputmode="numeric" value="${esc(it.barcode)}" ${dis}></label>
        <label>Produto *<input data-f="name" value="${esc(it.name)}" class="${missingName ? 'missing' : ''}" ${dis}></label>
      </div>
      <div class="grid3">
        <label>Validade *<input data-f="expiry" inputmode="numeric" placeholder="dd/mm/aaaa" maxlength="10" value="${esc(it.expiry)}" class="${missingExp ? 'missing' : ''}" ${dis}></label>
        <label>Qtd<input type="number" min="1" step="1" inputmode="numeric" data-f="qty" value="${it.qty}" ${dis}></label>
        <label>Lote<input data-f="lot" value="${esc(it.lot)}" ${dis}></label>
      </div>
    </li>`;
}

function renderFotos() {
  const el = $('#fotos-preview');
  if (!el) return;
  if (!batch) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="panel"><ul class="lot-list" id="fotos-list">${batch.items.map(fotoItemHTML).join('')}</ul></div>
    <div class="panel form sticky-actions">
      <label>Local (para todos)
        <input id="fotos-location" list="locations" placeholder="Depósito, Gôndola 2…">
      </label>
      <p class="small" id="fotos-summary"></p>
      <div class="row end" id="fotos-actions"></div>
    </div>`;
  updateFotosSummary();
}

function updateFotoItem(it) {
  const li = $(`#fotos-list .foto-item[data-i="${it.i}"]`);
  if (!li) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = fotoItemHTML(it).trim();
  li.replaceWith(tmp.firstChild);
}

function updateFotosSummary() {
  if (!batch) return;
  const s = $('#fotos-summary');
  const a = $('#fotos-actions');
  if (!s || !a) return;
  const busy = batch.items.filter((it) => it.status === 'fila' || it.status === 'lendo').length;
  const inc = batch.items.filter((it) => it.include && it.status !== 'fila' && it.status !== 'lendo');
  const ok = inc.filter(fotoValid).length;
  const missing = inc.length - ok;
  if (busy) {
    s.className = 'small';
    s.textContent = `Lendo ${busy} foto(s)… ${ok} pronta(s) para salvar.`;
    a.innerHTML = '<button type="button" class="btn secondary" id="fotos-cancel">✕ Cancelar leitura</button>';
  } else {
    s.className = `small ${missing ? 'summary-bad' : 'summary-ok'}`;
    s.textContent = missing
      ? `${ok} pronta(s) · ${missing} sem nome ou validade — preencha ou desmarque.`
      : `${ok} lote(s) prontos para salvar.`;
    a.innerHTML = `<button type="button" class="btn secondary" id="fotos-discard">Descartar</button>
      <button type="button" class="btn" id="fotos-save" ${ok ? '' : 'disabled'}>Salvar ${ok} lote(s)</button>`;
  }
}

function onFotosInput(e) {
  // campo que já saiu da tela (o item foi redesenhado): não sobrescreve o que foi lido
  if (!e.target.isConnected) return;
  const li = e.target.closest('.foto-item');
  if (!li || !batch) return;
  const it = batch.items[Number(li.dataset.i)];
  const f = e.target.dataset.f;
  if (f === 'include') {
    it.include = e.target.checked;
    li.classList.toggle('off', !it.include);
  } else if (f === 'expiry') {
    const m = maskDate(e.target.value);
    if (m !== e.target.value) e.target.value = m;
    it.expiry = m;
    e.target.classList.toggle('missing', it.include && !readExpiry(m).iso);
  } else if (f === 'qty') {
    it.qty = parseInt(e.target.value, 10) || 0;
  } else if (f === 'lot') {
    it.lot = e.target.value.trim();
  } else if (f === 'name') {
    it.name = e.target.value;
    it.nameSource = 'digitado';
    e.target.classList.toggle('missing', it.include && !it.name.trim());
    li.querySelector('.name').textContent = it.name || '(sem nome)';
  } else if (f === 'barcode') {
    it.barcode = e.target.value.trim();
    if (e.type === 'change') { // ao sair do campo: tenta achar o nome
      const p = it.barcode && findProductByGtin(it.barcode);
      if (p && (!it.name || it.nameSource !== 'digitado')) { it.name = p.name; it.nameSource = 'cadastro'; updateFotoItem(it); }
    }
  }
  updateFotosSummary();
}

function saveFotos() {
  const inc = batch.items.filter((it) => it.include && it.status !== 'fila' && it.status !== 'lendo');
  const bad = inc.find((it) => !fotoValid(it));
  if (bad) {
    toast('Preencha nome e validade dos itens marcados (ou desmarque-os).');
    $(`#fotos-list .foto-item[data-i="${bad.i}"] input[data-f=${bad.name.trim() ? 'expiry' : 'name'}]`)?.focus();
    return;
  }
  const place = $('#fotos-location').value.trim();
  inc.forEach((it) => {
    let p = it.barcode ? findProductByGtin(it.barcode) : findProductByName(it.name);
    if (!p) {
      p = { id: it.barcode ? `ean:${it.barcode}` : `p:${uid()}`, barcode: it.barcode, name: it.name.trim(), category: it.category || '' };
      db.products[p.id] = p;
    } else if (it.nameSource === 'digitado') {
      p.name = it.name.trim();
    }
    addLot({ productId: p.id, expiry: readExpiry(it.expiry).iso, qty: it.qty, lot: it.lot, location: place });
  });
  saveDb();
  batch = null;
  toast(`${inc.length} lote(s) salvos a partir das fotos.`);
  location.hash = '#lotes';
}

function bindFotos() {
  $('#fotos-file').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) onFotosFiles(files);
  });
  const el = $('#fotos-preview');
  el.addEventListener('input', onFotosInput);
  el.addEventListener('change', onFotosInput);
  el.addEventListener('click', (e) => {
    if (!batch) return;
    if (e.target.id === 'fotos-cancel') {
      batch.running = false; // as que já estão sendo lidas terminam; as da fila param
      toast('Leitura cancelada. As fotos que já estavam sendo lidas ainda vão aparecer.');
      updateFotosSummary();
    } else if (e.target.id === 'fotos-discard') {
      if (!confirm('Descartar esta lista? Nada será salvo.')) return;
      batch = null;
      renderFotos();
    } else if (e.target.id === 'fotos-save') {
      saveFotos();
    }
  });
}
