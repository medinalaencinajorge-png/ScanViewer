const DB_NAME = 'scanviewer';
const STORE = 'models';

const newId = () =>
  crypto.randomUUID?.() ??
  `${Date.now().toString(36)}-${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Transacción cancelada'));
    });
  } finally {
    db.close();
  }
}

/** Guarda el modelo y devuelve solo sus metadatos (sin el blob). */
export async function saveModel({ name, ext, blob }) {
  const record = { id: newId(), name, ext, size: blob.size, created: Date.now(), blob };
  await run('readwrite', (s) => s.put(record));
  const { blob: _blob, ...meta } = record;
  return meta;
}

/** Lista solo metadatos: no materializa los blobs de los modelos. */
export async function listModels() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const out = [];
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          const { blob: _blob, ...meta } = cursor.value;
          out.push(meta);
          cursor.continue();
        } else {
          resolve(out.sort((a, b) => b.created - a.created));
        }
      };
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export const getModel = (id) => run('readonly', (s) => s.get(id));
export const deleteModel = (id) => run('readwrite', (s) => s.delete(id));
