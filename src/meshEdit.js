import * as THREE from 'three';

// Operaciones de edición sobre BufferGeometry de triángulos. Todas devuelven geometrías
// nuevas; la original no se modifica (así se puede deshacer).

export class NoSurfaceError extends Error {
  constructor() { super('No hay superficie dentro del radio; auméntalo o toca otra zona'); this.name = 'NoSurfaceError'; }
}

/** Límite de triángulos para editar: por encima, Safari en iPhone se queda sin memoria. */
export const MAX_EDIT_TRIANGLES = 2_500_000;

export const triangleCount = (geometry) =>
  (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;

const vertexOf = (geometry, i) => (geometry.index ? geometry.index.getX(i) : i);

function assertEditable(geometry) {
  const tris = triangleCount(geometry);
  if (tris > MAX_EDIT_TRIANGLES) {
    throw new Error(`Malla demasiado grande para editar (${Math.round(tris).toLocaleString('es')} triángulos; máximo ${MAX_EDIT_TRIANGLES.toLocaleString('es')}). Reduce la calidad al exportar desde Scaniverse.`);
  }
}

function tolerance(geometry) {
  geometry.computeBoundingBox();
  const diagonal = geometry.boundingBox.getSize(new THREE.Vector3()).length();
  return Math.max(diagonal * 1e-6, 1e-9);
}

function toFloatArray(attribute) {
  const { count, itemSize: size } = attribute;
  const out = new Float32Array(count * size);
  for (let i = 0; i < count; i++) {
    out[i * size] = attribute.getX(i);
    if (size > 1) out[i * size + 1] = attribute.getY(i);
    if (size > 2) out[i * size + 2] = attribute.getZ(i);
    if (size > 3) out[i * size + 3] = attribute.getW(i);
  }
  return out;
}

/** Usa el buffer tal cual si ya es Float32 plano; solo copia cuando hace falta convertir. */
const floatArray = (attribute) =>
  attribute.array instanceof Float32Array && !attribute.isInterleavedBufferAttribute ? attribute.array : toFloatArray(attribute);

/** Identificador común para vértices que ocupan la misma posición (tabla hash sobre arrays tipados). */
function weldIds(geometry, tol) {
  const position = geometry.attributes.position;
  const P = floatArray(position);
  const n = position.count;
  const ids = new Int32Array(n);
  const q = new Int32Array(n * 3);
  let size = 2;
  while (size < n * 2) size <<= 1;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const qx = Math.round(P[i * 3] / tol) | 0, qy = Math.round(P[i * 3 + 1] / tol) | 0, qz = Math.round(P[i * 3 + 2] / tol) | 0;
    q[i * 3] = qx; q[i * 3 + 1] = qy; q[i * 3 + 2] = qz;
    let slot = (Math.imul(qx, 73856093) ^ Math.imul(qy, 19349663) ^ Math.imul(qz, 83492791)) & mask;
    for (;;) {
      const r = table[slot];
      if (r === -1) { table[slot] = i; ids[i] = count++; break; }
      if (q[r * 3] === qx && q[r * 3 + 1] === qy && q[r * 3 + 2] === qz) { ids[i] = ids[r]; break; }
      slot = (slot + 1) & mask;
    }
  }
  return { ids, count };
}

// ---------------------------------------------------------------- constructor de geometría

function makeBuilder(sizes, capacity) {
  const cap = Math.max(capacity, 3);
  return { sizes, cap, data: sizes.map((s) => new Float32Array(s * cap)), n: 0 };
}

function ensureCapacity(b) {
  if (b.n < b.cap) return;
  b.cap = Math.max(Math.ceil(b.cap * 1.5), b.cap + 3072);
  b.data = b.data.map((arr, a) => { const bigger = new Float32Array(b.cap * b.sizes[a]); bigger.set(arr); return bigger; });
}

/** Emite el vértice `v0`, o el punto a distancia t entre `v0` y `v1` si v1 >= 0. */
function emitVertex(b, srcs, v0, v1, t) {
  ensureCapacity(b);
  for (let a = 0; a < srcs.length; a++) {
    const s = b.sizes[a], src = srcs[a], dst = b.data[a];
    for (let c = 0; c < s; c++) {
      const x = src[v0 * s + c];
      dst[b.n * s + c] = v1 < 0 ? x : x + (src[v1 * s + c] - x) * t;
    }
  }
  b.n++;
}

function emitCapVertex(b, names, p, normal) {
  ensureCapacity(b);
  names.forEach((name, a) => {
    const s = b.sizes[a];
    const o = b.n * s;
    const dst = b.data[a];
    if (name === 'position') { dst[o] = p[0]; dst[o + 1] = p[1]; dst[o + 2] = p[2]; }
    else if (name === 'normal') { dst[o] = normal.x; dst[o + 1] = normal.y; dst[o + 2] = normal.z; }
    else if (name === 'color') { for (let c = 0; c < s; c++) dst[o + c] = c === 3 ? 1 : 0.8; }
  });
  b.n++;
}

/** Los arrays pueden tener algo de holgura: se exponen como vistas, sin copiar. */
function finishGeometry(b, names) {
  const geometry = new THREE.BufferGeometry();
  names.forEach((name, a) => {
    geometry.setAttribute(name, new THREE.BufferAttribute(b.data[a].subarray(0, b.n * b.sizes[a]), b.sizes[a]));
  });
  return geometry;
}

const attributeLayout = (geometry) => {
  const names = Object.keys(geometry.attributes).sort((x, y) => (x === 'position' ? -1 : 0) - (y === 'position' ? -1 : 0));
  return {
    names,
    srcs: names.map((n) => floatArray(geometry.attributes[n])),
    sizes: names.map((n) => geometry.attributes[n].itemSize),
  };
};

// ---------------------------------------------------------------- piezas sueltas y salud

/** Agrupa los triángulos en piezas conectadas. Devuelve la pieza de cada triángulo, su nº de triángulos y su superficie. */
export function findComponents(geometry) {
  assertEditable(geometry);
  const { ids, count } = weldIds(geometry, tolerance(geometry));
  const P = floatArray(geometry.attributes.position);
  const tris = triangleCount(geometry);
  const parent = new Int32Array(tris).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const owner = new Int32Array(count).fill(-1);
  for (let t = 0; t < tris; t++) {
    for (let k = 0; k < 3; k++) {
      const v = ids[vertexOf(geometry, 3 * t + k)];
      if (owner[v] === -1) owner[v] = t;
      else parent[find(t)] = find(owner[v]);
    }
  }
  const compIndex = new Map();
  const compOf = new Int32Array(tris);
  const sizes = []; // triángulos por pieza
  const areas = []; // superficie por pieza (refleja el tamaño físico)
  for (let t = 0; t < tris; t++) {
    const root = find(t);
    let c = compIndex.get(root);
    if (c === undefined) { c = sizes.length; compIndex.set(root, c); sizes.push(0); areas.push(0); }
    compOf[t] = c;
    sizes[c]++;
    const a = vertexOf(geometry, 3 * t) * 3, b = vertexOf(geometry, 3 * t + 1) * 3, d = vertexOf(geometry, 3 * t + 2) * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[d] - P[a], vy = P[d + 1] - P[a + 1], vz = P[d + 2] - P[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    areas[c] += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
  }
  return { compOf, sizes, areas };
}

/**
 * Piezas resultantes de quitar piezas enteras con filterTriangles(keep): evita recalcular la soldadura
 * y la unión de componentes (que cuesta segundos en mallas grandes) en cada borrado.
 */
export function subsetComponents(comps, keep) {
  const remap = new Map();
  const sizes = [];
  const areas = [];
  const compOf = [];
  for (let t = 0; t < comps.compOf.length; t++) {
    if (!keep(t)) continue;
    const old = comps.compOf[t];
    let c = remap.get(old);
    if (c === undefined) { c = sizes.length; remap.set(old, c); sizes.push(0); areas.push(comps.areas[old]); }
    compOf.push(c);
    sizes[c]++;
  }
  return { compOf: Int32Array.from(compOf), sizes, areas };
}

/** Bordes abiertos (agujeros) y bordes no manifold: una malla imprimible no tiene ninguno. */
export function meshHealth(geometry) {
  assertEditable(geometry);
  const { ids, count } = weldIds(geometry, tolerance(geometry));
  const tris = triangleCount(geometry);
  const keys = new Float64Array(tris * 3);
  let m = 0;
  const add = (a, b) => { if (a !== b) keys[m++] = a < b ? a * count + b : b * count + a; };
  for (let t = 0; t < tris; t++) {
    const a = ids[vertexOf(geometry, 3 * t)], b = ids[vertexOf(geometry, 3 * t + 1)], c = ids[vertexOf(geometry, 3 * t + 2)];
    add(a, b); add(b, c); add(c, a);
  }
  const sorted = keys.subarray(0, m).sort(); // un typed array se ordena numéricamente
  let open = 0, nonManifold = 0;
  for (let i = 0; i < m;) {
    let j = i + 1;
    while (j < m && sorted[j] === sorted[i]) j++;
    const uses = j - i;
    if (uses === 1) open++; else if (uses > 2) nonManifold++;
    i = j;
  }
  return { triangles: tris, open, nonManifold };
}

/** Copia solo los triángulos para los que keep(t) es verdadero. */
export function filterTriangles(geometry, keep) {
  assertEditable(geometry);
  const tris = triangleCount(geometry);
  const mask = new Uint8Array(tris);
  let kept = 0;
  for (let t = 0; t < tris; t++) if (keep(t)) { mask[t] = 1; kept++; }
  const { names, srcs, sizes } = attributeLayout(geometry);
  const b = makeBuilder(sizes, kept * 3);
  for (let t = 0; t < tris; t++) {
    if (!mask[t]) continue;
    for (let k = 0; k < 3; k++) emitVertex(b, srcs, vertexOf(geometry, 3 * t + k), -1, 0);
  }
  return finishGeometry(b, names);
}

// ---------------------------------------------------------------- corte con plano

/** Encadena los segmentos de corte en contornos cerrados. */
function buildLoops(segments, tol) {
  const keyOf = (p) => `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)},${Math.round(p[2] / tol)}`;
  const idOf = new Map();
  const points = [];
  const adjacency = [];
  const edges = [];
  const vertexId = (p) => {
    const key = keyOf(p);
    let id = idOf.get(key);
    if (id === undefined) { id = points.length; idOf.set(key, id); points.push(p); adjacency.push([]); }
    return id;
  };
  // Si el plano coincide con una arista, los dos triángulos vecinos emiten el mismo segmento: si
  // aparece dos veces es interior (a ambos lados no queda material) y se descarta; una vez, es borde.
  const pairCount = new Map();
  const raw = [];
  for (let i = 0; i < segments.length; i += 2) {
    const a = vertexId(segments[i]), c = vertexId(segments[i + 1]);
    if (a === c) continue;
    const key = a < c ? `${a}_${c}` : `${c}_${a}`;
    pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
    raw.push([a, c, key]);
  }
  for (const [a, c, key] of raw) {
    if (pairCount.get(key) !== 1) continue;
    adjacency[a].push(edges.length); adjacency[c].push(edges.length);
    edges.push([a, c]);
  }
  const ambiguous = adjacency.some((list) => list.length > 2); // contornos que se tocan en un vértice
  const used = new Uint8Array(edges.length);
  const loops = [];
  let open = 0;
  for (let e0 = 0; e0 < edges.length; e0++) {
    if (used[e0]) continue;
    used[e0] = 1;
    const start = edges[e0][0];
    let cur = edges[e0][1];
    const loop = [start];
    let closed = false;
    for (let guard = 0; guard <= edges.length; guard++) {
      if (cur === start) { closed = true; break; }
      loop.push(cur);
      const next = adjacency[cur].find((e) => !used[e]);
      if (next === undefined) break;
      used[next] = 1;
      cur = edges[next][0] === cur ? edges[next][1] : edges[next][0];
    }
    if (closed && loop.length >= 3) loops.push(loop.map((i) => points[i]));
    else open++;
  }
  return { loops, open, ambiguous };
}

function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Triangula el interior de los contornos de corte (con agujeros anidados). Devuelve triángulos de puntos 3D. */
function triangulateCaps(loops, normal) {
  const helper = Math.abs(normal.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(normal, helper).normalize();
  const v = new THREE.Vector3().crossVectors(normal, u);
  const items = loops.map((pts3) => {
    const pts2 = pts3.map((p) => new THREE.Vector2(p[0] * u.x + p[1] * u.y + p[2] * u.z, p[0] * v.x + p[1] * v.y + p[2] * v.z));
    const box = new THREE.Box2().setFromPoints(pts2);
    // punto de prueba en medio de la primera arista: no coincide con vértices de contornos vecinos
    const probe = pts2[0].clone().add(pts2[1]).multiplyScalar(0.5);
    return { pts3, pts2, box, probe, area: Math.abs(THREE.ShapeUtils.area(pts2)) };
  });
  items.forEach((it, i) => {
    it.containers = items.flatMap((o, j) => (j !== i && o.area > it.area && o.box.containsPoint(it.probe) && pointInPolygon(it.probe, o.pts2) ? [j] : []));
    it.depth = it.containers.length;
  });
  const triangles = [];
  items.forEach((outer, oi) => {
    if (outer.depth % 2 !== 0) return;
    const holes = items.filter((h) => h.depth === outer.depth + 1 && h.containers.includes(oi));
    const faces = THREE.ShapeUtils.triangulateShape(outer.pts2.slice(), holes.map((h) => h.pts2.slice()));
    const all = outer.pts3.concat(...holes.map((h) => h.pts3));
    for (const [i, j, k] of faces) triangles.push([all[i], all[j], all[k]]);
  });
  return triangles;
}

/**
 * Recorta la geometría conservando el lado donde plane.distanceToPoint >= 0 y cierra la sección
 * con una tapa. Devuelve { geometry, loops, openLoops, ambiguous }.
 */
export function clipGeometry(geometry, plane) {
  assertEditable(geometry);
  const { names, srcs, sizes } = attributeLayout(geometry);
  const P = srcs[0];
  const { x: nx, y: ny, z: nz } = plane.normal;
  const c = plane.constant;
  const tris = triangleCount(geometry);
  const dist = (vertex) => nx * P[vertex * 3] + ny * P[vertex * 3 + 1] + nz * P[vertex * 3 + 2] + c;

  // primera pasada: tamaño exacto de la salida (sin tapa) para reservar la memoria una sola vez
  let reserve = 0;
  for (let t = 0; t < tris; t++) {
    let inside = 0;
    for (let k = 0; k < 3; k++) if (dist(vertexOf(geometry, 3 * t + k)) >= 0) inside++;
    reserve += inside === 3 ? 3 : inside === 0 ? 0 : inside === 1 ? 3 : 6;
  }
  const b = makeBuilder(sizes, reserve + 3 * 4096);

  const segments = [];
  const vi = [0, 0, 0];
  const d = [0, 0, 0];
  const pos = (desc) => {
    const o = desc.a * 3;
    if (desc.b < 0) return [P[o], P[o + 1], P[o + 2]];
    const q = desc.b * 3;
    return [P[o] + (P[q] - P[o]) * desc.t, P[o + 1] + (P[q + 1] - P[o + 1]) * desc.t, P[o + 2] + (P[q + 2] - P[o + 2]) * desc.t];
  };
  const samePoint = (p, q) => p[0] === q[0] && p[1] === q[1] && p[2] === q[2];

  for (let t = 0; t < tris; t++) {
    let inside = 0;
    for (let k = 0; k < 3; k++) {
      vi[k] = vertexOf(geometry, 3 * t + k);
      d[k] = dist(vi[k]);
      if (d[k] >= 0) inside++;
    }
    if (inside === 0) continue;
    if (inside === 3) { for (let k = 0; k < 3; k++) emitVertex(b, srcs, vi[k], -1, 0); continue; }

    const poly = [];
    let exitPoint = null, enterPoint = null;
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      if (d[i] >= 0) poly.push({ a: vi[i], b: -1, t: 0 });
      if ((d[i] >= 0) !== (d[j] >= 0)) {
        const desc = { a: vi[i], b: vi[j], t: d[i] / (d[i] - d[j]) };
        poly.push(desc);
        if (d[i] >= 0) exitPoint = pos(desc); else enterPoint = pos(desc);
      }
    }
    if (exitPoint && enterPoint && !samePoint(exitPoint, enterPoint)) segments.push(exitPoint, enterPoint);
    // quita vértices duplicados consecutivos (vértice justo sobre el plano)
    const pts = poly.map(pos);
    const clean = poly.filter((_, i) => !samePoint(pts[i], pts[(i + 1) % poly.length]));
    for (let i = 1; i + 1 < clean.length; i++) {
      for (const p of [clean[0], clean[i], clean[i + 1]]) emitVertex(b, srcs, p.a, p.b, p.t);
    }
  }

  const { loops, open, ambiguous } = buildLoops(segments, tolerance(geometry));
  const outward = plane.normal.clone().negate(); // la tapa mira hacia fuera del material que se conserva
  const capTriangles = loops.length ? triangulateCaps(loops, plane.normal) : [];
  for (const [p0, p1, p2] of capTriangles) {
    const e1 = new THREE.Vector3(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    const e2 = new THREE.Vector3(p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]);
    const flip = e1.cross(e2).dot(outward) < 0;
    for (const p of flip ? [p0, p2, p1] : [p0, p1, p2]) emitCapVertex(b, names, p, outward);
  }
  return { geometry: finishGeometry(b, names), loops: loops.length, openLoops: open, ambiguous };
}

// ---------------------------------------------------------------- aplanar una zona

/**
 * Aplana las vértices a menos de `radius` de `center` (coordenadas locales de la geometría).
 * El plano pasa por el centroide de la zona con la normal media ponderada por superficie.
 * El interior (`core` de la fracción del radio) queda exactamente plano; el resto se mezcla
 * suavemente con la superficie original para no dejar un escalón.
 */
export function flattenRegion(geometry, center, radius, { core = 0.75 } = {}) {
  assertEditable(geometry);
  const position = geometry.attributes.position;
  const P = floatArray(position);
  const r2 = radius * radius;
  const near = (v) => {
    const dx = P[v * 3] - center.x, dy = P[v * 3 + 1] - center.y, dz = P[v * 3 + 2] - center.z;
    return dx * dx + dy * dy + dz * dz <= r2;
  };

  const normal = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  let weight = 0;
  const tris = triangleCount(geometry);
  for (let t = 0; t < tris; t++) {
    const a = vertexOf(geometry, 3 * t), b = vertexOf(geometry, 3 * t + 1), c = vertexOf(geometry, 3 * t + 2);
    if (!near(a) || !near(b) || !near(c)) continue;
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx; // su módulo = 2 × superficie
    const w = Math.sqrt(cx * cx + cy * cy + cz * cz);
    normal.x += cx; normal.y += cy; normal.z += cz;
    centroid.x += w * (P[a * 3] + P[b * 3] + P[c * 3]) / 3;
    centroid.y += w * (P[a * 3 + 1] + P[b * 3 + 1] + P[c * 3 + 1]) / 3;
    centroid.z += w * (P[a * 3 + 2] + P[b * 3 + 2] + P[c * 3 + 2]) / 3;
    weight += w;
  }
  if (!weight || normal.lengthSq() === 0) throw new NoSurfaceError();
  normal.normalize();
  centroid.divideScalar(weight);

  const out = geometry.clone();
  const outPosition = out.attributes.position;
  const outNormal = out.attributes.normal;
  let moved = 0;
  for (let i = 0; i < position.count; i++) {
    const dx = P[i * 3] - center.x, dy = P[i * 3 + 1] - center.y, dz = P[i * 3 + 2] - center.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) / radius;
    if (d > 1) continue;
    const s = d <= core ? 1 : (1 - d) / (1 - core);
    const w = d <= core ? 1 : s * s * (3 - 2 * s); // suavizado en el borde
    const offset = (P[i * 3] - centroid.x) * normal.x + (P[i * 3 + 1] - centroid.y) * normal.y + (P[i * 3 + 2] - centroid.z) * normal.z;
    outPosition.setXYZ(i, P[i * 3] - w * offset * normal.x, P[i * 3 + 1] - w * offset * normal.y, P[i * 3 + 2] - w * offset * normal.z);
    if (outNormal) {
      const n = new THREE.Vector3(outNormal.getX(i), outNormal.getY(i), outNormal.getZ(i)).lerp(normal, w).normalize();
      outNormal.setXYZ(i, n.x, n.y, n.z);
    }
    moved++;
  }
  return { geometry: out, moved, plane: { normal, point: centroid } };
}
