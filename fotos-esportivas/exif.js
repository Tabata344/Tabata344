// Leitor mínimo de EXIF (JPEG): horário da foto (com fração de segundo) e GPS.
// Os horários do app são "hora de relógio local" guardados como ms (Date.UTC dos componentes),
// para não depender de fuso horário.
const Exif = (() => {
  function ler(buffer) {
    const v = new DataView(buffer);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off);
      const size = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) return tiff(v, off + 10);
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
      off += 2 + size;
    }
    return null;
  }

  function tiff(v, start) {
    const le = v.getUint16(start) === 0x4949;
    const u16 = (o) => v.getUint16(start + o, le);
    const u32 = (o) => v.getUint32(start + o, le);
    const ifd = (o) => {
      const tags = {};
      if (start + o + 2 > v.byteLength) return tags;
      const n = u16(o);
      for (let i = 0; i < n; i++) {
        const e = o + 2 + i * 12;
        if (start + e + 12 > v.byteLength) break;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
        const len = (sizes[type] || 1) * count;
        const dataOff = len > 4 ? u32(e + 8) : e + 8;
        tags[tag] = valor(type, count, dataOff);
      }
      return tags;
    };
    const valor = (type, count, o) => {
      try {
        if (type === 2) {
          let s = '';
          for (let i = 0; i < count; i++) { const c = v.getUint8(start + o + i); if (!c) break; s += String.fromCharCode(c); }
          return s;
        }
        if (type === 3) return count === 1 ? u16(o) : Array.from({ length: count }, (_, i) => u16(o + i * 2));
        if (type === 4) return count === 1 ? u32(o) : Array.from({ length: count }, (_, i) => u32(o + i * 4));
        if (type === 5) {
          const r = Array.from({ length: count }, (_, i) => u32(o + i * 8) / (u32(o + i * 8 + 4) || 1));
          return count === 1 ? r[0] : r;
        }
        if (type === 1 || type === 7) return v.getUint8(start + o);
      } catch { /* fora do arquivo */ }
      return null;
    };
    const ifd0 = ifd(u32(4));
    const exif = ifd0[0x8769] ? ifd(ifd0[0x8769]) : {};
    const gps = ifd0[0x8825] ? ifd(ifd0[0x8825]) : {};
    const out = { camera: [ifd0[0x010f], ifd0[0x0110]].filter(Boolean).join(' ').trim() };
    const dt = exif[0x9003] || exif[0x9004] || ifd0[0x0132];
    const m = typeof dt === 'string' && dt.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      const sub = String(exif[0x9291] || exif[0x9290] || '0').trim();
      const ms = Math.round(parseFloat('0.' + (sub.replace(/\D/g, '') || '0')) * 1000);
      out.hora = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
    }
    if (Array.isArray(gps[2]) && Array.isArray(gps[4])) {
      const dms = (a) => a[0] + a[1] / 60 + a[2] / 3600;
      out.lat = dms(gps[2]) * (gps[1] === 'S' ? -1 : 1);
      out.lng = dms(gps[4]) * (gps[3] === 'W' ? -1 : 1);
    }
    return out;
  }
  return { ler };
})();
