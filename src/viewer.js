import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  clipGeometry, findComponents, subsetComponents, meshHealth, filterTriangles, flattenRegion, triangleCount, NoSurfaceError,
} from './meshEdit.js';

const MAX_UNDO = 5;

const MAX_VERTICES = 20_000_000;

export class StaleLoadError extends Error {
  constructor() { super('Carga reemplazada por otra más reciente'); this.name = 'StaleLoadError'; }
}

// GLTF solo puede leer datos embebidos (blob:/data:); cualquier otra URI se rechaza.
const gltfManager = new THREE.LoadingManager();
gltfManager.setURLModifier((url) => {
  if (url.startsWith('data:') || url.startsWith('blob:')) return url;
  throw new Error('El modelo referencia archivos externos. Expórtalo como GLB autocontenido.');
});

const parseGltf = async (blob) => {
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  return (await new GLTFLoader(gltfManager).parseAsync(await blob.arrayBuffer(), '')).scene;
};

const geometryToObject = (geometry, asPoints) => {
  if (!geometry.attributes.normal && geometry.index) geometry.computeVertexNormals();
  const hasColor = Boolean(geometry.attributes.color);
  if (asPoints) return new THREE.Points(geometry, new THREE.PointsMaterial({ size: 0.01, vertexColors: hasColor }));
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: hasColor, color: hasColor ? 0xffffff : 0xcccccc, roughness: 0.8, side: THREE.DoubleSide }));
};

const PARSERS = {
  glb: parseGltf,
  gltf: parseGltf,
  async obj(blob) {
    const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
    return new OBJLoader().parse(await blob.text());
  },
  async ply(blob) {
    const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
    const geometry = new PLYLoader().parse(await blob.arrayBuffer());
    return geometryToObject(geometry, !geometry.index);
  },
  async stl(blob) {
    const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
    return geometryToObject(new STLLoader().parse(await blob.arrayBuffer()), false);
  },
  async usdz(blob) {
    const { USDZLoader } = await import('three/examples/jsm/loaders/USDZLoader.js');
    return await new USDZLoader().parse(await blob.arrayBuffer());
  },
};

export const SUPPORTED_EXTENSIONS = Object.keys(PARSERS);

function disposeObject(root) {
  root.traverse((node) => {
    node.geometry?.dispose();
    for (const material of [].concat(node.material ?? [])) {
      for (const value of Object.values(material)) {
        if (!value?.isTexture) continue;
        value.image?.close?.(); // libera el ImageBitmap de los GLB
        value.dispose();
      }
      material.dispose();
    }
  });
}

/** Devuelve las mallas/puntos con geometría real o lanza si el objeto no sirve. */
function inspect(object) {
  const pickables = [];
  let vertices = 0;
  object.traverse((n) => {
    const count = n.geometry?.attributes?.position?.count ?? 0;
    if ((n.isMesh || n.isPoints) && count > 0) { pickables.push(n); vertices += count; }
  });
  if (!pickables.length) throw new Error('El archivo no contiene geometría visible');
  if (vertices > MAX_VERTICES) throw new Error(`El modelo tiene demasiados vértices (${(vertices / 1e6).toFixed(1)} M, máximo ${MAX_VERTICES / 1e6} M)`);
  const box = new THREE.Box3().setFromObject(object);
  const diagonal = box.getSize(new THREE.Vector3()).length();
  if (box.isEmpty() || !Number.isFinite(diagonal) || diagonal <= 0) throw new Error('El modelo tiene coordenadas no válidas');
  return pickables;
}

export class Viewer {
  #loadSeq = 0;
  #dirty = true;

  constructor(container, labelEl, { onMeasure, onEdit } = {}) {
    this.container = container;
    this.labelEl = labelEl;
    this.onMeasure = onMeasure ?? (() => {});
    this.onEdit = onEdit ?? (() => {});
    this.deleteMode = false;
    this.flattenMode = false;
    this.flattenPick = null;
    this.flattenMarker = null;
    this.flattenFraction = 0.1; // radio de aplanado como fracción del radio del modelo
    this.lastPreview = null;
    this.undoStack = [];
    this.componentCache = new WeakMap();
    this.previewPlane = null;
    this.planeHelper = null;
    this.model = null;
    this.pickables = [];
    this.radius = 1;
    this.measuring = false;
    this.wireframeOn = false;
    this.points = [];
    this.overlay = new THREE.Group();
    this.pointerStart = null;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f1115);
    // Sin entorno, los materiales metálicos/PBR de los GLB se ven negros.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 0.8));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(3, 5, 4);
    this.scene.add(sun, this.overlay);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.raycaster = new THREE.Raycaster();
    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', (e) => {
      // un segundo dedo (pellizco) cancela el toque en curso
      this.pointerStart = e.isPrimary ? { x: e.clientX, y: e.clientY, id: e.pointerId } : null;
    });
    dom.addEventListener('pointerup', (e) => this.#handlePointerUp(e));
    dom.addEventListener('pointercancel', () => { this.pointerStart = null; });

    new ResizeObserver(() => this.#resize()).observe(container);
    this.#resize();
    this.renderer.setAnimationLoop(() => this.#frame());
  }

  invalidate() { this.#dirty = true; }

  async load(blob, ext) {
    const parse = PARSERS[ext];
    if (!parse) throw new Error(`Formato no soportado: .${ext}`);
    const seq = ++this.#loadSeq;
    const object = await parse(blob);
    let pickables;
    try {
      if (seq !== this.#loadSeq) throw new StaleLoadError();
      pickables = inspect(object);
    } catch (err) {
      disposeObject(object); // el modelo actual queda intacto
      throw err;
    }
    this.clearMeasure();
    this.endPreview();
    this.#clearFlattenPick();
    this.#removeModel();
    this.model = object;
    this.pickables = pickables;
    this.scene.add(object);
    this.wireframe(this.wireframeOn);
    this.resetView();
  }

  // ------------------------------------------------------------------ edición

  #emitEdit(message, error = false) {
    this.onEdit({ message, error, canUndo: this.undoStack.length > 0, canFlatten: Boolean(this.flattenPick) });
  }

  #editableMeshes() {
    if (!this.model) throw new Error('No hay ningún modelo abierto');
    const meshes = this.pickables.filter((p) => p.isMesh && triangleCount(p.geometry) > 0);
    if (!meshes.length) throw new Error('Solo se pueden editar mallas con triángulos, no nubes de puntos');
    if (meshes.some((m) => Array.isArray(m.material))) throw new Error('Este modelo usa varios materiales por malla: edición no soportada');
    if (meshes.some((m) => m.isSkinnedMesh || Object.keys(m.geometry.morphAttributes).length)) throw new Error('Este modelo tiene animación (huesos o morph targets): edición no soportada');
    return meshes;
  }

  /** Aplica geometrías nuevas guardando las antiguas para poder deshacer. */
  #commit(changes) {
    let heavy = false;
    const entry = changes.map(({ mesh, geometry }) => {
      const previous = mesh.geometry;
      previous.dispose(); // libera la copia en GPU; si se deshace, three la vuelve a subir
      mesh.geometry = geometry;
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      if (triangleCount(previous) > 1_000_000) heavy = true;
      return { mesh, geometry: previous };
    });
    this.undoStack.push(entry);
    const limit = heavy ? 1 : MAX_UNDO; // en mallas grandes, cada paso guardado cuesta cientos de MB
    while (this.undoStack.length > limit) this.#disposeEntry(this.undoStack.shift());
    this.#refreshPreview();
    this.invalidate();
  }

  #disposeEntry(entry) {
    for (const e of entry) e.geometry.dispose();
  }

  #clearUndo() {
    for (const entry of this.undoStack) this.#disposeEntry(entry);
    this.undoStack = [];
    this.onEdit({ message: '', error: false, canUndo: false, canFlatten: false });
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return;
    for (const { mesh, geometry } of entry) { mesh.geometry.dispose(); mesh.geometry = geometry; }
    this.#refreshPreview();
    this.invalidate();
    this.#emitEdit('Cambio deshecho');
  }

  #components(mesh) {
    let result = this.componentCache.get(mesh.geometry);
    if (!result) { result = findComponents(mesh.geometry); this.componentCache.set(mesh.geometry, result); }
    return result;
  }

  /** Quita piezas enteras de una malla y reutiliza las piezas ya calculadas para la geometría nueva. */
  #removePieces(mesh, comps, drop) {
    const keep = (t) => !drop(comps.compOf[t]);
    const geometry = filterTriangles(mesh.geometry, keep);
    this.componentCache.set(geometry, subsetComponents(comps, keep));
    return { mesh, geometry };
  }

  setDeleteMode(on) { this.deleteMode = on; }

  #deleteHit(hit) {
    try {
      const mesh = hit.object;
      if (!mesh.isMesh || hit.faceIndex == null) return;
      this.#editableMeshes(); // comprueba materiales múltiples, animación, etc.
      const comps = this.#components(mesh);
      if (comps.sizes.length < 2) return this.#emitEdit('Esa es la única pieza del modelo; usa el corte para recortarla', true);
      const target = comps.compOf[hit.faceIndex];
      this.#commit([this.#removePieces(mesh, comps, (c) => c === target)]);
      this.#emitEdit(`Pieza borrada (${comps.sizes[target].toLocaleString('es')} triángulos)`);
    } catch (err) {
      this.#emitEdit(`No se pudo borrar: ${err.message}`, true);
    }
  }

  /** Elimina las piezas sueltas cuya superficie es menor que `fraction` de la de la mayor de su malla. */
  cleanFragments(fraction = 0.05) {
    try {
      const changes = [];
      let removed = 0;
      for (const mesh of this.#editableMeshes()) {
        const { compOf, areas, sizes } = this.#components(mesh);
        const largest = areas.reduce((m, s) => Math.max(m, s), 0);
        const dropped = areas.map((s) => s < largest * fraction);
        const count = dropped.filter(Boolean).length;
        if (!count) continue;
        removed += count;
        changes.push(this.#removePieces(mesh, { compOf, areas, sizes }, (c) => dropped[c]));
      }
      if (!changes.length) return this.#emitEdit('No hay fragmentos pequeños que limpiar');
      this.#commit(changes);
      this.#emitEdit(`Fragmentos eliminados: ${removed}`);
    } catch (err) {
      this.#emitEdit(`No se pudo limpiar: ${err.message}`, true);
    }
  }

  /** Informa de si la malla está cerrada (imprimible) o tiene agujeros. */
  checkMesh() {
    try {
      let open = 0, nonManifold = 0, triangles = 0;
      for (const mesh of this.#editableMeshes()) {
        const h = meshHealth(mesh.geometry);
        open += h.open; nonManifold += h.nonManifold; triangles += h.triangles;
      }
      const count = triangles.toLocaleString('es');
      if (!open && !nonManifold) return this.#emitEdit(`Malla cerrada: sin agujeros ni bordes abiertos (${count} triángulos). No se comprueba la orientación de las caras; el laminador lo revisará.`);
      const problems = [open && `${open.toLocaleString('es')} bordes abiertos`, nonManifold && `${nonManifold.toLocaleString('es')} bordes no manifold`].filter(Boolean).join(' y ');
      this.#emitEdit(`Malla con ${problems}. Corta la base con un plano o deja que el laminador la repare.`, true);
    } catch (err) {
      this.#emitEdit(`No se pudo comprobar: ${err.message}`, true);
    }
  }

  #worldPlane(axis, t01, keepPositive) {
    const box = new THREE.Box3().setFromObject(this.model);
    const lo = box.min.getComponent(axis);
    const at = lo + (box.max.getComponent(axis) - lo) * t01;
    const normal = new THREE.Vector3();
    normal.setComponent(axis, keepPositive ? 1 : -1);
    return new THREE.Plane(normal, keepPositive ? -at : at);
  }

  /** Muestra en vivo (sin modificar nada) qué quedaría tras el corte. */
  previewCut(axis, t01, keepPositive) {
    if (!this.model) return;
    this.lastPreview = [axis, t01, keepPositive];
    const plane = this.#worldPlane(axis, t01, keepPositive);
    if (!this.previewPlane) this.previewPlane = new THREE.Plane();
    this.previewPlane.copy(plane);
    if (!this.planeHelper) {
      const size = new THREE.Box3().setFromObject(this.model).getSize(new THREE.Vector3()).length();
      this.planeHelper = new THREE.PlaneHelper(this.previewPlane, size, 0xffd23f);
      this.scene.add(this.planeHelper);
    }
    this.renderer.clippingPlanes = [this.previewPlane];
    this.invalidate();
  }

  /** Tras deshacer o borrar, la caja del modelo cambia: recalcula el plano y su tamaño. */
  #refreshPreview() {
    if (!this.previewPlane || !this.lastPreview) return;
    const args = this.lastPreview;
    this.#disposeHelper();
    this.previewCut(...args);
  }

  #disposeHelper() {
    if (!this.planeHelper) return;
    this.scene.remove(this.planeHelper);
    this.planeHelper.geometry.dispose();
    this.planeHelper.material.dispose();
    this.planeHelper = null;
  }

  endPreview() {
    this.lastPreview = null;
    this.renderer.clippingPlanes = [];
    this.#disposeHelper();
    this.previewPlane = null;
    this.invalidate();
  }

  /** Recorta de verdad la geometría y cierra la sección con una tapa. */
  applyCut(axis, t01, keepPositive) {
    try {
      const meshes = this.#editableMeshes();
      const world = this.#worldPlane(axis, t01, keepPositive);
      const changes = [];
      let triangles = 0, loops = 0, openLoops = 0, ambiguous = false;
      for (const mesh of meshes) {
        mesh.updateWorldMatrix(true, false);
        const local = world.clone().applyMatrix4(mesh.matrixWorld.clone().invert());
        const result = clipGeometry(mesh.geometry, local);
        triangles += triangleCount(result.geometry);
        loops += result.loops;
        openLoops += result.openLoops;
        ambiguous ||= result.ambiguous;
        changes.push({ mesh, geometry: result.geometry });
      }
      if (!triangles) {
        for (const c of changes) c.geometry.dispose();
        this.#emitEdit('El corte dejaría el modelo vacío', true);
        return false;
      }
      this.#commit(changes);
      const notes = [
        openLoops && `No se pudo cerrar ${openLoops} contorno(s): la malla original tiene agujeros.`,
        ambiguous && 'Hay contornos que se tocan: comprueba la malla.',
        !openLoops && !ambiguous && loops && 'Sección cerrada con tapa.',
      ].filter(Boolean).join(' ');
      this.#emitEdit(`Corte aplicado (${triangles.toLocaleString('es')} triángulos). ${notes}`.trim(), openLoops > 0 || ambiguous);
      return true;
    } catch (err) {
      this.#emitEdit(`No se pudo cortar: ${err.message}`, true);
      return false;
    }
  }

  // ------------------------------------------------------------------ aplanar zona

  setFlattenMode(on) {
    this.flattenMode = on;
    if (!on) this.#clearFlattenPick();
  }

  /** Radio de la zona a aplanar como fracción del radio del modelo (0.01–0.5). */
  setFlattenRadius(fraction) {
    this.flattenFraction = fraction;
    if (this.flattenMarker) this.flattenMarker.scale.setScalar(this.radius * fraction);
    this.invalidate();
  }

  #pickFlatten(hit) {
    if (!hit.object.isMesh) return this.#emitEdit('Solo se pueden aplanar mallas, no nubes de puntos', true);
    this.flattenPick = { point: hit.point.clone() };
    if (!this.flattenMarker) {
      this.flattenMarker = new THREE.Mesh(
        new THREE.SphereGeometry(1, 24, 16),
        new THREE.MeshBasicMaterial({ color: 0xffd23f, wireframe: true, transparent: true, opacity: 0.5, depthTest: false }),
      );
      this.flattenMarker.renderOrder = 997;
      this.scene.add(this.flattenMarker);
    }
    this.flattenMarker.position.copy(hit.point);
    this.flattenMarker.scale.setScalar(this.radius * this.flattenFraction);
    this.invalidate();
    this.#emitEdit('Zona elegida. Ajusta el radio con el deslizador y pulsa «Aplanar».');
  }

  #clearFlattenPick() {
    this.flattenPick = null;
    if (this.flattenMarker) {
      this.scene.remove(this.flattenMarker);
      this.flattenMarker.geometry.dispose();
      this.flattenMarker.material.dispose();
      this.flattenMarker = null;
    }
    this.onEdit({ message: '', error: false, canUndo: this.undoStack.length > 0, canFlatten: false });
    this.invalidate();
  }

  /** Aplana la zona elegida: el interior queda exactamente plano y el borde se mezcla con la superficie. */
  applyFlatten() {
    try {
      if (!this.flattenPick) { this.#emitEdit('Toca primero la zona que quieres aplanar', true); return false; }
      const meshes = this.#editableMeshes();
      const worldCenter = this.flattenPick.point;
      const worldRadius = this.radius * this.flattenFraction;
      const changes = [];
      let moved = 0;
      for (const mesh of meshes) {
        mesh.updateWorldMatrix(true, false);
        const localCenter = worldCenter.clone().applyMatrix4(mesh.matrixWorld.clone().invert());
        const localRadius = worldRadius / (mesh.matrixWorld.getMaxScaleOnAxis() || 1);
        try {
          const result = flattenRegion(mesh.geometry, localCenter, localRadius);
          moved += result.moved;
          changes.push({ mesh, geometry: result.geometry });
        } catch (err) {
          if (!(err instanceof NoSurfaceError)) throw err; // esta malla no tiene superficie en la zona
        }
      }
      if (!changes.length) { this.#emitEdit(new NoSurfaceError().message, true); return false; }
      this.#commit(changes);
      this.#clearFlattenPick();
      this.#emitEdit(`Zona aplanada (${moved.toLocaleString('es')} vértices). El centro queda plano y el borde se funde con la superficie.`);
      return true;
    } catch (err) {
      this.#emitEdit(`No se pudo aplanar: ${err.message}`, true);
      return false;
    }
  }

  /** Exporta el modelo abierto como STL binario en milímetros. `scale` convierte las unidades del modelo a metros. */
  async exportStl(scale) {
    const model = this.model;
    if (!model) throw new Error('No hay ningún modelo abierto');
    const { STLExporter } = await import('three/examples/jsm/exporters/STLExporter.js');
    if (this.model !== model) throw new Error('El modelo cambió mientras se exportaba; inténtalo de nuevo');
    const group = new THREE.Group();
    group.add(model.clone(true)); // comparte geometrías: no se libera
    group.scale.setScalar(scale * 1000);
    group.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
    const data = new STLExporter().parse(group, { binary: true });
    return { blob: new Blob([data], { type: 'model/stl' }), size };
  }

  unload() {
    this.#loadSeq++; // invalida cargas en curso
    this.clearMeasure();
    this.endPreview();
    this.#clearFlattenPick();
    this.#removeModel();
    this.invalidate();
  }

  #removeModel() {
    this.#clearUndo();
    if (!this.model) return;
    this.scene.remove(this.model);
    disposeObject(this.model);
    this.model = null;
    this.pickables = [];
  }

  resetView() {
    if (!this.model) return;
    this.model.position.set(0, 0, 0);
    const box = new THREE.Box3().setFromObject(this.model);
    this.model.position.sub(box.getCenter(new THREE.Vector3()));
    this.radius = box.getSize(new THREE.Vector3()).length() / 2;
    this.camera.near = this.radius / 100;
    this.camera.far = this.radius * 100;
    this.camera.updateProjectionMatrix();
    this.camera.position.set(this.radius * 1.2, this.radius * 0.8, this.radius * 2.2);
    this.controls.minDistance = this.radius * 0.02;
    this.controls.maxDistance = this.radius * 50;
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    this.raycaster.params.Points.threshold = this.radius * 0.01;
    for (const p of this.pickables) if (p.isPoints) p.material.size = this.radius * 0.004;
    this.invalidate();
  }

  wireframe(on) {
    this.wireframeOn = on;
    for (const mesh of this.pickables) {
      if (mesh.isMesh) for (const m of [].concat(mesh.material)) m.wireframe = on;
    }
    this.invalidate();
  }

  setMeasuring(on) {
    this.measuring = on;
    if (!on) this.clearMeasure();
  }

  clearMeasure() {
    this.points = [];
    for (const child of [...this.overlay.children]) {
      this.overlay.remove(child);
      child.geometry?.dispose();
      child.material?.dispose();
    }
    this.labelEl.hidden = true;
    this.onMeasure(null);
    this.invalidate();
  }

  setLabel(text) {
    this.labelEl.textContent = text;
    this.labelEl.hidden = this.points.length < 2;
    this.invalidate();
  }

  #handlePointerUp(e) {
    const start = this.pointerStart;
    this.pointerStart = null;
    if (!(this.measuring || this.deleteMode || this.flattenMode) || !start || !this.model) return;
    if (!e.isPrimary || e.pointerId !== start.id || e.button !== 0) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) return; // arrastre = girar cámara
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.camera.updateMatrixWorld();
    this.model.updateMatrixWorld(true);
    this.raycaster.setFromCamera(ndc, this.camera);
    // el raycaster ignora los planos de recorte: descarta lo que la previsualización ya oculta
    const hit = this.raycaster.intersectObjects(this.pickables, false)
      .find((h) => !this.previewPlane || this.previewPlane.distanceToPoint(h.point) >= 0);
    if (!hit || !Number.isFinite(hit.point.x + hit.point.y + hit.point.z)) return;
    if (this.deleteMode) this.#deleteHit(hit);
    else if (this.flattenMode) this.#pickFlatten(hit);
    else this.#addPoint(hit.point.clone());
  }

  #addPoint(point) {
    if (this.points.length === 2) this.clearMeasure();
    this.points.push(point);
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(this.radius * 0.012, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false }),
    );
    marker.position.copy(point);
    marker.renderOrder = 999;
    this.overlay.add(marker);
    if (this.points.length === 2) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(this.points),
        new THREE.LineBasicMaterial({ color: 0xffd23f, depthTest: false }),
      );
      line.renderOrder = 998;
      this.overlay.add(line);
      this.onMeasure(this.points[0].distanceTo(this.points[1]));
    }
    this.invalidate();
  }

  #resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  #frame() {
    const moved = this.controls.update();
    if (!moved && !this.#dirty) return; // escena quieta: no gastar batería
    this.#dirty = false;
    this.renderer.render(this.scene, this.camera);
    if (this.points.length === 2 && !this.labelEl.hidden) {
      const mid = this.points[0].clone().add(this.points[1]).multiplyScalar(0.5).project(this.camera);
      this.labelEl.style.visibility = mid.z < 1 ? 'visible' : 'hidden';
      this.labelEl.style.left = `${(mid.x * 0.5 + 0.5) * this.container.clientWidth}px`;
      this.labelEl.style.top = `${(-mid.y * 0.5 + 0.5) * this.container.clientHeight}px`;
    }
  }
}
