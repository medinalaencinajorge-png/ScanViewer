import './style.css';
import { Viewer, SUPPORTED_EXTENSIONS, StaleLoadError } from './viewer.js';
import { saveModel, listModels, getModel, deleteModel } from './db.js';

const MAX_BYTES = 150 * 1024 * 1024;
const DEFAULT_TITLE = 'ScanViewer';
const $ = (id) => document.getElementById(id);

const els = {
  name: $('model-name'), file: $('file-input'), library: $('library'), list: $('library-list'),
  empty: $('library-empty'), hint: $('hint'), status: $('status'), label: $('measure-label'),
  measure: $('btn-measure'), clear: $('btn-clear'), calibrate: $('btn-calibrate'), wire: $('btn-wire'), reset: $('btn-reset'), stl: $('btn-stl'),
};

let viewer;
let current = null;       // metadatos del modelo abierto (null si no hay o no está guardado)
let rawDistance = null;   // distancia medida en unidades del modelo
let statusTimer;

const scaleKey = (id) => `scale:${id}`;

function readScale(id) {
  try {
    const value = Number(localStorage.getItem(scaleKey(id)));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch { return null; }
}

function writeScale(id, value) {
  try { localStorage.setItem(scaleKey(id), String(value)); } catch { /* almacenamiento no disponible */ }
}

function dropScale(id) {
  try { localStorage.removeItem(scaleKey(id)); } catch { /* idem */ }
}

function formatDistance(raw) {
  const scale = current ? readScale(current.id) : null;
  const meters = raw * (scale ?? 1);
  const text = meters < 1 ? `${(meters * 100).toFixed(1)} cm` : `${meters.toFixed(2)} m`;
  return scale ? text : `${text} (sin calibrar)`;
}

function showStatus(text, isError = false, ms = 3500) {
  clearTimeout(statusTimer);
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
  els.status.hidden = false;
  if (ms) statusTimer = setTimeout(() => { els.status.hidden = true; }, ms);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30)); // deja pintar "Cargando…"

function friendlyError(err, ext) {
  return ext === 'usdz'
    ? `${err.message}. USDZ solo se soporta parcialmente: exporta como GLB desde Scaniverse.`
    : err.message;
}

const cleanName = (filename) =>
  filename.replace(/\.[^.]+$/, '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim().slice(0, 100) || 'Escaneo';

function parseLength(input) {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(mm|cm|m)?\s*$/i.exec(input ?? '');
  if (!m) return null;
  const value = Number(m[1].replace(',', '.'));
  const factor = { mm: 0.001, cm: 0.01, m: 1 }[(m[2] ?? 'm').toLowerCase()];
  return value > 0 ? value * factor : null;
}

function activate(meta) {
  current = meta;
  els.name.textContent = meta?.name ?? DEFAULT_TITLE;
  els.hint.hidden = true;
  els.library.hidden = true;
  els.status.hidden = true;
  els.stl.disabled = false;
}

async function saveBlob(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function exportStl() {
  const scale = current ? readScale(current.id) : null;
  try {
    const { blob, size } = await viewer.exportStl(scale ?? 1);
    const dims = [size.x, size.y, size.z].map((v) => v.toFixed(1)).join(' × ');
    showStatus(scale ? `STL en mm: ${dims}` : `STL sin calibrar (se asume metros): ${dims} mm`, !scale, 6000);
    await saveBlob(blob, `${els.name.textContent}.stl`);
  } catch (err) {
    showStatus(`No se pudo exportar: ${err.message}`, true, 6000);
  }
}

async function openRecord(meta) {
  showStatus('Cargando…', false, 0);
  await tick();
  try {
    const record = await getModel(meta.id);
    if (!record) throw new Error('El modelo ya no existe en la biblioteca');
    await viewer.load(record.blob, record.ext);
    activate(meta);
  } catch (err) {
    if (err instanceof StaleLoadError) return;
    showStatus(`No se pudo abrir el modelo: ${friendlyError(err, meta.ext)}`, true, 7000);
  }
}

async function refreshLibrary() {
  const items = await listModels();
  els.empty.hidden = items.length > 0;
  els.list.replaceChildren(...items.map((meta) => {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.className = 'name';
    open.textContent = meta.name;
    const info = document.createElement('small');
    info.textContent = `${(meta.size / 1048576).toFixed(1)} MB · .${meta.ext}`;
    open.append(info);
    open.addEventListener('click', () => openRecord(meta));
    const del = document.createElement('button');
    del.className = 'btn';
    del.textContent = '🗑';
    del.setAttribute('aria-label', `Borrar ${meta.name}`);
    del.addEventListener('click', () => removeRecord(meta));
    li.append(open, del);
    return li;
  }));
}

async function removeRecord(meta) {
  if (!confirm(`¿Borrar "${meta.name}"?`)) return;
  try {
    await deleteModel(meta.id);
    dropScale(meta.id);
    if (current?.id === meta.id) {
      viewer.unload();
      current = null;
      els.name.textContent = DEFAULT_TITLE;
      els.hint.hidden = false;
      els.stl.disabled = true;
    }
    await refreshLibrary();
  } catch (err) {
    showStatus(`No se pudo borrar: ${err.message}`, true, 6000);
  }
}

async function handleUpload() {
  const file = els.file.files[0];
  els.file.value = '';
  if (!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) return showStatus(`Formato .${ext} no soportado`, true);
  if (file.size > MAX_BYTES) return showStatus(`El archivo supera ${MAX_BYTES / 1048576} MB`, true);

  showStatus('Cargando…', false, 0);
  await tick();
  try {
    await viewer.load(file, ext); // se valida antes de guardar nada
  } catch (err) {
    if (err instanceof StaleLoadError) return;
    return showStatus(`No se pudo abrir el archivo: ${friendlyError(err, ext)}`, true, 7000);
  }

  try {
    const meta = await saveModel({ name: cleanName(file.name), ext, blob: file });
    navigator.storage?.persist?.();
    activate(meta);
  } catch (err) {
    activate(null);
    els.name.textContent = cleanName(file.name);
    showStatus(`Se abrió, pero no se pudo guardar en la biblioteca: ${err.message}`, true, 7000);
  }
  refreshLibrary().catch((err) => showStatus(`Biblioteca no disponible: ${err.message}`, true, 6000));
}

function init() {
  try {
    viewer = new Viewer($('viewport'), els.label, {
      onMeasure(raw) {
        rawDistance = raw;
        els.clear.disabled = raw === null;
        els.calibrate.disabled = raw === null;
        if (raw !== null) viewer.setLabel(formatDistance(raw));
      },
    });
  } catch (err) {
    els.file.disabled = true;
    showStatus(`Este navegador no puede mostrar 3D (WebGL): ${err.message}`, true, 0);
    return;
  }

  els.file.addEventListener('change', handleUpload);
  $('btn-library').addEventListener('click', () => { els.library.hidden = !els.library.hidden; });

  els.measure.addEventListener('click', () => {
    const on = els.measure.getAttribute('aria-pressed') !== 'true';
    els.measure.setAttribute('aria-pressed', String(on));
    viewer.setMeasuring(on);
    if (on) showStatus('Toca dos puntos del modelo', false, 2500);
  });

  els.clear.addEventListener('click', () => viewer.clearMeasure());

  els.calibrate.addEventListener('click', () => {
    if (!current) return showStatus('Este modelo no está guardado: no se puede calibrar', true);
    if (!(rawDistance > 1e-9)) return showStatus('Mide dos puntos distintos para calibrar', true);
    const answer = prompt('Distancia real de esa medida (ej. 25 cm, 1.2 m, 300 mm):');
    if (answer === null) return; // cancelado
    const real = parseLength(answer);
    const scale = real ? real / rawDistance : NaN;
    if (!Number.isFinite(scale) || scale <= 0) return showStatus('Valor no válido', true);
    writeScale(current.id, scale);
    viewer.setLabel(formatDistance(rawDistance));
    showStatus('Escala calibrada');
  });

  els.wire.addEventListener('click', () => {
    const on = els.wire.getAttribute('aria-pressed') !== 'true';
    els.wire.setAttribute('aria-pressed', String(on));
    viewer.wireframe(on);
  });

  els.reset.addEventListener('click', () => viewer.resetView());
  els.stl.addEventListener('click', exportStl);
  if (import.meta.env.DEV) window.__viewer = viewer; // solo para depurar en desarrollo

  refreshLibrary().catch((err) => showStatus(`Biblioteca no disponible: ${err.message}`, true, 6000));
}

init();
