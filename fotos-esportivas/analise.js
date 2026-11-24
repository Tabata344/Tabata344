// Análise das fotos (tudo no aparelho): nitidez, sequências (rajadas), miniaturas com marca d'água,
// e a busca por trajeto/tempo de prova (GPX ou tempo líquido).
const Analise = (() => {
  async function carregarImagem(blob) {
    if ('createImageBitmap' in window) {
      try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { /* segue */ }
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { resolve(img); URL.revokeObjectURL(img.src); };
      img.onerror = reject;
      img.src = URL.createObjectURL(blob);
    });
  }

  // Nitidez = variância do Laplaciano numa versão reduzida em tons de cinza.
  function nitidez(img) {
    const w = 320, h = Math.max(1, Math.round((img.height / img.width) * w));
    const c = OffscreenCanvasOu(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    let soma = 0, soma2 = 0, n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const l = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i];
        soma += l; soma2 += l * l; n++;
      }
    }
    const media = soma / n;
    return Math.round(soma2 / n - media * media);
  }

  function OffscreenCanvasOu(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  // Miniatura com marca d'água (o original só é liberado depois da compra).
  async function miniatura(img, marca, larg = 640) {
    const w = Math.min(larg, img.width), h = Math.round((img.height / img.width) * w);
    const c = OffscreenCanvasOu(w, h);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-Math.PI / 7);
    ctx.font = `800 ${Math.round(w / 14)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,.28)';
    ctx.strokeStyle = 'rgba(0,0,0,.18)';
    for (let y = -h; y <= h; y += w / 5) {
      ctx.fillText(marca, 0, y);
      ctx.strokeText(marca, 0, y);
    }
    ctx.restore();
    const limpa = OffscreenCanvasOu(w, h);
    limpa.getContext('2d').drawImage(img, 0, 0, w, h);
    return {
      marcada: await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.78)),
      limpa: await new Promise((r) => limpa.toBlob(r, 'image/jpeg', 0.82)),
    };
  }

  // Marca "desfocada" (relativo à mediana do mesmo ponto) e agrupa rajadas, elegendo a melhor de cada uma.
  function triagem(fotos) {
    const porPonto = {};
    fotos.forEach((f) => (porPonto[f.pontoId] ||= []).push(f));
    Object.values(porPonto).forEach((lista) => {
      const valores = lista.map((f) => f.nitidez).sort((a, b) => a - b);
      const mediana = valores[Math.floor(valores.length / 2)] || 1;
      lista.sort((a, b) => a.hora - b.hora);
      let grupo = [], gid = 0;
      const fechar = () => {
        if (!grupo.length) return;
        const melhor = grupo.reduce((a, b) => (b.nitidez > a.nitidez ? b : a));
        grupo.forEach((f) => { f.rajada = grupo.length > 1 ? `${f.pontoId}-${gid}` : null; f.melhorDaRajada = f === melhor; });
        gid++; grupo = [];
      };
      lista.forEach((f) => {
        f.desfocada = f.nitidez < mediana * 0.35;
        const ult = grupo[grupo.length - 1];
        if (ult && f.hora - ult.hora > 1500) fechar();
        grupo.push(f);
      });
      fechar();
    });
    return fotos;
  }

  // ---------- Trajeto / tempo ----------
  function haversine(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // GPX (Strava, Garmin, relógio…) → pontos com hora local e distância acumulada.
  function lerGPX(texto) {
    const xml = new DOMParser().parseFromString(texto, 'application/xml');
    const pts = [...xml.getElementsByTagName('trkpt')].map((p) => {
      const t = p.getElementsByTagName('time')[0]?.textContent;
      const d = t ? new Date(t) : null;
      return {
        lat: +p.getAttribute('lat'), lng: +p.getAttribute('lon'),
        hora: d && !isNaN(d) ? Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()) : null,
      };
    }).filter((p) => p.hora != null && !isNaN(p.lat));
    let dist = 0;
    pts.forEach((p, i) => { if (i) dist += haversine(pts[i - 1], p); p.km = dist / 1000; });
    return pts;
  }

  // Quando o atleta passou por cada ponto de foto?
  // Retorna { pontoId: { hora, tolerancia(ms), fonte } }
  function passagens(evento, criterio) {
    const out = {};
    evento.pontos.forEach((p) => {
      if (criterio.gpx?.length) {
        const trk = criterio.gpx;
        let alvo = null;
        if (p.lat != null && p.lng != null) {
          let melhor = Infinity;
          trk.forEach((t) => { const d = haversine(t, p); if (d < melhor) { melhor = d; alvo = t; } });
          if (melhor > 150) alvo = null;
        }
        if (!alvo) {
          const km = Math.min(p.km, trk[trk.length - 1].km);
          alvo = trk.reduce((a, b) => (Math.abs(b.km - km) < Math.abs(a.km - km) ? b : a));
        }
        out[p.id] = { hora: alvo.hora, tolerancia: 45000, fonte: 'GPX' };
      } else if (criterio.largada != null && criterio.liquido) {
        const frac = Math.min(1, p.km / (evento.distanciaKm || p.km || 1));
        const decorrido = criterio.liquido * frac;
        out[p.id] = { hora: criterio.largada + decorrido, tolerancia: 45000 + decorrido * 0.03, fonte: 'ritmo' };
      }
    });
    return out;
  }

  // Classifica as fotos do evento para o atleta (número de peito + tempo).
  function buscar(evento, fotos, criterio) {
    const pass = passagens(evento, criterio);
    const ocultos = new Set(evento.ocultos || []);
    const res = [];
    fotos.forEach((f) => {
      const peitoOk = criterio.peito && f.peitos.includes(criterio.peito);
      if (f.peitos.some((n) => ocultos.has(n)) && !peitoOk) return; // privacidade: quem pediu para ocultar
      let score = 0, motivo = [];
      if (peitoOk) { score += 100; motivo.push(`nº ${criterio.peito}`); }
      const ps = pass[f.pontoId];
      if (ps) {
        const dif = Math.abs(f.hora - ps.hora);
        if (dif <= ps.tolerancia) {
          const s = 60 * (1 - dif / ps.tolerancia);
          // foto marcada só com outros números perde força (provavelmente é outra pessoa)
          score += f.peitos.length && !peitoOk ? s * 0.35 : s;
          motivo.push(`${ps.fonte} ±${Math.round(dif / 1000)}s`);
        }
      }
      if (score > 0) {
        if (f.desfocada) score -= 15;
        if (f.rajada && !f.melhorDaRajada) score -= 5;
        res.push({ foto: f, score, motivo: motivo.join(' · ') });
      }
    });
    return { resultados: res.sort((a, b) => b.score - a.score), passagens: pass };
  }

  return { carregarImagem, nitidez, miniatura, triagem, lerGPX, passagens, buscar, haversine };
})();
