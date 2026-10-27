import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

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

  constructor(container, labelEl, { onMeasure } = {}) {
    this.container = container;
    this.labelEl = labelEl;
    this.onMeasure = onMeasure ?? (() => {});
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
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.6));
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
    this.#removeModel();
    this.model = object;
    this.pickables = pickables;
    this.scene.add(object);
    this.wireframe(this.wireframeOn);
    this.resetView();
  }

  unload() {
    this.#loadSeq++; // invalida cargas en curso
    this.clearMeasure();
    this.#removeModel();
    this.invalidate();
  }

  #removeModel() {
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
    if (!this.measuring || !start || !this.model) return;
    if (!e.isPrimary || e.pointerId !== start.id || e.button !== 0) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) return; // arrastre = girar cámara
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.camera.updateMatrixWorld();
    this.model.updateMatrixWorld(true);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.pickables, false)[0];
    if (hit && Number.isFinite(hit.point.x + hit.point.y + hit.point.z)) this.#addPoint(hit.point.clone());
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
