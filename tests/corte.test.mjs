import * as THREE from 'three';
import { clipGeometry, findComponents, meshHealth, filterTriangles, triangleCount } from '../src/meshEdit.js';

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) failures++; };
const volume = (g) => { // volumen con signo de una malla cerrada
  const p = g.attributes.position; let v = 0;
  for (let i = 0; i < p.count; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(p, i), b = new THREE.Vector3().fromBufferAttribute(p, i + 1), c = new THREE.Vector3().fromBufferAttribute(p, i + 2);
    v += a.dot(b.clone().cross(c)) / 6;
  }
  return v;
};
const plane = (axis, at, keepPositive = true) => {
  const n = new THREE.Vector3(); n.setComponent(axis, keepPositive ? 1 : -1);
  return new THREE.Plane(n, keepPositive ? -at : at);
};

// 1) Cubo 1x1x1 cortado por la mitad en Y: debe quedar cerrado y con volumen 0.5
const cube = new THREE.BoxGeometry(1, 1, 1);
check('cubo original cerrado', meshHealth(cube).open === 0);
const half = clipGeometry(cube, plane(1, 0));
const hh = meshHealth(half.geometry);
check('cubo cortado: 1 contorno cerrado', half.loops === 1 && half.openLoops === 0, JSON.stringify({ loops: half.loops, open: half.openLoops }));
check('cubo cortado: malla cerrada', hh.open === 0 && hh.nonManifold === 0, JSON.stringify(hh));
check('cubo cortado: volumen 0.5', Math.abs(volume(half.geometry) - 0.5) < 1e-4, `vol=${volume(half.geometry).toFixed(4)}`);

// 2) Esfera cortada al 25% por debajo: cerrada y volumen correcto (casquete)
const sphere = new THREE.SphereGeometry(1, 48, 32);
const cutSphere = clipGeometry(sphere, plane(1, -0.5));
const sh = meshHealth(cutSphere.geometry);
check('esfera cortada: cerrada', sh.open === 0 && sh.nonManifold === 0, JSON.stringify(sh));
const h = 1.5; const expected = Math.PI * h * h * (3 * 1 - h) / 3; // volumen del casquete que se conserva (y >= -0.5)
const full = (4 / 3) * Math.PI; const cap = full - Math.PI * 0.5 * 0.5 * (3 * 1 - 0.5) / 3;
check('esfera cortada: volumen aproximado', Math.abs(volume(cutSphere.geometry) - cap) / cap < 0.03, `vol=${volume(cutSphere.geometry).toFixed(3)} esperado≈${cap.toFixed(3)}`);
check('esfera cortada: caras hacia fuera (volumen positivo)', volume(cutSphere.geometry) > 0);

// 3) Conservar el otro lado
const other = clipGeometry(cube, plane(1, 0, false));
check('lado contrario: volumen 0.5 y cerrado', Math.abs(volume(other.geometry) - 0.5) < 1e-4 && meshHealth(other.geometry).open === 0);

// 4) Plano fuera del modelo: no cambia nada / lo vacía
const untouched = clipGeometry(cube, plane(1, -5));
check('plano fuera (todo dentro): mismo nº de triángulos', triangleCount(untouched.geometry) === 12, `tris=${triangleCount(untouched.geometry)}`);
const emptied = clipGeometry(cube, plane(1, 5));
check('plano fuera (todo fuera): vacío', triangleCount(emptied.geometry) === 0);

// 5) Dos piezas separadas: componentes, borrar la pequeña y limpiar
const a = new THREE.BoxGeometry(2, 2, 2).toNonIndexed();
const b = new THREE.BoxGeometry(0.2, 0.2, 0.2).toNonIndexed(); b.translate(5, 0, 0);
const merged = new THREE.BufferGeometry();
for (const name of ['position', 'normal', 'uv']) {
  const arr = new Float32Array(a.attributes[name].array.length + b.attributes[name].array.length);
  arr.set(a.attributes[name].array); arr.set(b.attributes[name].array, a.attributes[name].array.length);
  merged.setAttribute(name, new THREE.BufferAttribute(arr, a.attributes[name].itemSize));
}
const comps = findComponents(merged);
check('superficies por pieza', Math.abs(comps.areas[0] - 24) < 1e-3 && Math.abs(comps.areas[1] - 0.24) < 1e-3, JSON.stringify(comps.areas));
check('dos piezas detectadas', comps.sizes.length === 2 && comps.sizes[0] === 12 && comps.sizes[1] === 12, JSON.stringify(comps.sizes));
const big = comps.compOf[0];
const only = filterTriangles(merged, (t) => comps.compOf[t] === big);
check('borrar pieza: queda una', triangleCount(only) === 12 && findComponents(only).sizes.length === 1);

// 6) Cubo con agujero pasante (anillo): el corte debe producir tapa con agujero (2 contornos anidados)
const shape = new THREE.Shape(); shape.moveTo(-1, -1); shape.lineTo(1, -1); shape.lineTo(1, 1); shape.lineTo(-1, 1); shape.closePath();
const hole = new THREE.Path(); hole.moveTo(-0.5, -0.5); hole.lineTo(-0.5, 0.5); hole.lineTo(0.5, 0.5); hole.lineTo(0.5, -0.5); hole.closePath();
shape.holes.push(hole);
const ring = new THREE.ExtrudeGeometry(shape, { depth: 2, bevelEnabled: false }); // extruye en Z
check('anillo original cerrado', meshHealth(ring).open === 0, JSON.stringify(meshHealth(ring)));
const ringCut = clipGeometry(ring, plane(2, 1)); // corta por la mitad de la altura
const rh = meshHealth(ringCut.geometry);
const ringVol = (4 - 1) * 1; // área 3 * altura 1 conservada
check('anillo cortado: 2 contornos (exterior + agujero)', ringCut.loops === 2 && ringCut.openLoops === 0, JSON.stringify({ loops: ringCut.loops, open: ringCut.openLoops }));
check('anillo cortado: cerrado y volumen 3', rh.open === 0 && Math.abs(volume(ringCut.geometry) - ringVol) < 1e-3, `${JSON.stringify(rh)} vol=${volume(ringCut.geometry).toFixed(3)}`);

// 7) Corte inclinado
const slanted = new THREE.Plane(new THREE.Vector3(1, 1, 0).normalize(), 0);
const sl = clipGeometry(sphere, slanted);
check('corte inclinado en esfera: cerrada', meshHealth(sl.geometry).open === 0 && sl.openLoops === 0, JSON.stringify(meshHealth(sl.geometry)));

// 8) Atributos conservados
check('uv y normales presentes', !!half.geometry.attributes.uv && !!half.geometry.attributes.normal);

console.log(failures ? `\n${failures} FALLO(S)` : '\nTODO OK');
process.exit(failures ? 1 : 0);
