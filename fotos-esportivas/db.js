// Armazenamento local (IndexedDB): eventos, fotos (com os arquivos) e compras.
const DB = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('lance-fotos', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('eventos', { keyPath: 'id' });
        const f = db.createObjectStore('fotos', { keyPath: 'id' });
        f.createIndex('evento', 'eventoId');
        db.createObjectStore('compras', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  function wrap(req) {
    return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  }
  async function store(name, mode = 'readonly') {
    return (await open()).transaction(name, mode).objectStore(name);
  }
  return {
    async all(name) { return wrap((await store(name)).getAll()); },
    async get(name, id) { return wrap((await store(name)).get(id)); },
    async put(name, obj) { return wrap((await store(name, 'readwrite')).put(obj)); },
    async del(name, id) { return wrap((await store(name, 'readwrite')).delete(id)); },
    async fotosDoEvento(eventoId) {
      return wrap((await store('fotos')).index('evento').getAll(eventoId));
    },
    async putMany(name, list) {
      const db = await open();
      const tx = db.transaction(name, 'readwrite');
      list.forEach((o) => tx.objectStore(name).put(o));
      return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    },
    async apagarEvento(eventoId) {
      const fotos = await this.fotosDoEvento(eventoId);
      const db = await open();
      const tx = db.transaction(['fotos', 'eventos'], 'readwrite');
      fotos.forEach((f) => tx.objectStore('fotos').delete(f.id));
      tx.objectStore('eventos').delete(eventoId);
      return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    },
  };
})();

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
