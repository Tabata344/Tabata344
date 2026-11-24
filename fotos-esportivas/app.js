// Lance Fotos: lógica das telas (atleta, compradas, fotógrafo), carrinho e card para stories.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = (v) => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pad = (n) => String(n).padStart(2, '0');
const fmtHora = (ms) => { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };
const fmtDur = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };
const parseDur = (txt) => {
  const p = String(txt || '').trim().split(/[:h'm]/).filter(Boolean).map(Number);
  if (!p.length || p.some(isNaN)) return null;
  while (p.length < 3) p.unshift(0);
  return ((p[0] * 60 + p[1]) * 60 + p[2]) * 1000;
};
const horaNoDia = (dataISO, hhmmss) => {
  if (!dataISO || !hhmmss) return null;
  const [y, m, d] = dataISO.split('-').map(Number);
  const [h, mi, s = 0] = hhmmss.split(':').map(Number);
  return Date.UTC(y, m - 1, d, h, mi, s);
};
const local = {
  get(k, def) { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } },
};

const S = {
  eventos: [], ev: null, fotos: [], compras: [], urls: new Map(),
  carrinho: local.get('lance-carrinho', {}), // { eventoId: [{ id, dividir }] }
  criterio: null, filtroF: 'todas',
};

function url(blob, chave) {
  if (!blob) return '';
  if (!S.urls.has(chave)) S.urls.set(chave, URL.createObjectURL(blob));
  return S.urls.get(chave);
}
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------------- Dados ----------------
async function carregar() {
  S.eventos = (await DB.all('eventos')).sort((a, b) => (b.data || '').localeCompare(a.data || ''));
  S.compras = await DB.all('compras');
  const escolhido = local.get('lance-evento', null);
  await escolherEvento(S.eventos.find((e) => e.id === escolhido) ? escolhido : S.eventos[0]?.id);
}

async function escolherEvento(id) {
  S.urls.forEach((u) => URL.revokeObjectURL(u)); S.urls.clear();
  S.ev = S.eventos.find((e) => e.id === id) || null;
  S.fotos = S.ev ? await DB.fotosDoEvento(S.ev.id) : [];
  S.criterio = null;
  local.set('lance-evento', S.ev?.id || null);
  $('#evento-sel').innerHTML = S.eventos.length
    ? S.eventos.map((e) => `<option value="${e.id}" ${e.id === S.ev?.id ? 'selected' : ''}>${esc(e.nome)}</option>`).join('')
    : '<option>Sem eventos</option>';
  render();
}

async function salvarEvento(ev) {
  await DB.put('eventos', ev);
  const i = S.eventos.findIndex((e) => e.id === ev.id);
  if (i >= 0) S.eventos[i] = ev; else S.eventos.unshift(ev);
}

// Processa um arquivo: horário (EXIF + correção do relógio), GPS, nitidez e miniaturas.
async function processarFoto(ev, blob, meta = {}) {
  let info = {};
  if (!meta.hora) {
    try { info = Exif.ler(await blob.slice(0, 256 * 1024).arrayBuffer()) || {}; } catch { info = {}; }
  }
  const camera = meta.camera || info.camera || 'Câmera sem nome';
  let hora = meta.hora ?? info.hora;
  let semHora = false;
  if (hora == null) {
    const d = new Date(blob.lastModified || Date.now());
    hora = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
    semHora = true;
  }
  if (!meta.hora) hora += (ev.relogios?.[camera] || 0);
  const img = await Analise.carregarImagem(blob);
  const thumbs = await Analise.miniatura(img, ev.fotografo ? `© ${ev.fotografo}` : 'LANCE');
  return {
    id: uid(), eventoId: ev.id, pontoId: meta.pontoId, hora, camera, semHora,
    lat: info.lat, lng: info.lng, largura: img.width, altura: img.height,
    nitidez: Analise.nitidez(img), peitos: meta.peitos || [], marcada: !!meta.marcada,
    original: blob, thumb: thumbs.marcada, thumbLimpa: thumbs.limpa,
  };
}

async function retriar() {
  Analise.triagem(S.fotos);
  await DB.putMany('fotos', S.fotos);
}

async function carregarDemo() {
  const btns = $$('#btn-demo-1, #btn-demo-2'); btns.forEach((b) => { b.disabled = true; });
  try {
    const { evento, arquivos } = await Demo.gerar((i, n) => btns.forEach((b) => { b.textContent = `Gerando fotos ${i}/${n}…`; }));
    await DB.apagarEvento(evento.id);
    const fotos = [];
    for (const a of arquivos) fotos.push(await processarFoto(evento, a.blob, a));
    Analise.triagem(fotos);
    await DB.putMany('fotos', fotos);
    await salvarEvento(evento);
    await escolherEvento(evento.id);
    location.hash = '#atleta';
    toast(Demo.dica, 7000);
    $('#b-largada').value = ''; $('#b-liquido').value = '';
  } finally {
    btns.forEach((b) => { b.disabled = false; b.textContent = 'Carregar evento de demonstração'; });
  }
}

// ---------------- Roteamento ----------------
function view() { return (location.hash.slice(1) || 'atleta').split('/')[0]; }
function render() {
  const v = ['atleta', 'minhas', 'fotografo'].includes(view()) ? view() : 'atleta';
  $$('.view').forEach((s) => { s.hidden = s.id !== `view-${v}`; });
  $$('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.v === v));
  const nComp = new Set(S.compras.flatMap((c) => c.fotoIds)).size;
  $('#n-compradas').textContent = nComp || '';
  if (v === 'atleta') renderAtleta();
  if (v === 'minhas') renderCompradas();
  if (v === 'fotografo') renderFotografo();
  renderCarrinhoBotao();
}

// ---------------- Atleta ----------------
function renderAtleta() {
  $('#sem-evento').hidden = !!S.ev;
  $('#busca').hidden = !S.ev;
  $('.privacidade').hidden = !S.ev;
  if (!S.ev) { $('#resultado').hidden = true; return; }
  $('#ocultos-lista').textContent = S.ev.ocultos?.length ? `Ocultos neste evento: ${S.ev.ocultos.join(', ')}` : '';
  renderResultado();
}

function lerCriterio() {
  const c = {
    peito: $('#b-peito').value.trim().replace(/\D/g, '') || null,
    largada: horaNoDia(S.ev.data, $('#b-largada').value),
    liquido: parseDur($('#b-liquido').value),
    gpx: S.gpx || null,
  };
  if (!c.peito && !(c.largada && c.liquido) && !c.gpx) return null;
  return c;
}

function renderResultado() {
  const box = $('#resultado');
  if (!S.criterio) { box.hidden = true; return; }
  const { resultados, passagens } = Analise.buscar(S.ev, S.fotos, S.criterio);
  const soMelhores = $('#so-melhores').checked;
  const lista = resultados.filter((r) => !soMelhores || !r.foto.rajada || r.foto.melhorDaRajada || r.score >= 100);
  box.hidden = false;
  $('#res-tit').textContent = lista.length ? lista.length > 1 ? `${lista.length} fotos prováveis` : '1 foto provável' : 'Nenhuma foto encontrada';
  $('#passagens').innerHTML = S.ev.pontos.map((p) => {
    const ps = passagens[p.id];
    return ps ? `<span>📍 ${esc(p.nome)}: passou ~${fmtHora(ps.hora)} <span class="muted">(${ps.fonte})</span></span>` : '';
  }).join('');
  const noCarrinho = new Set(carrinho().map((i) => i.id));
  const max = Math.max(160, ...lista.map((r) => r.score));
  $('#grade').innerHTML = lista.map((r) => cardHTML(r.foto, { conf: r.score / max, motivo: r.motivo, carrinho: noCarrinho.has(r.foto.id) })).join('')
    || '<p class="muted">Tente aumentar as pistas: confira a hora da largada (a sua, não a do tiro) e o tempo líquido.</p>';
}

function cardHTML(f, o = {}) {
  const comprada = comprou(f.id);
  const badge = f.desfocada ? '<span class="badge ruim">tremida</span>'
    : f.rajada && f.melhorDaRajada ? '<span class="badge melhor">★ melhor da sequência</span>'
      : comprada ? '<span class="badge melhor">comprada</span>' : '';
  return `<div class="card ${o.carrinho ? 'no-carrinho' : ''}" data-foto="${f.id}" title="${esc(o.motivo || '')}">
    <img loading="lazy" src="${url(comprada || o.limpa ? f.thumbLimpa : f.thumb, f.id + (comprada || o.limpa ? 'L' : 'M'))}" alt="Foto ${fmtHora(f.hora)}">
    ${badge}
    ${o.conf != null && !comprada ? `<button class="add" data-add="${f.id}" aria-label="Carrinho">${o.carrinho ? '✓' : '+'}</button>` : ''}
    ${o.conf != null ? `<div class="conf"><i style="width:${Math.round(Math.min(1, o.conf) * 100)}%"></i></div>` : ''}
  </div>`;
}

// ---------------- Carrinho / preço ----------------
function carrinho() { return S.ev ? (S.carrinho[S.ev.id] ||= []) : []; }
function salvarCarrinho() { local.set('lance-carrinho', S.carrinho); renderCarrinhoBotao(); }
function comprou(id) { return S.compras.some((c) => c.fotoIds.includes(id)); }
function alternarCarrinho(id) {
  const c = carrinho();
  const i = c.findIndex((x) => x.id === id);
  if (i >= 0) c.splice(i, 1); else c.push({ id, dividir: false });
  salvarCarrinho();
}
function precoItem(it) {
  const f = S.fotos.find((x) => x.id === it.id);
  const n = f?.peitos.length || 1;
  return it.dividir && n > 1 ? S.ev.preco / n : S.ev.preco;
}
function totais() {
  const itens = carrinho().filter((it) => S.fotos.some((f) => f.id === it.id));
  const soma = itens.reduce((s, it) => s + precoItem(it), 0);
  const cheio = itens.length * S.ev.preco;
  const teto = S.ev.precoPacote > 0 ? S.ev.precoPacote : Infinity;
  const total = Math.min(soma, teto);
  return { itens, soma, cheio, total, economia: cheio - total, noTeto: soma > teto };
}
function renderCarrinhoBotao() {
  const n = S.ev ? carrinho().length : 0;
  $('#btn-carrinho').hidden = !n || view() === 'fotografo';
  if (n) $('#carrinho-n').textContent = `${n} · ${brl(totais().total)}`;
}
function abrirCarrinho() {
  const t = totais();
  $('#carrinho-itens').innerHTML = t.itens.map((it) => {
    const f = S.fotos.find((x) => x.id === it.id);
    const ponto = S.ev.pontos.find((p) => p.id === f.pontoId);
    const grupo = f.peitos.length > 1;
    return `<li>
      <img src="${url(f.thumb, f.id + 'M')}" alt="" style="width:72px;height:48px;object-fit:cover;border-radius:6px">
      <div style="flex:1">${esc(ponto?.nome || '')} · ${fmtHora(f.hora)}
        ${grupo ? `<label class="switch small"><input type="checkbox" data-dividir="${f.id}" ${it.dividir ? 'checked' : ''}>
          dividir com ${f.peitos.length - 1} atleta(s) da foto (${f.peitos.join(', ')})</label>` : ''}</div>
      <b>${brl(precoItem(it))}</b>
      <button class="btn ghost small" data-rem="${f.id}" aria-label="Remover">✕</button></li>`;
  }).join('') || '<li class="muted">Vazio</li>';
  $('#carrinho-total').innerHTML = `
    <div class="total-linha"><span>${t.itens.length} foto(s) × ${brl(S.ev.preco)}</span><span>${brl(t.cheio)}</span></div>
    ${t.economia > 0.001 ? `<div class="total-linha economia"><span>${t.noTeto ? `Teto do evento: todas por ${brl(S.ev.precoPacote)}` : 'Fotos divididas com amigos'}</span><span>− ${brl(t.economia)}</span></div>` : ''}
    <div class="total-linha forte"><span>Total</span><span>${brl(t.total)}</span></div>
    ${!t.noTeto && S.ev.precoPacote > 0 && t.itens.length ? `<p class="muted small">Você nunca paga mais que ${brl(S.ev.precoPacote)} neste evento: a partir daí, as próximas fotos saem de graça.</p>` : ''}`;
  $('#btn-pagar').disabled = !t.itens.length;
  const d = $('#dlg-carrinho'); if (!d.open) d.showModal();
}
async function pagar() {
  const t = totais();
  const compra = {
    id: uid(), eventoId: S.ev.id, fotoIds: t.itens.map((i) => i.id), total: t.total, data: Date.now(),
    divididas: t.itens.filter((i) => i.dividir).map((i) => i.id),
  };
  await DB.put('compras', compra);
  S.compras.push(compra);
  S.carrinho[S.ev.id] = []; salvarCarrinho();
  $('#dlg-carrinho').close();
  toast(compra.divididas.length ? 'Pago! Os amigos das fotos divididas recebem um link para pagar a parte deles.' : 'Pago! Suas fotos estão em "Compradas".', 5000);
  location.hash = '#minhas';
  render();
}

// ---------------- Foto (modal) ----------------
function abrirFoto(id) {
  const f = S.fotos.find((x) => x.id === id) || S.todasCompradas?.find((x) => x.id === id);
  if (!f) return;
  const ev = S.eventos.find((e) => e.id === f.eventoId) || S.ev;
  const ponto = ev.pontos.find((p) => p.id === f.pontoId);
  const comprada = comprou(f.id);
  const fotografo = view() === 'fotografo';
  $('#foto-img').src = comprada ? url(f.original, f.id + 'O') : url(fotografo ? f.thumbLimpa : f.thumb, f.id + (fotografo ? 'L' : 'M'));
  $('#foto-info').innerHTML = `<b>${esc(ponto?.nome || '')}</b> · ${fmtHora(f.hora)}${f.semHora ? ' <span class="tag">horário do arquivo</span>' : ''}<br>
    <span class="muted">Números: ${f.peitos.length ? esc(f.peitos.join(', ')) : 'não identificados'} · nitidez ${f.nitidez}
    ${f.desfocada ? '· tremida' : ''}${f.rajada ? ` · sequência${f.melhorDaRajada ? ' (melhor)' : ''}` : ''} · ${f.largura}×${f.altura}</span>`;
  const no = carrinho().some((i) => i.id === f.id);
  $('#foto-acoes').innerHTML = (fotografo ? `<button class="btn ghost" data-remarcar="${f.id}">Corrigir números</button>`
    : comprada ? `<a class="btn" download="lance-${fmtHora(f.hora).replace(/:/g, '')}.jpg" href="${url(f.original, f.id + 'O')}">Baixar original</a>
       <button class="btn ghost" data-card="${f.id}">Card para stories</button>`
      : `<button class="btn" data-add="${f.id}">${no ? '✓ No carrinho' : `Adicionar · ${brl(ev.preco)}`}</button>`)
    + '<button class="btn ghost" data-close>Fechar</button>';
  const d = $('#dlg-foto'); if (!d.open) d.showModal();
}

// ---------------- Compradas ----------------
async function renderCompradas() {
  const ids = new Set(S.compras.flatMap((c) => c.fotoIds));
  const fotos = (await Promise.all([...ids].map((id) => DB.get('fotos', id)))).filter(Boolean).sort((a, b) => a.hora - b.hora);
  S.todasCompradas = fotos;
  $('#grade-compradas').innerHTML = fotos.map((f) => cardHTML(f, { limpa: true })).join('')
    || '<p class="muted">Você ainda não comprou fotos. <a href="#atleta">Buscar as minhas</a></p>';
}

// ---------------- Card para stories ----------------
let cardFoto = null;
async function abrirCard(id) {
  cardFoto = S.todasCompradas?.find((x) => x.id === id) || S.fotos.find((x) => x.id === id);
  const g = S.criterio?.gpx;
  const liq = S.criterio?.liquido || (g?.length ? g[g.length - 1].hora - g[0].hora : null);
  if (liq && !$('#card-tempo').value) $('#card-tempo').value = fmtDur(liq);
  $('#dlg-foto').close();
  $('#dlg-card').showModal();
  await desenharCard();
}
async function desenharCard() {
  if (!cardFoto) return;
  const ev = S.eventos.find((e) => e.id === cardFoto.eventoId);
  const cv = $('#card-canvas'), ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const img = await Analise.carregarImagem(cardFoto.original);
  ctx.fillStyle = '#0b0f14'; ctx.fillRect(0, 0, W, H);
  const areaH = H * 0.72, esc2 = Math.max(W / img.width, areaH / img.height);
  const iw = img.width * esc2, ih = img.height * esc2;
  ctx.drawImage(img, (W - iw) / 2, (areaH - ih) / 2, iw, ih);
  const g = ctx.createLinearGradient(0, areaH * 0.6, 0, areaH);
  g.addColorStop(0, 'rgba(11,15,20,0)'); g.addColorStop(1, 'rgba(11,15,20,1)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, areaH);
  const tempoMs = parseDur($('#card-tempo').value);
  const nome = $('#card-nome').value.trim();
  ctx.textAlign = 'left';
  ctx.fillStyle = '#c6f432'; ctx.font = 'italic 900 64px system-ui, sans-serif';
  ctx.fillText((ev?.modalidade || '').toUpperCase(), 70, areaH + 20);
  ctx.fillStyle = '#fff'; ctx.font = '800 58px system-ui, sans-serif';
  quebra(ctx, ev?.nome || '', 70, areaH + 100, W - 140, 66);
  const stats = [[`${ev?.distanciaKm ?? ''} km`, 'distância']];
  if (tempoMs) {
    stats.push([fmtDur(tempoMs), 'tempo']);
    const pace = tempoMs / 1000 / (ev?.distanciaKm || 1);
    stats.push([`${Math.floor(pace / 60)}'${pad(Math.round(pace % 60))}"`, 'ritmo /km']);
  }
  stats.forEach(([v, l], i) => {
    const x = 70 + i * ((W - 140) / 3);
    ctx.fillStyle = '#fff'; ctx.font = '900 76px system-ui, sans-serif'; ctx.fillText(v, x, H - 230);
    ctx.fillStyle = '#8b98a8'; ctx.font = '600 36px system-ui, sans-serif'; ctx.fillText(l, x, H - 180);
  });
  ctx.fillStyle = '#8b98a8'; ctx.font = '600 36px system-ui, sans-serif';
  ctx.fillText([nome, ev?.fotografo && `📸 ${ev.fotografo}`].filter(Boolean).join('  ·  '), 70, H - 90);
  ctx.textAlign = 'right'; ctx.fillStyle = '#c6f432'; ctx.font = 'italic 900 44px system-ui, sans-serif';
  ctx.fillText('LANCE', W - 70, H - 90);
}
function quebra(ctx, txt, x, y, max, lh) {
  let linha = '';
  txt.split(' ').forEach((p) => {
    const t = linha ? `${linha} ${p}` : p;
    if (ctx.measureText(t).width > max && linha) { ctx.fillText(linha, x, y); y += lh; linha = p; } else linha = t;
  });
  ctx.fillText(linha, x, y);
}
const cardBlob = () => new Promise((r) => $('#card-canvas').toBlob(r, 'image/png'));

// ---------------- Fotógrafo ----------------
function renderFotografo() {
  $('#lista-eventos').innerHTML = S.eventos.map((e) => `<li class="evento ${e.id === S.ev?.id ? 'sel' : ''}" data-ev="${e.id}">
    <span><b>${esc(e.nome)}</b><br><span class="muted small">${e.data.split('-').reverse().join('/')} · ${esc(e.modalidade)} · ${e.distanciaKm} km</span></span>
    <span>›</span></li>`).join('') || '<li class="muted">Nenhum evento. Crie o primeiro.</li>';
  const det = $('#f-detalhe');
  det.hidden = !S.ev || !$('#form-evento').hidden;
  if (det.hidden) return;
  const ev = S.ev;
  $('#f-tit').textContent = ev.nome;
  const vendidas = S.compras.filter((c) => c.eventoId === ev.id);
  const receita = vendidas.reduce((s, c) => s + c.total, 0);
  const st = [
    [S.fotos.length, 'fotos'],
    [S.fotos.filter((f) => f.desfocada).length, 'tremidas (escondidas)'],
    [new Set(S.fotos.filter((f) => f.rajada).map((f) => f.rajada)).size, 'sequências'],
    [S.fotos.filter((f) => !f.peitos.length).length, 'sem número'],
    [new Set(vendidas.flatMap((c) => c.fotoIds)).size, 'vendidas'],
    [brl(receita), 'receita'],
  ];
  $('#f-stats').innerHTML = st.map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
  $('#up-ponto').innerHTML = ev.pontos.map((p) => `<option value="${p.id}">${esc(p.nome)} (km ${p.km})</option>`).join('');
  $('#sync-lista').innerHTML = Object.entries(ev.relogios || {}).map(([cam, off]) =>
    `<li><span>${esc(cam)}</span><b>${off === 0 ? 'certinho' : `${off > 0 ? 'atrasada' : 'adiantada'} ${Math.abs(off / 1000).toFixed(1)} s`}</b></li>`).join('');
  $('#sync-hora').value ||= fmtHora(Date.now() - new Date().getTimezoneOffset() * 60000);
  renderMarcacao();
  renderGradeFotografo();
}

function renderGradeFotografo() {
  const f = S.filtroF;
  const lista = S.fotos.filter((x) => f === 'todas' || (f === 'melhores' && (!x.rajada || x.melhorDaRajada) && !x.desfocada)
    || (f === 'desfocadas' && x.desfocada) || (f === 'sem' && !x.peitos.length)).sort((a, b) => a.hora - b.hora);
  $$('#f-filtros .chip').forEach((c) => c.classList.toggle('on', c.dataset.f === f));
  $('#f-grade').innerHTML = lista.map((x) => cardHTML(x, { limpa: true })).join('') || '<p class="muted small">Nada aqui.</p>';
}

let marcandoId = null;
function filaMarcacao() { return S.fotos.filter((f) => !f.marcada).sort((a, b) => a.pontoId.localeCompare(b.pontoId) || a.hora - b.hora); }
function renderMarcacao(forcarId) {
  const fila = filaMarcacao();
  const f = forcarId ? S.fotos.find((x) => x.id === forcarId) : fila[0];
  marcandoId = f?.id || null;
  $('#marca-cont').textContent = fila.length ? `${fila.length} para marcar` : 'tudo marcado ✓';
  if (!f) { $('#marcacao').innerHTML = '<p class="muted small">Nenhuma foto esperando marcação.</p>'; return; }
  // sugestão: números já marcados em outra foto da mesma sequência
  const irmas = f.rajada ? S.fotos.filter((x) => x.rajada === f.rajada && x.marcada && x.id !== f.id) : [];
  const sug = f.peitos.length ? f.peitos : irmas[0]?.peitos || [];
  $('#marcacao').innerHTML = `<div class="marca-box">
    <img src="${url(f.thumbLimpa, f.id + 'L')}" alt="">
    <div class="row-inline">
      <input id="marca-num" inputmode="numeric" autocomplete="off" placeholder="nº de peito" value="${esc(sug.join(' '))}">
      <button class="btn" id="btn-marca-ok">OK ⏎</button>
    </div>
    <p class="muted small">${fmtHora(f.hora)}${f.rajada ? ' · faz parte de uma sequência: os números valem para as outras fotos dela' : ''}</p>
  </div>`;
  const inp = $('#marca-num');
  if (view() === 'fotografo' && document.activeElement?.id !== 'up-fotos') inp.focus({ preventScroll: true });
}
async function salvarMarcacao() {
  const f = S.fotos.find((x) => x.id === marcandoId);
  if (!f) return;
  const nums = [...new Set(($('#marca-num').value.match(/\d+/g) || []))];
  const alvo = f.rajada ? S.fotos.filter((x) => x.rajada === f.rajada && (!x.marcada || x.id === f.id)) : [f];
  alvo.forEach((x) => { x.peitos = nums; x.marcada = true; });
  await DB.putMany('fotos', alvo);
  renderFotografo();
}

function abrirFormEvento(ev) {
  const fm = $('#form-evento');
  fm.hidden = false; $('#f-detalhe').hidden = true;
  fm.dataset.id = ev?.id || '';
  $('#form-evento-tit').textContent = ev ? 'Editar evento' : 'Novo evento';
  const v = ev || { data: new Date().toISOString().slice(0, 10), distanciaKm: 10, preco: 19.9, precoPacote: 59.9, modalidade: 'Corrida',
    pontos: [{ id: uid(), nome: 'Chegada', km: 10 }] };
  ['nome', 'data', 'modalidade', 'distanciaKm', 'fotografo', 'preco', 'precoPacote'].forEach((k) => { fm.elements[k].value = v[k] ?? ''; });
  $('#pontos-form').innerHTML = '';
  v.pontos.forEach(addPontoForm);
  fm.scrollIntoView({ behavior: 'smooth' });
}
function addPontoForm(p = {}) {
  const div = document.createElement('div');
  div.className = 'ponto-row';
  div.dataset.id = p.id || uid();
  div.innerHTML = `<div class="row2"><label>Nome<input data-k="nome" required value="${esc(p.nome || '')}" placeholder="Km 5"></label>
    <label>Km<input data-k="km" type="number" step="0.01" min="0" required value="${p.km ?? ''}"></label></div>
    <div class="row-inline" style="margin-bottom:10px">
      <input data-k="lat" type="number" step="any" placeholder="latitude (opcional)" value="${p.lat ?? ''}">
      <input data-k="lng" type="number" step="any" placeholder="longitude (opcional)" value="${p.lng ?? ''}">
      <button type="button" class="btn ghost small" data-rem-ponto aria-label="Remover ponto">✕</button></div>`;
  $('#pontos-form').append(div);
}
async function salvarFormEvento(e) {
  e.preventDefault();
  const fm = e.target;
  const antigo = S.eventos.find((x) => x.id === fm.dataset.id);
  const num = (v) => (v === '' ? undefined : Number(v));
  const pontos = $$('.ponto-row', fm).map((r) => ({
    id: r.dataset.id, nome: $('[data-k=nome]', r).value.trim(), km: Number($('[data-k=km]', r).value),
    lat: num($('[data-k=lat]', r).value), lng: num($('[data-k=lng]', r).value),
  }));
  if (!pontos.length) { toast('Adicione pelo menos um ponto de foto.'); return; }
  const ev = {
    ...(antigo || { id: uid(), relogios: {}, ocultos: [] }),
    nome: fm.elements.nome.value.trim(), data: fm.elements.data.value, modalidade: fm.elements.modalidade.value,
    distanciaKm: Number(fm.elements.distanciaKm.value), fotografo: fm.elements.fotografo.value.trim(),
    preco: Number(fm.elements.preco.value) || 0, precoPacote: Number(fm.elements.precoPacote.value) || 0, pontos,
  };
  await salvarEvento(ev);
  fm.hidden = true;
  await escolherEvento(ev.id);
  toast('Evento salvo.');
}

async function enviarFotos(files) {
  const ev = S.ev, pontoId = $('#up-ponto').value;
  const prog = $('#up-progresso'); prog.hidden = false;
  let semHora = 0, erros = 0;
  const novas = [];
  for (let i = 0; i < files.length; i++) {
    $('span', prog).textContent = `Analisando ${i + 1} de ${files.length}…`;
    $('div', prog).style.width = `${((i + 1) / files.length) * 100}%`;
    try {
      const f = await processarFoto(ev, files[i], { pontoId });
      if (f.semHora) semHora++;
      novas.push(f);
    } catch { erros++; }
  }
  // GPS das fotos completa a posição do ponto, se faltar
  const ponto = ev.pontos.find((p) => p.id === pontoId);
  const comGps = novas.filter((f) => f.lat != null);
  if (ponto && ponto.lat == null && comGps.length) {
    ponto.lat = comGps.reduce((s, f) => s + f.lat, 0) / comGps.length;
    ponto.lng = comGps.reduce((s, f) => s + f.lng, 0) / comGps.length;
    await salvarEvento(ev);
  }
  S.fotos.push(...novas);
  await retriar();
  prog.hidden = true;
  $('#up-fotos').value = '';
  toast(`${novas.length} foto(s) adicionadas.${semHora ? ` ${semHora} sem horário na foto (usado o do arquivo).` : ''}${erros ? ` ${erros} com erro.` : ''}`, 5000);
  render();
}

async function sincronizarRelogio() {
  const file = $('#sync-foto').files[0];
  const hhmmss = $('#sync-hora').value;
  if (!file || !hhmmss) { toast('Envie a foto do relógio e digite a hora que aparece nela.'); return; }
  const info = Exif.ler(await file.slice(0, 256 * 1024).arrayBuffer());
  if (!info?.hora) { toast('Essa foto não tem horário (EXIF). Use o arquivo original da câmera.'); return; }
  const d = new Date(info.hora);
  const real = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), ...hhmmss.split(':').map(Number));
  let off = real - info.hora;
  if (Math.abs(off) > 12 * 3600000) { toast('Diferença maior que 12 h: confira a data/hora digitada.'); return; }
  off = Math.round(off / 100) * 100;
  const cam = info.camera || 'Câmera sem nome';
  const antes = S.ev.relogios[cam] || 0;
  S.ev.relogios[cam] = off;
  await salvarEvento(S.ev);
  // corrige as fotos já enviadas dessa câmera
  const afetadas = S.fotos.filter((f) => f.camera === cam && !f.semHora);
  afetadas.forEach((f) => { f.hora += off - antes; });
  await retriar();
  $('#sync-foto').value = '';
  toast(`${cam}: ${off === 0 ? 'relógio certo' : `${(Math.abs(off) / 1000).toFixed(1)} s ${off > 0 ? 'atrasada' : 'adiantada'}`}.${afetadas.length ? ` ${afetadas.length} foto(s) corrigidas.` : ''}`, 5000);
  render();
}

// ---------------- Eventos de tela ----------------
function ligar() {
  window.addEventListener('hashchange', render);
  $('#evento-sel').addEventListener('change', (e) => escolherEvento(e.target.value));
  $$('#btn-demo-1, #btn-demo-2').forEach((b) => b.addEventListener('click', carregarDemo));

  $('#btn-buscar').addEventListener('click', () => {
    const c = lerCriterio();
    if (!c) { toast('Informe o número de peito, ou a hora da largada + tempo líquido, ou o arquivo GPX.'); return; }
    if ($('#b-liquido').value && !c.liquido) { toast('Tempo líquido inválido. Use h:mm:ss, ex.: 0:52:10'); return; }
    S.criterio = c;
    renderResultado();
    $('#resultado').scrollIntoView({ behavior: 'smooth' });
  });
  $('#btn-limpar').addEventListener('click', () => {
    ['#b-peito', '#b-largada', '#b-liquido', '#b-gpx'].forEach((s) => { $(s).value = ''; });
    S.gpx = null; S.criterio = null; renderResultado();
  });
  $('#b-gpx').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) { S.gpx = null; return; }
    const pts = Analise.lerGPX(await f.text());
    if (pts.length < 2) { toast('Não achei pontos com horário nesse GPX.'); S.gpx = null; e.target.value = ''; return; }
    S.gpx = pts;
    toast(`GPX lido: ${pts[pts.length - 1].km.toFixed(2)} km, ${fmtDur(pts[pts.length - 1].hora - pts[0].hora)}.`);
  });
  $('#so-melhores').addEventListener('change', renderResultado);

  $('#btn-ocultar').addEventListener('click', async () => {
    const n = $('#ocultar-num').value.replace(/\D/g, '');
    if (!n) return;
    S.ev.ocultos = [...new Set([...(S.ev.ocultos || []), n])];
    await salvarEvento(S.ev);
    $('#ocultar-num').value = '';
    toast(`Fotos com o nº ${n} não aparecem mais para outras pessoas.`);
    renderAtleta();
  });

  // cliques em cards, carrinho e botões dentro de modais
  document.addEventListener('click', (e) => {
    const t = e.target;
    const add = t.closest('[data-add]');
    if (add) {
      e.stopPropagation();
      alternarCarrinho(add.dataset.add);
      if ($('#dlg-foto').open) abrirFoto(add.dataset.add);
      if (view() === 'atleta') renderResultado();
      return;
    }
    if (t.closest('[data-close]')) { t.closest('dialog').close(); return; }
    const rem = t.closest('[data-rem]');
    if (rem) { alternarCarrinho(rem.dataset.rem); abrirCarrinho(); if (view() === 'atleta') renderResultado(); return; }
    const card = t.closest('[data-card]');
    if (card) { abrirCard(card.dataset.card); return; }
    const remarcar = t.closest('[data-remarcar]');
    if (remarcar) { $('#dlg-foto').close(); renderMarcacao(remarcar.dataset.remarcar); $('#marcacao').scrollIntoView({ behavior: 'smooth' }); return; }
    const foto = t.closest('.card[data-foto]');
    if (foto) { abrirFoto(foto.dataset.foto); return; }
    const evLi = t.closest('[data-ev]');
    if (evLi) { $('#form-evento').hidden = true; escolherEvento(evLi.dataset.ev); return; }
    if (t.closest('[data-rem-ponto]')) { t.closest('.ponto-row').remove(); }
  });
  document.addEventListener('change', (e) => {
    const d = e.target.closest('[data-dividir]');
    if (d) {
      const it = carrinho().find((i) => i.id === d.dataset.dividir);
      if (it) { it.dividir = d.checked; salvarCarrinho(); abrirCarrinho(); }
    }
  });
  $$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

  $('#btn-carrinho').addEventListener('click', abrirCarrinho);
  $('#btn-pagar').addEventListener('click', pagar);

  $('#card-nome').addEventListener('input', desenharCard);
  $('#card-tempo').addEventListener('input', desenharCard);
  $('#btn-card-baixar').addEventListener('click', async () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await cardBlob()); a.download = 'lance-stories.png'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
  $('#btn-card-share').addEventListener('click', async () => {
    const file = new File([await cardBlob()], 'lance-stories.png', { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) navigator.share({ files: [file] }).catch(() => {});
    else toast('Este navegador não compartilha imagens. Use "Baixar imagem".');
  });

  // fotógrafo
  $('#btn-novo-evento').addEventListener('click', () => abrirFormEvento(null));
  $('#btn-editar-evento').addEventListener('click', () => abrirFormEvento(S.ev));
  $('#btn-cancelar-evento').addEventListener('click', () => { $('#form-evento').hidden = true; render(); });
  $('#btn-add-ponto').addEventListener('click', () => addPontoForm());
  $('#form-evento').addEventListener('submit', salvarFormEvento);
  $('#btn-apagar-evento').addEventListener('click', async () => {
    const b = $('#btn-apagar-evento');
    if (!b.dataset.conf) {
      b.dataset.conf = '1'; b.textContent = `Confirmar: apagar ${S.fotos.length} fotos`;
      setTimeout(() => { delete b.dataset.conf; b.textContent = 'Apagar'; }, 4000);
      return;
    }
    delete b.dataset.conf; b.textContent = 'Apagar';
    await DB.apagarEvento(S.ev.id);
    S.eventos = S.eventos.filter((e) => e.id !== S.ev.id);
    await escolherEvento(S.eventos[0]?.id);
  });
  $('#up-fotos').addEventListener('change', (e) => { if (e.target.files.length) enviarFotos([...e.target.files]); });
  $('#btn-sync').addEventListener('click', sincronizarRelogio);
  $('#f-filtros').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) { S.filtroF = c.dataset.f; renderGradeFotografo(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'marca-num') { e.preventDefault(); salvarMarcacao(); } });
  document.addEventListener('click', (e) => { if (e.target.id === 'btn-marca-ok') salvarMarcacao(); });

  // relógio de sincronização (hora local, com décimos)
  setInterval(() => {
    if (view() !== 'fotografo' || $('#f-detalhe').hidden) return;
    const n = new Date();
    $('#relogio').innerHTML = `${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}<small>.${Math.floor(n.getMilliseconds() / 100)}</small>`;
  }, 100);
}

ligar();
carregar().catch((e) => { console.error(e); toast('Erro ao abrir o armazenamento do navegador.'); });
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
