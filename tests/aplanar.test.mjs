import * as THREE from 'three';
import { flattenRegion, clipGeometry, findComponents, subsetComponents, filterTriangles, meshHealth, triangleCount } from '../src/meshEdit.js';

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) failures++; };
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// Rejilla 10x10 en XY con ondulación en Z (cara que debería ser plana)
const grid = new THREE.PlaneGeometry(10, 10, 80, 80);
const gp = grid.attributes.position;
for (let i = 0; i < gp.count; i++) gp.setZ(i, 0.15 * Math.sin(gp.getX(i) * 3) * Math.cos(gp.getY(i) * 2) + 0.3);
grid.computeVertexNormals();
const before = grid.attributes.position.array.slice();

const center = V(0, 0, 0.3), radius = 3;
const { geometry: flat, moved, plane } = flattenRegion(grid, center, radius, { core: 0.75 });
const p = flat.attributes.position;

let maxCore = 0, outsideChanged = 0, coreCount = 0, blendCount = 0, worstBlend = 0;
for (let i = 0; i < p.count; i++) {
  const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
  const ox = before[i * 3], oy = before[i * 3 + 1], oz = before[i * 3 + 2];
  const d = Math.hypot(ox - center.x, oy - center.y, oz - center.z) / radius;
  const dist = Math.abs(V(x, y, z).sub(plane.point).dot(plane.normal));
  if (d <= 0.75) { coreCount++; maxCore = Math.max(maxCore, dist); }
  else if (d <= 1) { blendCount++; worstBlend = Math.max(worstBlend, Math.hypot(x - ox, y - oy, z - oz)); }
  else if (x !== ox || y !== oy || z !== oz) outsideChanged++;
}
check('núcleo perfectamente plano (desviación < 1e-5)', maxCore < 1e-5, `maxDesviación=${maxCore.toExponential(2)} en ${coreCount} vértices`);
check('fuera del radio no cambia ningún vértice', outsideChanged === 0, `cambiados=${outsideChanged}`);
check('zona de transición suave (hay vértices mezclados)', blendCount > 0 && worstBlend < 0.5, `mezclados=${blendCount}, mayor desplazamiento=${worstBlend.toFixed(3)}`);
check('normal del plano ≈ +Z', plane.normal.z > 0.99, `n=(${plane.normal.x.toFixed(3)},${plane.normal.y.toFixed(3)},${plane.normal.z.toFixed(3)})`);
check('el original no se modifica', grid.attributes.position.array.every((v, i) => v === before[i]));
const nIn = V(flat.attributes.normal.getX(0), flat.attributes.normal.getY(0), flat.attributes.normal.getZ(0));
let flatNormalOk = true;
for (let i = 0; i < p.count; i++) {
  const d = Math.hypot(before[i * 3] - center.x, before[i * 3 + 1] - center.y, before[i * 3 + 2] - center.z) / radius;
  if (d <= 0.75) { const n = V(flat.attributes.normal.getX(i), flat.attributes.normal.getY(i), flat.attributes.normal.getZ(i)); if (n.angleTo(plane.normal) > 1e-3) flatNormalOk = false; }
}
check('normales del núcleo = normal del plano', flatNormalOk);
check('mismo número de triángulos', triangleCount(flat) === triangleCount(grid));

// Zona sin superficie -> error claro
let threw = false;
try { flattenRegion(grid, V(100, 100, 100), 1); } catch (e) { threw = /No hay superficie/.test(e.message); }
check('zona vacía lanza error claro', threw);

// Malla indexada vs no indexada: mismo resultado en el núcleo (vértices duplicados se mueven igual)
const nonIdx = grid.toNonIndexed();
const f2 = flattenRegion(nonIdx, center, radius).geometry.attributes.position;
let maxDup = 0;
for (let i = 0; i < f2.count; i++) maxDup = Math.max(maxDup, Math.abs(V(f2.getX(i), f2.getY(i), f2.getZ(i)).sub(plane.point).dot(plane.normal)) * (Math.hypot(f2.getX(i) - center.x, f2.getY(i) - center.y) / radius <= 0.7 ? 1 : 0));
check('no indexada: núcleo también plano', maxDup < 1e-4, `max=${maxDup.toExponential(2)}`);

// subsetComponents coherente con findComponents tras borrar una pieza
const a = new THREE.BoxGeometry(2, 2, 2).toNonIndexed();
const b = new THREE.BoxGeometry(0.2, 0.2, 0.2).toNonIndexed(); b.translate(5, 0, 0);
const c = new THREE.BoxGeometry(0.5, 0.5, 0.5).toNonIndexed(); c.translate(-5, 0, 0);
const parts = [a, b, c];
const merged = new THREE.BufferGeometry();
for (const name of ['position', 'normal', 'uv']) {
  const total = parts.reduce((s, g) => s + g.attributes[name].array.length, 0);
  const arr = new Float32Array(total); let o = 0;
  for (const g of parts) { arr.set(g.attributes[name].array, o); o += g.attributes[name].array.length; }
  merged.setAttribute(name, new THREE.BufferAttribute(arr, a.attributes[name].itemSize));
}
const comps = findComponents(merged);
const small = comps.areas.indexOf(Math.min(...comps.areas));
const keep = (t) => comps.compOf[t] !== small;
const filtered = filterTriangles(merged, keep);
const reused = subsetComponents(comps, keep);
const recomputed = findComponents(filtered);
check('subsetComponents == findComponents tras borrar', reused.sizes.length === recomputed.sizes.length && reused.sizes.join() === recomputed.sizes.join() && reused.compOf.length === recomputed.compOf.length && reused.compOf.every((v, i) => v === recomputed.compOf[i]), `${reused.sizes} vs ${recomputed.sizes}`);

// Corte con el plano coincidiendo con una arista (caso CAD): sigue cerrado y sin contornos abiertos
const cube = new THREE.BoxGeometry(2, 2, 2);
const exact = clipGeometry(cube, new THREE.Plane(V(0, 1, 0), 1)); // el plano y=-1 coincide con la cara inferior
check('plano coincidente con la cara inferior: no rompe', triangleCount(exact.geometry) >= 12 && exact.openLoops === 0, `tris=${triangleCount(exact.geometry)} abiertos=${exact.openLoops} ambiguo=${exact.ambiguous}`);
const through = clipGeometry(cube, new THREE.Plane(V(1, 0, 0), 0));
check('corte central sigue cerrado', meshHealth(through.geometry).open === 0 && through.openLoops === 0);

console.log(failures ? `\n${failures} FALLO(S)` : '\nTODO OK');
process.exit(failures ? 1 : 0);
