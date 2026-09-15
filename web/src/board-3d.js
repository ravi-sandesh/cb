import * as THREE from 'three';

const COLORS = {
  boardDark: 0x211812,
  boardEdge: 0x5d4037,
  center: 0xc62828,
  centerGold: 0xffd54f,
  safe: 0xfff8e1,
  light: 0xf5e6ca,
  dark: 0xe6d3b1,
  capture: 0xff5252,
  move: 0x76ff03,
  gold: 0xffd54f,
  tollu: 0xb0bec5,
  white: 0xffffff
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function cssColor(value, fallback) {
  const raw = typeof value === 'string' ? value : '';
  return /^#[0-9a-f]{6}$/i.test(raw) ? raw : fallback;
}

function makeCellTexture(key, baseColor, kind) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, 256, 256);
  gradient.addColorStop(0, baseColor);
  gradient.addColorStop(1, kind === 'center' ? '#a71d31' : '#d8c3a5');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  context.strokeStyle = 'rgba(93,64,55,0.55)';
  context.lineWidth = 12;
  context.strokeRect(4, 4, 248, 248);
  if (kind === 'safe') {
    context.strokeStyle = '#8d6e63';
    context.lineWidth = 18;
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(58, 58);
    context.lineTo(198, 198);
    context.moveTo(198, 58);
    context.lineTo(58, 198);
    context.stroke();
  }
  if (kind === 'center') {
    context.fillStyle = '#ffd54f';
    context.beginPath();
    context.arc(128, 128, 72, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#c62828';
    context.beginPath();
    context.moveTo(128, 70);
    context.lineTo(186, 128);
    context.lineTo(128, 186);
    context.lineTo(70, 128);
    context.closePath();
    context.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function makeLabelTexture(label, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, 128, 128);
  context.fillStyle = color;
  context.font = '800 72px Arial, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(label, 64, 68);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function clearGroup(group) {
  while (group.children.length) {
    const child = group.children.pop();
    child.traverse((node) => {
      if (node.userData && node.userData.disposables) {
        node.userData.disposables.forEach((material) => material.dispose());
      }
      if (node.geometry && node.geometry.userData && node.geometry.userData.shared !== true) {
        node.geometry.dispose();
      }
    });
  }
}

function sharedGeometry(geometry) {
  geometry.userData.shared = true;
  return geometry;
}

function disposePawnMesh(mesh) {
  (mesh.userData.disposables || []).forEach((material) => material.dispose());
}

class ThreeBoardRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = options;
    this.onFallback = options.onFallback || (() => {});
    this.reducedMotion = false;
    this.view = null;
    this.destroyed = false;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x12100e);
    this.scene.fog = new THREE.Fog(0x12100e, 8, 18);
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    this.lights = new THREE.Group();
    this.lights.add(new THREE.AmbientLight(0xfff3d6, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 8, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -8;
    key.shadow.camera.right = 8;
    key.shadow.camera.top = 8;
    key.shadow.camera.bottom = -8;
    this.lights.add(key);
    const rim = new THREE.PointLight(0x76ff03, 0.7, 12);
    rim.position.set(-4, 3, -4);
    this.lights.add(rim);
    this.scene.add(this.lights);

    this.boardGroup = new THREE.Group();
    this.hitGroup = new THREE.Group();
    this.pawnGroup = new THREE.Group();
    this.markerGroup = new THREE.Group();
    this.effectGroup = new THREE.Group();
    this.scene.add(this.boardGroup, this.hitGroup, this.pawnGroup, this.markerGroup, this.effectGroup);

    this.cellTextures = new Map();
    this.labelTextures = new Map();
    this.tileMaterials = new Map();
    this.pawnMaterials = new Map();
    this.markerMaterials = new Map();
    this.ringMaterials = new Map();
    this.boardBaseMaterial = new THREE.MeshStandardMaterial({ color: COLORS.boardDark, roughness: 0.88, metalness: 0.02 });
    this.edgeMaterial = new THREE.LineBasicMaterial({ color: COLORS.boardEdge });
    this.hitMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    this.cellMeshes = new Map();
    this.hitMeshes = new Map();
    this.pawnMeshes = new Map();
    this.markerMeshes = new Map();
    this.ringMeshes = new Map();
    this.capturedAnimations = new Map();
    this.homeAnimations = new Map();
    this.particles = [];
    this.animations = new Set();
    this.frameHandle = 0;
    this.lastFrameTime = 0;
    this.gridSize = 0;
    this.lastEventKey = '';
    this.contextLost = false;

    this.handleContextLost = () => {
      this.contextLost = true;
      this.onFallback('webgl-context-lost');
    };
    canvas.addEventListener('webglcontextlost', this.handleContextLost);
    this.resize(options.width || 1, options.dpr || 1);
  }

  updateEffects(view) {
    const event = view.event || {};
    const key = event.type
      ? [event.type, event.timestamp || '', Array.isArray(event.coords) ? event.coords.join(',') : '', (event.pawnIds || []).join(',')].join(':')
      : '';
    if (!key || key === this.lastEventKey) return;
    this.lastEventKey = key;
    if (!this.reducedMotion && event.type === 'victory') this.spawnVictoryParticles();
  }

  spawnVictoryParticles() {
    const center = new THREE.Vector3((this.gridSize - 1) / 2, 0.55, (this.gridSize - 1) / 2);
    const colors = [COLORS.gold, COLORS.move, COLORS.capture, COLORS.white, 0xffb74d];
    if (!this.particleGeometry) this.particleGeometry = sharedGeometry(new THREE.SphereGeometry(0.035, 6, 6));
    const now = performance.now();
    for (let index = 0; index < 72; index += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: colors[index % colors.length],
        transparent: true,
        opacity: 0.95,
        depthWrite: false
      });
      const particle = new THREE.Mesh(this.particleGeometry, material);
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.55 + Math.random() * 1.25;
      particle.position.copy(center);
      particle.userData.origin = center.clone();
      particle.userData.velocity = new THREE.Vector3(Math.cos(angle) * speed, 1.1 + Math.random() * 1.5, Math.sin(angle) * speed);
      particle.userData.birth = now;
      particle.userData.life = 1150 + Math.random() * 750;
      particle.userData.spin = (Math.random() - 0.5) * 5;
      this.effectGroup.add(particle);
      this.particles.push(particle);
    }
  }

  render(view) {
    this.view = view || {};
    this.reducedMotion = !!this.view.reducedMotion;
    this.buildBoard();
    this.updateMarkers();
    this.updatePawns();
    this.updateCursor();
    this.updateCamera();
    this.updateEffects(this.view);
    this.renderFrame();
    if (!this.reducedMotion && (this.animations.size > 0 || this.capturedAnimations.size > 0 ||
        this.homeAnimations.size > 0 || this.particles.length > 0 || this.markerGroup.children.length > 0)) {
      this.scheduleFrame();
    }
  }

  resize(width, dpr = 1) {
    if (this.destroyed) return;
    const size = Math.max(1, Number(width) || 1);
    const ratio = clamp(Number(dpr) || 1, 1, 2);
    this.canvas.width = Math.round(size * ratio);
    this.canvas.height = Math.round(size * ratio);
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(size, size, false);
    this.camera.aspect = 1;
    this.camera.updateProjectionMatrix();
    this.renderFrame(0);
  }

  getTexture(key, baseColor, kind) {
    if (!this.cellTextures.has(key)) {
      this.cellTextures.set(key, makeCellTexture(key, baseColor, kind));
    }
    return this.cellTextures.get(key);
  }

  getTileMaterial(key, baseColor, kind) {
    if (!this.tileMaterials.has(key)) {
      this.tileMaterials.set(key, new THREE.MeshStandardMaterial({
        map: this.getTexture(key, baseColor, kind),
        roughness: 0.78,
        metalness: 0.04
      }));
    }
    return this.tileMaterials.get(key);
  }

  getPawnMaterial(hex) {
    const color = cssColor(hex, '#c62828');
    if (!this.pawnMaterials.has(color)) {
      this.pawnMaterials.set(color, new THREE.MeshStandardMaterial({
        color,
        roughness: 0.34,
        metalness: 0.12,
        emissive: new THREE.Color(color).multiplyScalar(0.08)
      }));
    }
    return this.pawnMaterials.get(color);
  }

  getLabelTexture(label, color) {
    const key = `${label}:${color}`;
    if (!this.labelTextures.has(key)) {
      this.labelTextures.set(key, makeLabelTexture(label, color));
    }
    return this.labelTextures.get(key);
  }

  buildBoard() {
    const view = this.view || {};
    const gridSize = clamp(Number(view.gridSize) || 5, 5, 7);
    const span = gridSize;
    const center = (gridSize - 1) / 2;
    clearGroup(this.boardGroup);
    clearGroup(this.hitGroup);
    this.cellMeshes.clear();
    this.hitMeshes.clear();

    const base = new THREE.Mesh(
      sharedGeometry(new THREE.BoxGeometry(span + 1.15, 0.28, span + 1.15)),
      this.boardBaseMaterial
    );
    base.position.set(center, -0.2, center);
    base.receiveShadow = true;
    this.boardGroup.add(base);

    const tileGeometry = sharedGeometry(new THREE.BoxGeometry(0.94, 0.16, 0.94));
    const hitGeometry = sharedGeometry(new THREE.PlaneGeometry(0.96, 0.96));
    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        const safe = Array.isArray(view.safeCells) && view.safeCells.includes(`${row},${col}`);
        const isCenter = row === Math.floor(gridSize / 2) && col === Math.floor(gridSize / 2);
        const kind = isCenter ? 'center' : safe ? 'safe' : 'plain';
        const baseColor = isCenter ? '#c62828' : safe ? '#fff8e1' : (row + col) % 2 === 0 ? '#f5e6ca' : '#e6d3b1';
        const material = this.getTileMaterial(`${gridSize}:${kind}:${baseColor}`, baseColor, kind);
        const tile = new THREE.Mesh(tileGeometry, material);
        tile.position.set(col, -0.08, row);
        tile.receiveShadow = true;
        tile.castShadow = false;
        this.boardGroup.add(tile);
        this.cellMeshes.set(`${row},${col}`, tile);

        const hit = new THREE.Mesh(hitGeometry, this.hitMaterial);
        hit.rotation.x = -Math.PI / 2;
        hit.position.set(col, 0.03, row);
        hit.userData.coords = { row, col };
        this.hitGroup.add(hit);
        this.hitMeshes.set(`${row},${col}`, hit);
      }
    }

    const edgeGeometry = sharedGeometry(new THREE.EdgesGeometry(new THREE.BoxGeometry(span + 1.15, 0.28, span + 1.15)));
    const edge = new THREE.LineSegments(edgeGeometry, this.edgeMaterial);
    edge.position.set(center, -0.2, center);
    this.boardGroup.add(edge);
    this.gridSize = gridSize;
  }

  getMarkerMaterial(color) {
    const key = `marker:${color}`;
    if (!this.markerMaterials.has(key)) {
      this.markerMaterials.set(key, new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.95,
        depthTest: false
      }));
    }
    return this.markerMaterials.get(key);
  }

  updateMarkers() {
    clearGroup(this.markerGroup);
    this.markerMeshes.clear();
    const view = this.view || {};
    const moves = Array.isArray(view.validMoves) ? view.validMoves : [];
    moves.forEach((move, index) => {
      const target = move.targetCoords;
      if (!Array.isArray(target) || target.length < 2) return;
      const row = Number(target[0]);
      const col = Number(target[1]);
      if (!Number.isInteger(row) || !Number.isInteger(col) || !this.cellMeshes.has(`${row},${col}`)) return;
      const color = move.isCapture ? COLORS.capture : COLORS.move;
        const ring = new THREE.Mesh(
        sharedGeometry(new THREE.TorusGeometry(0.28, 0.035, 10, 40)),
        this.getMarkerMaterial(color)
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.set(col, 0.18, row);
      ring.renderOrder = 5;
      ring.userData.phase = index * 0.35;
      this.markerGroup.add(ring);
      this.markerMeshes.set(`${row},${col}`, ring);
    });
  }

  makePawnMesh(pawn, hex) {
    const group = new THREE.Group();
    const radius = 0.16;
    const bodyGeometry = sharedGeometry(new THREE.CapsuleGeometry(radius, 0.2, 5, 18));
    const body = new THREE.Mesh(bodyGeometry, this.getPawnMaterial(hex));
    body.position.y = 0.22;
    body.castShadow = true;
    body.receiveShadow = true;
    const base = new THREE.Mesh(
      sharedGeometry(new THREE.CylinderGeometry(radius * 1.18, radius * 1.32, 0.08, 24)),
      this.getPawnMaterial(hex)
    );
    base.position.y = 0.04;
    base.castShadow = true;
    const labelMaterial = new THREE.SpriteMaterial({
      map: this.getLabelTexture(String((pawn.id % 4) + 1), '#ffffff'),
      transparent: true,
      depthTest: false
    });
    const label = new THREE.Sprite(labelMaterial);
    label.scale.set(0.2, 0.2, 1);
    label.position.set(0, 0.48, 0.16);
    label.renderOrder = 8;
    group.add(base, body, label);
    group.userData.pawnId = pawn.id;
    group.userData.color = hex;
    group.userData.disposables = [labelMaterial];
    return group;
  }

  getRingMaterial(color) {
    const key = `ring:${color}`;
    if (!this.ringMaterials.has(key)) {
      this.ringMaterials.set(key, new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.95,
        depthTest: false
      }));
    }
    return this.ringMaterials.get(key);
  }

  addRing(id, color, position, dashed = false) {
    const key = `ring:${id}`;
    this.removeRing(key);
    const ring = new THREE.Mesh(
      sharedGeometry(new THREE.TorusGeometry(0.24, 0.025, 8, 40)),
      this.getRingMaterial(color)
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(position);
    ring.position.y = 0.1;
    ring.renderOrder = 6;
    if (dashed) ring.material.dashSize = 0.08;
    this.pawnGroup.add(ring);
    this.ringMeshes.set(key, ring);
  }

  removeRing(key) {
    const old = this.ringMeshes.get(key);
    if (old) {
      this.pawnGroup.remove(old);
      this.ringMeshes.delete(key);
    }
  }

  retirePawn(id, target, type) {
    const mesh = this.pawnMeshes.get(id);
    if (!mesh || this.capturedAnimations.has(id) || this.homeAnimations.has(id)) return;
    this.pawnGroup.remove(mesh);
    this.pawnMeshes.delete(id);
    this.removeRing(`ring:${id}`);
    this.removeRing(`selected:${id}`);
    mesh.visible = true;
    mesh.scale.setScalar(1);
    mesh.position.copy(target);
    mesh.position.y += type === 'home' ? 0.08 : 0.18;
    this.effectGroup.add(mesh);
    const animations = type === 'home' ? this.homeAnimations : this.capturedAnimations;
    animations.set(id, {
      mesh,
      start: performance.now(),
      duration: type === 'home' ? 520 : 430
    });
  }

  updatePawns() {
    const view = this.view || {};
    const gridSize = this.gridSize || clamp(Number(view.gridSize) || 5, 5, 7);
    const paths = Array.isArray(view.paths) ? view.paths : [];
    const colors = Array.isArray(view.playerColors) ? view.playerColors : [];
    const selected = view.selectedPawnId;
    const toughened = view.toughened || {};
    const rawPawns = Array.isArray(view.pawns) ? view.pawns : [];
    const grouped = new Map();
    rawPawns.forEach((pawn) => {
      if (!pawn || pawn.state === 'FINISHED') return;
      const playerIndex = Number(pawn.playerIndex);
      if (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex >= colors.length) return;
      const path = paths[playerIndex];
      if (!Array.isArray(path)) return;
      const index = pawn.state === 'ON_TRACK' ? Number(pawn.pathIndex) : 0;
      const coords = path[index];
      if (!Array.isArray(coords) || coords.length < 2) return;
      const key = `${coords[0]},${coords[1]}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push({ pawn, playerIndex, coords });
    });

    const activeIds = new Set();
    grouped.forEach((items, key) => {
      const [row, col] = key.split(',').map(Number);
      const count = items.length;
      items.forEach((item, index) => {
        const { pawn, playerIndex, coords } = item;
        const id = Number(pawn.id);
        if (!Number.isFinite(id)) return;
        activeIds.add(id);
        let mesh = this.pawnMeshes.get(id);
        if (!mesh) {
          mesh = this.makePawnMesh(pawn, colors[playerIndex]);
          this.pawnGroup.add(mesh);
          this.pawnMeshes.set(id, mesh);
        }
        const offset = this.stackOffset(count, index, 0.19);
        const target = new THREE.Vector3(col + offset[0], 0.12, row + offset[1]);
        if (this.reducedMotion || !mesh.userData.position) {
          mesh.position.copy(target);
        } else {
          this.animateValue(mesh.position, target, 300, 120);
        }
        mesh.userData.position = target;
        mesh.scale.setScalar(1);
        mesh.visible = true;
        const isSamePlayer = items.every((other) => other.playerIndex === playerIndex);
        const pathIndex = pawn.state === 'ON_TRACK' ? Number(pawn.pathIndex) : -1;
        const gate = Number(view.innerGates && view.innerGates[playerIndex]);
        const isToughened = isSamePlayer && count >= 2 && Array.isArray(toughened[playerIndex]) && toughened[playerIndex].includes(pathIndex);
        const isTollu = isSamePlayer && count >= 2 && !isToughened && pathIndex >= gate;
        const ringColor = isToughened ? COLORS.gold : isTollu ? COLORS.tollu : null;
        if (ringColor) this.addRing(id, ringColor, mesh.position, !isToughened);
        else this.removeRing(`ring:${id}`);
        if (selected === id) this.addRing(`selected:${id}`, COLORS.gold, mesh.position, false);
        else this.removeRing(`selected:${id}`);
      });
    });

    const event = view.event || {};
    const eventCoords = Array.isArray(event.coords) ? event.coords : null;
    const capturedIds = new Set(Array.isArray(event.pawnIds) ? event.pawnIds : []);
    const eventTarget = eventCoords && eventCoords.length >= 2
      ? new THREE.Vector3(Number(eventCoords[1]), 0.12, Number(eventCoords[0]))
      : null;
    for (const [id, mesh] of this.pawnMeshes.entries()) {
      if (activeIds.has(id)) continue;
      if (event.type === 'capture' && (capturedIds.size === 0 || capturedIds.has(id))) {
        this.retirePawn(id, eventTarget || mesh.position.clone(), 'capture');
      } else if (event.type === 'home' && (capturedIds.size === 0 || capturedIds.has(id))) {
        this.retirePawn(id, mesh.position.clone(), 'home');
      } else {
        this.pawnGroup.remove(mesh);
        this.pawnMeshes.delete(id);
        this.removeRing(`ring:${id}`);
        this.removeRing(`selected:${id}`);
        disposePawnMesh(mesh);
      }
    }
  }

  stackOffset(count, index, radius) {
    if (count <= 1) return [0, 0];
    if (count === 2) return index === 0 ? [-radius * 0.7, -radius * 0.7] : [radius * 0.7, radius * 0.7];
    if (count === 3) {
      const angle = [-Math.PI / 2, Math.PI / 6, 5 * Math.PI / 6][index];
      return [Math.cos(angle) * radius * 0.85, Math.sin(angle) * radius * 0.85];
    }
    const angle = (Math.PI * 2 * index / count) - Math.PI / 4;
    const distance = radius * (count === 4 ? 0.9 : 1);
    return [Math.cos(angle) * distance, Math.sin(angle) * distance];
  }

  updateCursor() {
    const view = this.view || {};
    const cursor = view.cursor || { row: -1, col: -1 };
    const key = 'cursor';
    this.removeRing(key);
    if (!Number.isInteger(cursor.row) || !Number.isInteger(cursor.col)) return;
    this.addRing(key, COLORS.gold, new THREE.Vector3(cursor.col, 0, cursor.row), true);
  }

  updateCamera() {
    const gridSize = this.gridSize || 5;
    const center = (gridSize - 1) / 2;
    const distance = gridSize * 1.05;
    this.camera.position.set(center + distance * 0.32, distance * 1.18, center + distance * 1.28);
    this.camera.lookAt(center, 0, center);
    this.camera.updateMatrixWorld();
  }

  animateValue(object, target, duration, delay = 0) {
    if (this.reducedMotion) {
      object.copy(target);
      return;
    }
    const start = object.clone();
    const startTime = performance.now() + delay;
    const endTime = startTime + duration;
    this.animations.delete(object.__moveAnimation);
    const animation = {
      startTime,
      endTime,
      update: (progress) => {
        object.lerpVectors(start, target, progress);
      }
    };
    object.__moveAnimation = animation;
    this.animations.add(animation);
  }

  renderFrame(time = 0) {
    if (this.destroyed) return;
    const elapsed = time || performance.now();
    for (const animation of Array.from(this.animations)) {
      if (elapsed < animation.startTime) continue;
      const progress = clamp((elapsed - animation.startTime) / Math.max(1, animation.endTime - animation.startTime), 0, 1);
      animation.update(progress);
      if (progress >= 1) this.animations.delete(animation);
    }

    const updateRetired = (animations, isHome) => {
      for (const [id, animation] of Array.from(animations)) {
        if (animation.startY === undefined) animation.startY = animation.mesh.position.y;
        const progress = clamp((elapsed - animation.start) / Math.max(1, animation.duration), 0, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        if (isHome) {
          animation.mesh.scale.setScalar(1 + eased * 0.28);
          animation.mesh.position.y = animation.startY + eased * 0.34;
        } else {
          animation.mesh.scale.setScalar(Math.max(0.02, 1 - eased * 0.92));
          animation.mesh.position.y = animation.startY + eased * 0.48;
          animation.mesh.rotation.y += 0.12;
        }
        if (progress >= 1) {
          this.effectGroup.remove(animation.mesh);
          animations.delete(id);
          disposePawnMesh(animation.mesh);
        }
      }
    };
    updateRetired(this.capturedAnimations, false);
    updateRetired(this.homeAnimations, true);

    for (let index = this.particles.length - 1; index >= 0; index -= 1) {
      const particle = this.particles[index];
      const age = Math.max(0, elapsed - particle.userData.birth);
      const progress = clamp(age / Math.max(1, particle.userData.life), 0, 1);
      if (progress >= 1) {
        this.effectGroup.remove(particle);
        particle.material.dispose();
        this.particles.splice(index, 1);
        continue;
      }
      const seconds = age / 1000;
      particle.position.set(
        particle.userData.origin.x + particle.userData.velocity.x * seconds,
        particle.userData.origin.y + particle.userData.velocity.y * seconds - 1.05 * seconds * seconds,
        particle.userData.origin.z + particle.userData.velocity.z * seconds
      );
      particle.rotation.x += particle.userData.spin * 0.016;
      particle.rotation.y += particle.userData.spin * 0.016;
      particle.scale.setScalar(1 - progress * 0.55);
      particle.material.opacity = 0.95 * (1 - progress);
    }

    this.markerGroup.children.forEach((marker, index) => {
      if (this.reducedMotion) return;
      const pulse = 1 + Math.sin((elapsed / 360) + (marker.userData.phase || index)) * 0.08;
      marker.scale.setScalar(pulse);
    });
    this.renderer.render(this.scene, this.camera);
    if (!this.reducedMotion && (this.animations.size > 0 || this.capturedAnimations.size > 0 ||
        this.homeAnimations.size > 0 || this.particles.length > 0 || this.markerGroup.children.length > 0)) {
      this.scheduleFrame();
    }
  }

  scheduleFrame() {
    if (this.destroyed || this.frameHandle) return;
    this.frameHandle = requestAnimationFrame((time) => {
      this.frameHandle = 0;
      this.renderFrame(time);
    });
  }

  hitTest(clientX, clientY) {
    if (!this.hitMeshes.size) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -(((clientY - rect.top) / rect.height) * 2 - 1);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(Array.from(this.hitMeshes.values()), false);
    if (!hits.length) return null;
    return hits[0].object.userData.coords;
  }

  destroy() {
    this.destroyed = true;
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.capturedAnimations.forEach((animation) => {
      this.effectGroup.remove(animation.mesh);
      disposePawnMesh(animation.mesh);
    });
    this.homeAnimations.forEach((animation) => {
      this.effectGroup.remove(animation.mesh);
      disposePawnMesh(animation.mesh);
    });
    this.capturedAnimations.clear();
    this.homeAnimations.clear();
    this.particles.forEach((particle) => {
      this.effectGroup.remove(particle);
      particle.material.dispose();
    });
    this.particles.length = 0;
    [this.boardGroup, this.hitGroup, this.pawnGroup, this.markerGroup, this.effectGroup].forEach(clearGroup);
    this.cellTextures.forEach((texture) => texture.dispose());
    this.labelTextures.forEach((texture) => texture.dispose());
    this.tileMaterials.forEach((material) => material.dispose());
    this.pawnMaterials.forEach((material) => material.dispose());
    this.markerMaterials.forEach((material) => material.dispose());
    this.ringMaterials.forEach((material) => material.dispose());
    this.boardBaseMaterial.dispose();
    this.edgeMaterial.dispose();
    this.hitMaterial.dispose();
    if (this.particleGeometry) this.particleGeometry.dispose();
    this.renderer.dispose();
  }
}

export function createBoardRenderer(canvas, options = {}) {
  return new ThreeBoardRenderer(canvas, options);
}

export function isWebGLAvailable() {
  try {
    const probe = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (probe.getContext('webgl2') || probe.getContext('webgl') || probe.getContext('experimental-webgl')));
  } catch {
    return false;
  }
}
