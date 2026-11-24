// Evento de demonstração: gera fotos sintéticas de uma corrida de 10 km (sem precisar de fotos reais)
// e um arquivo GPX de exemplo de uma atleta cujo número ficou coberto pelo casaco.
const Demo = (() => {
  const DATA = [2026, 10, 22]; // 22/11/2026 (mês começa em 0)
  const LARGADA = Date.UTC(...DATA, 7, 0, 0);
  const INICIO = { lat: -22.9870, lng: -43.1890 };
  const FIM = { lat: -22.9230, lng: -43.1700 };
  const posKm = (km) => ({ lat: INICIO.lat + ((FIM.lat - INICIO.lat) * km) / 10, lng: INICIO.lng + ((FIM.lng - INICIO.lng) * km) / 10 });

  // número, nome, atraso da largada (s), tempo líquido (s), cor, peito visível?
  const ATLETAS = [
    [207, 'Ana', 42, 3130, '#e8457a', false], // ← exemplo: peito coberto, ache pelo tempo
    [112, 'Bruno', 5, 2510, '#2f7cf6', true], [118, 'Carla', 8, 2690, '#f6a02f', true],
    [131, 'Diego', 12, 2780, '#22b07d', true], [145, 'Elis', 20, 2950, '#9b5cf6', true],
    [150, 'Fábio', 22, 3010, '#f25f3a', true], [163, 'Gabi', 30, 3090, '#14b8c4', false],
    [171, 'Hugo', 35, 3135, '#d4d43a', true], [188, 'Iara', 40, 3250, '#ff7fbf', true],
    [192, 'João', 44, 3320, '#4f6bd8', true], [215, 'Kátia', 50, 3480, '#50c85a', true],
    [224, 'Leo', 55, 3600, '#ff9050', false], [238, 'Mia', 60, 3720, '#c45cf0', true],
    [246, 'Nando', 66, 3870, '#3aa6f2', true], [259, 'Olga', 70, 4020, '#f2c53a', true],
    [263, 'Paulo', 75, 4210, '#e04646', true], [277, 'Rita', 82, 4430, '#2fd0b0', true],
    [281, 'Sérgio', 90, 4650, '#8888ff', true],
  ];

  function evento() {
    return {
      id: 'demo-orla-10k',
      nome: 'Corrida da Orla 10K (demonstração)',
      data: '2026-11-22', modalidade: 'Corrida', distanciaKm: 10, fotografo: 'Lance Demo',
      preco: 14.9, precoPacote: 39.9, relogios: {}, ocultos: [],
      pontos: [
        { id: 'p5', nome: 'Km 5 - Mirante', km: 5, ...posKm(5) },
        { id: 'p10', nome: 'Chegada', km: 10, ...posKm(10) },
      ],
      demo: true,
    };
  }

  function desenhar(a, extra, ponto, opts) {
    const W = 1200, H = 800;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    if (opts.tremida) ctx.filter = 'blur(5px)';
    const sky = ctx.createLinearGradient(0, 0, 0, H * 0.55);
    sky.addColorStop(0, ponto.km === 10 ? '#ffb46b' : '#6fb7ff');
    sky.addColorStop(1, '#e8f3ff');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#2d8a4e'; ctx.fillRect(0, H * 0.5, W, H * 0.08);
    // torcida
    for (let i = 0; i < 26; i++) {
      ctx.fillStyle = `hsl(${(i * 47) % 360} 55% 45%)`;
      ctx.beginPath(); ctx.arc(30 + i * 46, H * 0.5, 18, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#4a4f57'; ctx.fillRect(0, H * 0.58, W, H * 0.42);
    ctx.fillStyle = '#fff';
    for (let i = 0; i < 8; i++) ctx.fillRect(i * 170 + 20, H * 0.85, 90, 10);
    if (ponto.km === 10) {
      ctx.fillStyle = '#111'; ctx.fillRect(80, 60, 20, 440); ctx.fillRect(W - 100, 60, 20, 440);
      ctx.fillStyle = '#c6f432'; ctx.fillRect(80, 60, W - 160, 90);
      ctx.fillStyle = '#111'; ctx.font = '900 64px system-ui'; ctx.textAlign = 'center'; ctx.fillText('CHEGADA', W / 2, 128);
    } else {
      ctx.fillStyle = '#fff'; ctx.fillRect(60, 120, 150, 110);
      ctx.fillStyle = '#e03'; ctx.font = '900 60px system-ui'; ctx.textAlign = 'center'; ctx.fillText('5K', 135, 198);
    }
    if (extra) corredor(ctx, extra, W * 0.25 + opts.dx * 0.5, H * 0.62, 0.62);
    corredor(ctx, a, W * 0.58 + opts.dx, H * 0.95, 1);
    if (opts.tremida) ctx.filter = 'none';
    return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.86));
  }

  function corredor(ctx, a, x, yPe, s) {
    const [num, , , , cor, visivel] = a;
    ctx.save(); ctx.translate(x, yPe); ctx.scale(s, s);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#7a4a2a'; ctx.lineWidth = 34;
    ctx.beginPath(); ctx.moveTo(0, -330); ctx.lineTo(-70, -150); ctx.lineTo(-40, 0); ctx.stroke(); // perna
    ctx.beginPath(); ctx.moveTo(10, -330); ctx.lineTo(90, -180); ctx.lineTo(170, -150); ctx.stroke();
    ctx.fillStyle = cor;
    ctx.beginPath(); ctx.roundRect(-75, -620, 160, 300, 40); ctx.fill(); // tronco
    ctx.strokeStyle = cor; ctx.lineWidth = 30;
    ctx.beginPath(); ctx.moveTo(-60, -580); ctx.lineTo(-130, -470); ctx.lineTo(-90, -380); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(70, -580); ctx.lineTo(150, -500); ctx.lineTo(200, -560); ctx.stroke();
    ctx.fillStyle = '#7a4a2a'; ctx.beginPath(); ctx.arc(5, -690, 62, 0, Math.PI * 2); ctx.fill(); // cabeça
    if (visivel) {
      ctx.fillStyle = '#fff'; ctx.fillRect(-50, -540, 110, 80);
      ctx.fillStyle = '#111'; ctx.font = '900 58px system-ui'; ctx.textAlign = 'center'; ctx.fillText(String(num), 5, -478);
    } else {
      ctx.fillStyle = '#333a44'; ctx.beginPath(); ctx.roundRect(-85, -620, 180, 240, 40); ctx.fill(); // casaco
    }
    ctx.restore();
  }

  async function gerar(onProgresso) {
    const ev = evento();
    const tarefas = [];
    const passagem = (a, km) => LARGADA + (a[2] + a[3] * (km / 10)) * 1000;
    ev.pontos.forEach((p) => {
      ATLETAS.forEach((a, i) => {
        const t = passagem(a, p.km);
        const vizinho = ATLETAS.find((b) => b !== a && Math.abs(passagem(b, p.km) - t) < 25000 && passagem(b, p.km) > t);
        const n = 1 + ((i + p.km) % 3); // rajadas de 1 a 3 fotos
        for (let k = 0; k < n; k++) {
          tarefas.push({
            a, p, extra: k === 0 ? vizinho : null,
            hora: t + (k - 1) * 350 + ((i * 137) % 900),
            tremida: n > 1 && k === n - 1 && i % 2 === 0,
            dx: k * 40 - 40,
          });
        }
      });
    });
    const arquivos = [];
    for (let i = 0; i < tarefas.length; i++) {
      const t = tarefas[i];
      const blob = await desenhar(t.a, t.extra, t.p, t);
      const peitos = [t.a, t.extra].filter((x) => x && x[5]).map((x) => String(x[0]));
      // ~metade já vem marcada; o resto fica para a "marcação rápida" (ou só pelo tempo)
      const marcada = i % 2 === 0;
      arquivos.push({ blob, hora: t.hora, pontoId: t.p.id, peitos: marcada ? peitos : [], marcada, camera: 'Demo Cam' });
      onProgresso?.(i + 1, tarefas.length);
    }
    return { evento: ev, arquivos };
  }

  // GPX da Ana (nº 207, peito coberto) para testar a busca pelo relógio.
  function gpxAna() {
    const a = ATLETAS[0];
    let s = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Lance demo"><trk><name>Corrida da Orla</name><trkseg>\n';
    for (let seg = 0; seg <= a[3]; seg += 10) {
      const km = (seg / a[3]) * 10;
      const pos = posKm(km);
      const n = new Date(LARGADA + (a[2] + seg) * 1000);
      const real = new Date(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), n.getUTCHours(), n.getUTCMinutes(), n.getUTCSeconds());
      s += `<trkpt lat="${pos.lat.toFixed(6)}" lon="${pos.lng.toFixed(6)}"><time>${real.toISOString()}</time></trkpt>\n`;
    }
    return s + '</trkseg></trk></gpx>\n';
  }

  return { gerar, gpxAna, dica: 'Teste: a Ana (nº 207) correu de casaco, o número não aparece. Largada 07:00:42, tempo 0:52:10.' };
})();
