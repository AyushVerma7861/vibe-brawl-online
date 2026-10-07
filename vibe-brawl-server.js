#!/usr/bin/env node
/* ===========================================================================
   VIBER BRAWL — authoritative multiplayer server (single file)
   ---------------------------------------------------------------------------
   GENERATED FILE — do not edit by hand.
   Source of truth:
     _src/server/simhost.js     headless browser + THREE stand-ins
     _src/server/server-core.js rooms, schema, matchmaking, HTTP
   Rebuild with:  node tools/build.mjs
   ===========================================================================
   Deploy notes:
     start command : node vibe-brawl-server.js
     listens on    : $PORT  (Render sets this for you)
     health check  : GET /api/health
   =========================================================================== */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const { Schema, MapSchema, ArraySchema, defineTypes } = require('@colyseus/schema');
const { Server, Room, matchMaker } = require('colyseus');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const express = require('express');

/* ===================== PART 1/2 — HEADLESS SIMULATION HOST ===================== */
/**
 * simhost.mjs — run the game's OWN simulation headlessly inside Node.
 *
 * Why this exists
 * ---------------
 * The server and the browser must agree on the physics *exactly*. The only way
 * to guarantee that is to run literally the same source. So instead of copying
 * the physics into the server (where it would silently drift the first time
 * anyone edits the game), we read the game's own inline <script>, give it a
 * fake browser, and run it.
 *
 * The game script builds THREE.js meshes, touches the DOM, plays sounds and
 * starts a requestAnimationFrame loop. None of that can work in Node, so we
 * provide stand-ins. Every stand-in is inert: it accepts every call and returns
 * another inert object. requestAnimationFrame is a no-op, so the game's render
 * loop never starts and the simulation only advances when WE step it.
 *
 * The result: server and client run byte-identical gameplay code, and the
 * single-player game is untouched.
 */




/* ------------------------------------------------------------------ *
 * 1. The "accepts anything" stand-in
 * ------------------------------------------------------------------ */

/** Returns an object that tolerates any property access, call or `new`. */
function inert(name = 'x') {
  const target = function () {};
  return new Proxy(target, {
    get(t, p) {
      if (p === Symbol.unscopables) return undefined;
      if (p === Symbol.toPrimitive) return () => 0;
      if (p === Symbol.iterator) return function* () {};
      if (p === Symbol.asyncIterator) return undefined;
      if (p === 'then') return undefined;          // never look like a Promise
      if (p === 'toString') return () => `[inert ${name}]`;
      if (p === 'valueOf') return () => 0;
      if (p === 'length') return 0;                // keeps `for(i<len)` loops from running
      if (p === 'inspect' || p === Symbol.for('nodejs.util.inspect.custom')) {
        return () => `[inert ${name}]`;
      }
      if (!(p in t)) t[p] = inert(`${name}.${String(p)}`);
      return t[p];
    },
    set(t, p, v) { t[p] = v; return true; },
    has() { return false; },                       // `'anything' in stub` === false
    apply() { return inert(`${name}()`); },
    construct() { return inert(`new ${name}`); },
  });
}

/* ------------------------------------------------------------------ *
 * 2. Minimal real maths (physics depends on these being CORRECT)
 * ------------------------------------------------------------------ */

class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  setScalar(s) { this.x = this.y = this.z = s; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new V3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  addScalar(s) { this.x += s; this.y += s; this.z += s; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addVectors(a, b) { this.x = a.x + b.x; this.y = a.y + b.y; this.z = a.z + b.z; return this; }
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  divideScalar(s) { return s === 0 ? this.set(0, 0, 0) : this.multiplyScalar(1 / s); }
  negate() { this.x = -this.x; this.y = -this.y; this.z = -this.z; return this; }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  length() { return Math.sqrt(this.lengthSq()); }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  distanceToSquared(v) { const a = this.x - v.x, b = this.y - v.y, c = this.z - v.z; return a * a + b * b + c * c; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross(v) { const { x, y, z } = this; this.x = y * v.z - z * v.y; this.y = z * v.x - x * v.z; this.z = x * v.y - y * v.x; return this; }
  lerp(v, a) { this.x += (v.x - this.x) * a; this.y += (v.y - this.y) * a; this.z += (v.z - this.z) * a; return this; }
  applyQuaternion() { return this; }
  applyMatrix4() { return this; }
  setFromMatrixPosition() { return this; }
  equals(v) { return this.x === v.x && this.y === v.y && this.z === v.z; }
  toArray() { return [this.x, this.y, this.z]; }
  fromArray(a, o = 0) { this.x = a[o]; this.y = a[o + 1]; this.z = a[o + 2]; return this; }
  round() { this.x = Math.round(this.x); this.y = Math.round(this.y); this.z = Math.round(this.z); return this; }
}

class Euler {
  constructor(x = 0, y = 0, z = 0, order = 'XYZ') { this.x = x; this.y = y; this.z = z; this.order = order; this._onChange = null; }
  set(x, y, z, order) { this.x = x; this.y = y; this.z = z; if (order) this.order = order; return this; }
  copy(e) { this.x = e.x; this.y = e.y; this.z = e.z; this.order = e.order; return this; }
  clone() { return new Euler(this.x, this.y, this.z, this.order); }
}

class Color {
  constructor(c) { this._c = 0xffffff; if (c !== undefined) this.set(c); }
  set(c) {
    if (typeof c === 'number') this._c = c >>> 0;
    else if (c && typeof c === 'object' && typeof c._c === 'number') this._c = c._c;
    return this;
  }
  setHex(h) { this._c = h >>> 0; return this; }
  setRGB(r, g, b) { this._c = (((r * 255) & 255) << 16) | (((g * 255) & 255) << 8) | ((b * 255) & 255); return this; }
  setStyle() { return this; }
  getHex() { return this._c >>> 0; }
  getHexString() { return (this._c >>> 0).toString(16).padStart(6, '0'); }
  getStyle() { return '#' + this.getHexString(); }
  copy(c) { this._c = c._c; return this; }
  clone() { const c = new Color(); c._c = this._c; return c; }
}

class Matrix4 {
  constructor() { this.elements = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
  identity() { return this; }
  copy() { return this; }
  compose() { return this; }
  decompose() { return this; }
  multiplyMatrices() { return this; }
  clone() { return new Matrix4(); }
}

/* ------------------------------------------------------------------ *
 * 3. THREE.js stand-in — real enough that the game's build code runs
 * ------------------------------------------------------------------ */

class Object3D {
  constructor() {
    this.isObject3D = true;
    this.position = new V3();
    this.rotation = new Euler();
    this.scale = new V3(1, 1, 1);
    this.quaternion = { x: 0, y: 0, z: 0, w: 1, set() { return this; }, copy() { return this; }, setFromEuler() { return this; } };
    this.children = [];
    this.parent = null;
    this.userData = {};
    this.matrix = new Matrix4();
    this.matrixWorld = new Matrix4();
    this.visible = true;
    this.castShadow = false;
    this.receiveShadow = false;
    this.renderOrder = 0;
    this.frustumCulled = true;
    this.name = '';
    this.type = 'Object3D';
    this.layers = { mask: 1, set() {}, enable() {}, disable() {}, test() { return true; } };
  }
  add(o) { if (!o) return this; if (o.parent && o.parent.remove) o.parent.remove(o); this.children.push(o); o.parent = this; return this; }
  remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); if (o) o.parent = null; return this; }
  clear() { this.children.length = 0; return this; }
  traverse(cb) { cb(this); for (let i = 0; i < this.children.length; i++) { const c = this.children[i]; if (c && c.traverse) c.traverse(cb); } }
  traverseVisible(cb) { this.traverse(cb); }
  traverseAncestors(cb) { let p = this.parent; while (p) { cb(p); p = p.parent; } }
  getObjectByName(n) { let r = null; this.traverse(o => { if (o.name === n) r = o; }); return r; }
  getObjectById() { return null; }
  lookAt() { return this; }
  updateMatrix() {}
  updateMatrixWorld() {}
  updateWorldMatrix() {}
  getWorldPosition(v) { return (v || new V3()).copy(this.position); }
  getWorldQuaternion() { return this.quaternion; }
  localToWorld(v) { return v; }
  worldToLocal(v) { return v; }
  rotateY() { return this; }
  rotateX() { return this; }
  rotateZ() { return this; }
  translateX() { return this; }
  translateY() { return this; }
  translateZ() { return this; }
  applyMatrix4() { return this; }
  setRotationFromEuler() { return this; }
  clone() { const o = new this.constructor(); o.name = this.name; return o; }
  copy(o) { this.position.copy(o.position); this.rotation.copy(o.rotation); this.scale.copy(o.scale); return this; }
  dispose() {}
  toJSON() { return {}; }
}

class Group extends Object3D { constructor() { super(); this.type = 'Group'; this.isGroup = true; } }
class Scene extends Group {
  constructor() { super(); this.type = 'Scene'; this.isScene = true; this.background = null; this.fog = null; this.environment = null; this.overrideMaterial = null; }
}
class Mesh extends Object3D {
  constructor(geometry, material) { super(); this.type = 'Mesh'; this.isMesh = true; this.geometry = geometry || new BufferGeometry(); this.material = material || new Material(); }
}
class LineSegments extends Object3D {
  constructor(geometry, material) { super(); this.type = 'LineSegments'; this.isLineSegments = true; this.isLine = true; this.geometry = geometry || new BufferGeometry(); this.material = material || new Material(); }
}
class Points extends Object3D { constructor(g, m) { super(); this.isPoints = true; this.geometry = g; this.material = m; } }
class Sprite extends Object3D { constructor(material) { super(); this.isSprite = true; this.type = 'Sprite'; this.material = material || new Material(); this.center = new V3(0.5, 0.5, 0); } }

class Light extends Object3D {
  constructor(color, intensity) {
    super();
    this.isLight = true;
    this.color = new Color(color === undefined ? 0xffffff : color);
    this.intensity = intensity === undefined ? 1 : intensity;
  }
}
class HemisphereLight extends Light { constructor(s, g, i) { super(s, i); this.groundColor = new Color(g === undefined ? 0xffffff : g); this.isHemisphereLight = true; } }
class DirectionalLight extends Light {
  constructor(c, i) {
    super(c, i);
    this.isDirectionalLight = true;
    this.target = new Object3D();
    this.shadow = { mapSize: new V3(512, 512), camera: { left: -50, right: 50, top: 50, bottom: -50, near: 1, far: 200, updateProjectionMatrix() {} }, bias: 0, normalBias: 0, radius: 1 };
  }
}
class PointLight extends Light {
  constructor(c, i, d, dec) { super(c, i); this.isPointLight = true; this.distance = d === undefined ? 0 : d; this.decay = dec === undefined ? 2 : dec; this.shadow = { mapSize: new V3(512, 512), camera: {}, bias: 0 }; }
}
class AmbientLight extends Light { constructor(c, i) { super(c, i); this.isAmbientLight = true; } }

class Camera extends Object3D { constructor() { super(); this.isCamera = true; this.matrixWorldInverse = new Matrix4(); this.projectionMatrix = new Matrix4(); } }
class PerspectiveCamera extends Camera {
  constructor(fov = 50, aspect = 1, near = 0.1, far = 2000) {
    super();
    this.isPerspectiveCamera = true;
    this.fov = fov; this.aspect = aspect; this.near = near; this.far = far; this.zoom = 1;
  }
  updateProjectionMatrix() {}
}
class OrthographicCamera extends Camera { constructor() { super(); this.isOrthographicCamera = true; } updateProjectionMatrix() {} }

class BufferGeometry {
  constructor() { this.isBufferGeometry = true; this.attributes = {}; this.parameters = {}; this.groups = []; this.index = null; this.boundingSphere = null; this.type = 'BufferGeometry'; }
  setAttribute(k, v) { this.attributes[k] = v; return this; }
  getAttribute(k) { return this.attributes[k]; }
  setIndex(v) { this.index = v; return this; }
  computeVertexNormals() { return this; }
  computeBoundingSphere() { this.boundingSphere = { center: new V3(), radius: 1 }; return this; }
  computeBoundingBox() { return this; }
  dispose() {}
  clone() { return new BufferGeometry(); }
  translate() { return this; }
  rotateX() { return this; }
  scale() { return this; }
  center() { return this; }
}
function boxLike(type) {
  return class extends BufferGeometry {
    constructor(...a) {
      super();
      this.type = type;
      // three.js stores the ORIGINAL constructor args here; the game reads them.
      this.parameters = { width: a[0], height: a[1], depth: a[2], radius: a[0], radiusTop: a[0], radiusBottom: a[1], segments: a[2] };
    }
  };
}
const BoxGeometry = boxLike('BoxGeometry');
const PlaneGeometry = boxLike('PlaneGeometry');
const CylinderGeometry = boxLike('CylinderGeometry');
const SphereGeometry = boxLike('SphereGeometry');
const ConeGeometry = boxLike('ConeGeometry');
const TorusGeometry = boxLike('TorusGeometry');
const RingGeometry = boxLike('RingGeometry');
const OctahedronGeometry = boxLike('OctahedronGeometry');
const CircleGeometry = boxLike('CircleGeometry');

class EdgesGeometry extends BufferGeometry {
  constructor(geo, angle) { super(); this.type = 'EdgesGeometry'; this.parameters = Object.assign({}, (geo && geo.parameters) || {}); this.source = geo; this.thresholdAngle = angle; }
}

class Material {
  constructor(params) {
    this.isMaterial = true;
    this.userData = {};
    this.needsUpdate = false;
    this.visible = true;
    this.opacity = 1;
    this.transparent = false;
    this.depthWrite = true;
    this.depthTest = true;
    this.side = 0;
    this.blending = 1;
    this.colorWrite = true;
    this.alphaTest = 0;
    this.polygonOffset = false;
    this.map = null;
    this.name = '';
    this.id = 0;
    if (params) this._apply(params);
  }
  _apply(p) {
    for (const k of Object.keys(p)) {
      if (p[k] === undefined) continue;
      if (k === 'color' || k === 'emissive' || k === 'specular') this[k] = new Color(p[k]);
      else this[k] = p[k];
    }
  }
  clone() { const m = new this.constructor(); for (const k of Object.keys(this)) m[k] = (this[k] && this[k].clone) ? this[k].clone() : this[k]; m.userData = Object.assign({}, this.userData); return m; }
  copy(m) { for (const k of Object.keys(m)) this[k] = m[k]; return this; }
  dispose() {}
}
class MeshLambertMaterial extends Material { constructor(p) { super(p); this.type = 'MeshLambertMaterial'; if (!this.emissive) this.emissive = undefined; } }
class MeshBasicMaterial extends Material { constructor(p) { super(p); this.type = 'MeshBasicMaterial'; } }
class MeshStandardMaterial extends Material { constructor(p) { super(p); this.type = 'MeshStandardMaterial'; this.emissive = new Color(p && p.emissive !== undefined ? p.emissive : 0x000000); this.roughness = 1; this.metalness = 0; } }
class MeshPhongMaterial extends Material { constructor(p) { super(p); this.type = 'MeshPhongMaterial'; this.emissive = new Color(p && p.emissive !== undefined ? p.emissive : 0x000000); } }
class LineBasicMaterial extends Material { constructor(p) { super(p); this.type = 'LineBasicMaterial'; } }
class LineDashedMaterial extends LineBasicMaterial { constructor(p) { super(p); this.type = 'LineDashedMaterial'; } }
class SpriteMaterial extends Material { constructor(p) { super(p); this.type = 'SpriteMaterial'; } }
class PointsMaterial extends Material { constructor(p) { super(p); this.type = 'PointsMaterial'; } }

class Texture {
  constructor() { this.isTexture = true; this.userData = {}; this.image = {}; this.repeat = { set() {}, x: 1, y: 1 }; this.offset = { set() {}, x: 0, y: 0 }; this.wrapS = 1000; this.wrapT = 1000; this.magFilter = 1006; this.minFilter = 1006; this.encoding = 3000; this.needsUpdate = false; this.generateMipmaps = true; this.anisotropy = 1; }
  dispose() {}
  clone() { return new Texture(); }
}
class CanvasTexture extends Texture { constructor(canvas) { super(); this.isCanvasTexture = true; this.image = canvas || {}; } }
class DataTexture extends Texture {}
class TextureLoader {
  constructor() { this.crossOrigin = ''; this.path = ''; }
  load(url, onLoad) { const t = new Texture(); t.sourceFile = url; if (typeof onLoad === 'function') { /* never fires — no network in Node */ } return t; }
  setCrossOrigin() { return this; }
  setPath() { return this; }
}
class Fog { constructor(color, near, far) { this.isFog = true; this.color = new Color(color); this.near = near; this.far = far; this.name = ''; } }
class FogExp2 { constructor(color, density) { this.isFogExp2 = true; this.color = new Color(color); this.density = density; } }
class Raycaster {
  constructor() { this.ray = { origin: new V3(), direction: new V3() }; this.near = 0; this.far = Infinity; this.params = {}; this.layers = { set() {}, test() { return true; } }; }
  set() { return this; }
  setFromCamera() { return this; }
  intersectObject() { return []; }
  intersectObjects() { return []; }
}
class Clock {
  constructor() { this.startTime = 0; this.oldTime = 0; this.elapsedTime = 0; this.running = false; }
  start() { return this; } stop() { return this; } getDelta() { return 0; } getElapsedTime() { return 0; }
}

class WebGLRenderer {
  constructor(params) {
    this.isWebGLRenderer = true;
    this.domElement = (params && params.canvas) || makeElement('canvas');
    this.shadowMap = { enabled: false, type: 0, autoUpdate: true, needsUpdate: false };
    this.info = { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 }, programs: [], autoReset: true };
    this.capabilities = { isWebGL2: true, maxTextureSize: 4096, getMaxAnisotropy() { return 1; } };
    this.properties = { get() { return {}; } };
    this.state = { buffers: {} };
    this.outputEncoding = 3000;
    this.toneMapping = 0;
    this.toneMappingExposure = 1;
    this.physicallyCorrectLights = false;
    this.autoClear = true;
    this.setPixelRatio = () => this;
    this.setSize = () => this;
    this.setClearColor = () => this;
    this.setClearAlpha = () => this;
    this.setScissorTest = () => this;
    this.setViewport = () => this;
    this.getPixelRatio = () => 1;
    this.getSize = (v) => { if (v && v.set) v.set(1280, 720); return v; };
    this.getContext = () => inert('gl');
    this.render = () => {};
    this.clear = () => {};
    this.clearDepth = () => {};
    this.compile = () => {};
    this.dispose = () => {};
    this.forceContextLoss = () => {};
    this.setAnimationLoop = () => {};
    this.readRenderTargetPixels = () => {};
    this.setRenderTarget = () => {};
    this.getRenderTarget = () => null;
  }
}

const MathUtils = {
  clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
  lerp: (a, b, t) => a + (b - a) * t,
  degToRad: (d) => d * Math.PI / 180,
  radToDeg: (r) => r * 180 / Math.PI,
  randFloat: (a, b) => a + Math.random() * (b - a),
  randFloatSpread: (r) => r * (0.5 - Math.random()),
  randInt: (a, b) => Math.floor(a + Math.random() * (b - a + 1)),
  smoothstep: (x, a, b) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); },
  euclideanModulo: (n, m) => ((n % m) + m) % m,
  generateUUID: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }),
};

const THREE = {
  Vector2: class { constructor(x = 0, y = 0) { this.x = x; this.y = y; } set(x, y) { this.x = x; this.y = y; return this; } },
  Vector3: V3,
  Vector4: class { constructor(x = 0, y = 0, z = 0, w = 0) { Object.assign(this, { x, y, z, w }); } },
  Euler,
  Quaternion: class { constructor() { Object.assign(this, { x: 0, y: 0, z: 0, w: 1 }); } set() { return this; } setFromEuler() { return this; } },
  Matrix3: Matrix4,
  Matrix4,
  Color,
  MathUtils,
  Object3D, Group, Scene, Mesh, LineSegments, Points, Sprite,
  Light, HemisphereLight, DirectionalLight, PointLight, AmbientLight,
  Camera, PerspectiveCamera, OrthographicCamera,
  BufferGeometry, BoxGeometry, PlaneGeometry, CylinderGeometry, SphereGeometry,
  ConeGeometry, TorusGeometry, RingGeometry, OctahedronGeometry, CircleGeometry,
  EdgesGeometry, BufferAttribute: class { constructor(a, i) { this.array = a; this.itemSize = i; } },
  Float32BufferAttribute: class { constructor(a, i) { this.array = a; this.itemSize = i; } },
  Material, MeshLambertMaterial, MeshBasicMaterial, MeshStandardMaterial,
  MeshPhongMaterial, LineBasicMaterial, LineDashedMaterial, SpriteMaterial, PointsMaterial,
  Texture, CanvasTexture, DataTexture, TextureLoader, Fog, FogExp2,
  Raycaster, Clock, WebGLRenderer,
  // constants
  FrontSide: 0, BackSide: 1, DoubleSide: 2,
  NoBlending: 0, NormalBlending: 1, AdditiveBlending: 2, SubtractiveBlending: 3, MultiplyBlending: 4,
  NearestFilter: 1003, LinearFilter: 1006, NearestMipMapNearestFilter: 1004, LinearMipMapLinearFilter: 1008,
  RepeatWrapping: 1000, ClampToEdgeWrapping: 1001, MirroredRepeatWrapping: 1002,
  RGBAFormat: 1023, RGBFormat: 1022, LuminanceFormat: 1024, AlphaFormat: 1025,
  UnsignedByteType: 1009, FloatType: 1015,
  BasicShadowMap: 0, PCFShadowMap: 1, PCFSoftShadowMap: 2, VSMShadowMap: 3,
  LinearEncoding: 3000, sRGBEncoding: 3001, GammaEncoding: 3007,
  NoToneMapping: 0, ACESFilmicToneMapping: 4,
  ZeroSlopeFlat: 0, ZeroCurvatureEnding: 0,
  LineBasicMaterial_never: undefined,
};

/* ------------------------------------------------------------------ *
 * 4. Fake DOM
 * ------------------------------------------------------------------ */

function makeContext2d() {
  const grad = { addColorStop() {} };
  return {
    canvas: null,
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, font: '', textAlign: '', textBaseline: '',
    shadowBlur: 0, shadowColor: '', globalCompositeOperation: 'source-over', lineCap: '', lineJoin: '',
    createRadialGradient: () => grad, createLinearGradient: () => grad, createPattern: () => null,
    fillRect() {}, strokeRect() {}, clearRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    arc() {}, arcTo() {}, ellipse() {}, rect() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    fill() {}, stroke() {}, clip() {}, fillText() {}, strokeText() {}, drawImage() {},
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, setTransform() {}, transform() {},
    setLineDash() {}, getLineDash: () => [], createImageData: () => ({ data: new Uint8ClampedArray(4) }),
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    putImageData() {}, measureText: () => ({ width: 0 }), isPointInPath: () => false,
  };
}

function makeStyle() {
  const props = {};
  const style = {
    cssText: '', length: 0,
    setProperty(k, v) { props[k] = v; },
    removeProperty(k) { delete props[k]; },
    getPropertyValue(k) { return props[k] === undefined ? '' : props[k]; },
    item(i) { return Object.keys(props)[i] || ''; },
  };
  // Any `style.display = 'none'` style assignment lands on the object itself.
  return new Proxy(style, {
    get(t, p) { if (p in t) return t[p]; return props[p] === undefined ? '' : props[p]; },
    set(t, p, v) { if (p in t) { t[p] = v; } else { props[p] = v; } return true; },
  });
}

const _elCache = new Map();
function makeElement(tag = 'div', id = '') {
  const key = tag + '#' + id;
  if (_elCache.has(key)) return _elCache.get(key);
  const el = {
    nodeType: 1, tagName: String(tag).toUpperCase(), id, className: '', name: '',
    style: makeStyle(), dataset: {}, attributes: {},
    children: [], childNodes: [], parentNode: null, firstChild: null, lastChild: null,
    nextSibling: null, previousSibling: null, ownerDocument: null,
    innerHTML: '', outerHTML: '', textContent: '', innerText: '', value: '', checked: false, disabled: false,
    width: 1280, height: 720, naturalWidth: 0, naturalHeight: 0, complete: true, src: '', href: '', title: '', alt: '',
    offsetWidth: 1280, offsetHeight: 720, clientWidth: 1280, clientHeight: 720, scrollWidth: 1280, scrollHeight: 720,
    scrollTop: 0, scrollLeft: 0,
    classList: { _s: new Set(), add() {}, remove() {}, toggle() { return false; }, contains() { return false; }, item() { return null; }, length: 0 },
    appendChild(c) { this.children.push(c); if (c) { c.parentNode = this; this.lastChild = c; } return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    replaceChild(c) { return c; },
    append() {}, prepend() {}, remove() {}, before() {}, after() {},
    cloneNode() { return makeElement(tag, id + '_clone'); },
    contains() { return false; },
    setAttribute(k, v) { this.attributes[k] = v; }, getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; },
    removeAttribute(k) { delete this.attributes[k]; }, hasAttribute(k) { return k in this.attributes; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    querySelector() { return makeElement('div'); }, querySelectorAll() { return []; },
    getElementsByTagName() { return []; }, getElementsByClassName() { return []; },
    closest() { return null; }, matches() { return false; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720, x: 0, y: 0 }; },
    getContext() { return makeContext2d(); },
    toDataURL() { return 'data:image/png;base64,'; },
    toBlob(cb) { if (typeof cb === 'function') cb(null); },
    focus() {}, blur() {}, click() {}, scrollIntoView() {}, animate() { return { cancel() {}, finished: Promise.resolve() }; },
    setPointerCapture() {}, releasePointerCapture() {}, requestFullscreen() { return Promise.resolve(); },
    getRootNode() { return documentStub; },
  };
  _elCache.set(key, el);
  return el;
}

let documentStub;
function makeDocument() {
  const doc = {
    nodeType: 9, title: 'VIBER BRAWL', hidden: false, visibilityState: 'visible', readyState: 'complete',
    body: makeElement('body', 'body'),
    documentElement: makeElement('html', 'html'),
    head: makeElement('head', 'head'),
    fonts: { ready: Promise.resolve(), load: () => Promise.resolve(), add() {}, check: () => true },
    fullscreenElement: null, fullscreenEnabled: true, pointerLockElement: null,
    getElementById(id) { return makeElement('div', id); },
    querySelector(sel) { return makeElement('div', 'sel:' + sel); },
    querySelectorAll() { return []; },
    getElementsByTagName() { return []; },
    getElementsByClassName() { return []; },
    createElement(tag) { return makeElement(tag); },
    createElementNS() { return makeElement('div'); },
    createTextNode(t) { return { nodeType: 3, textContent: t }; },
    createDocumentFragment() { return makeElement('fragment'); },
    createEvent() { return { initEvent() {}, preventDefault() {} }; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    exitFullscreen() { return Promise.resolve(); }, requestFullscreen() { return Promise.resolve(); },
    elementFromPoint() { return null; }, hasFocus: () => true,
  };
  documentStub = doc;
  return doc;
}

function makeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear(), key: (i) => [...m.keys()][i] || null, get length() { return m.size; } };
}

function makeWindow(doc) {
  const listeners = new Map();
  const win = {
    document: doc,
    innerWidth: 1280, innerHeight: 720, outerWidth: 1280, outerHeight: 720,
    devicePixelRatio: 1, pageXOffset: 0, pageYOffset: 0, scrollX: 0, scrollY: 0,
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, orientation: { type: 'landscape-primary', angle: 0, addEventListener() {}, lock: () => Promise.resolve(), unlock() {} } },
    navigator: {
      userAgent: 'Mozilla/5.0 (Node headless sim host)', platform: 'Node', language: 'en-US', languages: ['en-US'],
      maxTouchPoints: 0, onLine: true, standalone: false, cookieEnabled: false, hardwareConcurrency: 4, deviceMemory: 8,
      vibrate: () => true, clipboard: { writeText: () => Promise.resolve() },
      mediaDevices: { getUserMedia: () => Promise.reject(new Error('no media in Node')) },
    },
    location: { href: 'http://localhost/', protocol: 'http:', host: 'localhost', hostname: 'localhost', port: '', pathname: '/', search: '', hash: '', origin: 'http://localhost', reload() {}, assign() {} },
    history: { pushState() {}, replaceState() {}, back() {}, forward() {}, go() {} },
    localStorage: makeStorage(), sessionStorage: makeStorage(),
    visualViewport: { width: 1280, height: 720, offsetLeft: 0, offsetTop: 0, scale: 1, addEventListener() {}, removeEventListener() {} },
    // NOTE: deliberately NOT providing AudioContext, so SFX.init() bails out and
    // every sound call becomes a no-op. The server must never make noise.
    AudioContext: undefined, webkitAudioContext: undefined,
    matchMedia: (q) => ({ matches: false, media: String(q), onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; } }),
    requestAnimationFrame: () => 0,      // <- the render loop never starts
    cancelAnimationFrame: () => {},
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestIdleCallback: () => 0, cancelIdleCallback: () => {},
    queueMicrotask: (f) => { try { f(); } catch (e) { /* ignore */ } },
    getComputedStyle: () => ({ getPropertyValue: () => '', transform: 'none', opacity: '1', display: 'block', width: '0px', height: '0px' }),
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    removeEventListener(type, fn) { const a = listeners.get(type); if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } },
    dispatchEvent() { return true; },
    open: () => null, close() {}, focus() {}, blur() {}, scrollTo() {}, print() {},
    alert() {}, confirm: () => false, prompt: () => null,
    Image: class { constructor() { this.width = 0; this.height = 0; this.complete = false; this.onload = null; this.onerror = null; this.src = ''; } addEventListener() {} },
    ResizeObserver: class { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class { constructor() {} observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { constructor() {} observe() {} disconnect() {} takeRecords() { return []; } },
    Audio: class { constructor() { this.play = () => Promise.resolve(); this.pause = () => {}; this.currentTime = 0; this.volume = 1; this.loop = false; } addEventListener() {} },
    DOMParser: class { parseFromString() { return { querySelector: () => null, querySelectorAll: () => [] }; } },
    performance: { now: () => Date.now(), timeOrigin: 0, mark() {}, measure() {}, getEntriesByName: () => [], memory: { usedJSHeapSize: 0 } },
    console,
    Math, JSON, Object, Array, Number, String, Boolean, Date, Error, TypeError, RangeError, Map, Set, WeakMap, WeakSet,
    Symbol, Promise, Proxy, Reflect, RegExp, Function, BigInt,
    isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    Infinity, NaN, undefined, globalThis: null,
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, ArrayBuffer, DataView,
  };
  win.window = win;
  win.self = win;
  win.top = win;
  win.parent = win;
  win.frames = win;
  win.globalThis = win;
  return win;
}

/* ------------------------------------------------------------------ *
 * 5. Static global scan (belt and braces)
 * ------------------------------------------------------------------ */

const JS_BUILTINS = new Set([
  'Math', 'JSON', 'Object', 'Array', 'Number', 'String', 'Boolean', 'Date', 'Error', 'TypeError', 'RangeError',
  'ReferenceError', 'SyntaxError', 'EvalError', 'URIError', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Promise',
  'Proxy', 'Reflect', 'RegExp', 'Function', 'BigInt', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'NaN',
  'Infinity', 'undefined', 'null', 'true', 'false', 'this', 'new', 'typeof', 'instanceof', 'in', 'of', 'delete',
  'void', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'function', 'class',
  'const', 'let', 'var', 'try', 'catch', 'finally', 'throw', 'yield', 'await', 'async', 'static', 'get', 'set',
  'extends', 'super', 'import', 'export', 'default', 'from', 'as', 'with', 'debugger', 'arguments', 'eval',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'escape', 'unescape', 'globalThis',
  'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView', 'console', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance',
  'localStorage', 'sessionStorage', 'navigator', 'location', 'history', 'document', 'window', 'screen',
  'AudioContext', 'webkitAudioContext', 'Image', 'Audio', 'fetch', 'XMLHttpRequest', 'WebSocket', 'URL',
  'URLSearchParams', 'TextEncoder', 'TextDecoder', 'Blob', 'File', 'FileReader', 'FormData', 'Headers',
  'Request', 'Response', 'AbortController', 'crypto', 'atob', 'btoa', 'structuredClone', 'queueMicrotask',
]);

/** Very rough but useful: which bare identifiers look like free globals? */
function scanGlobals(code) {
  const declared = new Set();
  const declRe = /(?:^|[^\w$.])(?:function|class)\s+([A-Za-z_$][\w$]*)/g;
  const varRe = /(?:^|[^\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  const paramRe = /\(([^()]*)\)\s*(?:=>|\{)/g;
  const destrRe = /(?:const|let|var)\s*[[{]([^\]}]*)[\]}]/g;
  let m;
  while ((m = declRe.exec(code))) declared.add(m[1]);
  while ((m = varRe.exec(code))) declared.add(m[1]);
  while ((m = paramRe.exec(code))) {
    for (const p of m[1].split(',')) {
      const n = p.trim().replace(/^\.\.\./, '').split(/[=:]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n);
    }
  }
  while ((m = destrRe.exec(code))) {
    for (const p of m[1].split(',')) {
      const n = p.trim().split(':').pop().trim().replace(/^\.\.\./, '');
      if (/^[A-Za-z_$][\w$]*$/.test(n)) declared.add(n);
    }
  }
  const ids = new Set();
  const idRe = /(^|[^\w$.])([A-Za-z_$][\w$]*)\s*(?!\s*:)/g;
  while ((m = idRe.exec(code))) ids.add(m[2]);
  const out = [];
  for (const id of ids) {
    if (declared.has(id)) continue;
    if (JS_BUILTINS.has(id)) continue;
    out.push(id);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 6. Extract the game's inline script
 * ------------------------------------------------------------------ */

function extractGameScript(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;         // external (three.js from CDN)
    /* The multiplayer layer is browser-only and MUST NOT run on the server: it
       installs its own physics step hook and would take over the simulation.
       The build tags it so we can skip it here. */
    if (/id\s*=\s*["']?viber-mp-layer\b/i.test(attrs)) continue;
    if (/\bdata-sim-skip\b/i.test(attrs)) continue;
    if (/\btype\s*=\s*["']?(?!text\/javascript|module|application\/javascript)/i.test(attrs)) continue;
    out.push({ index: out.length, attrs: attrs.trim(), code: m[2] });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 7. Boot the simulation
 * ------------------------------------------------------------------ */

const SIM_EXPORTS = [
  /* --- mutable state (getters, so we never hold a stale reference) --- */
  'fighters', 'player', 'powerups', 'physicsEvents', 'hazards', 'spawnPoints', 'platforms',
  'powerSpawnTimer', 'MAP',
  /* --- config / data --- */
  'Game', 'CFG', 'ATTACKS', 'CHARACTERS', 'MAPS', 'POWER_TYPES', 'POWER_SPOTS', 'FIXED_DT', 'Save',
  /* --- deterministic RNG + event bus --- */
  'GameRNG', 'setSeed', 'emitEvent', 'setSeedFrom',
  /* --- simulation entry points --- */
  'updatePhysics', 'createFighters', 'createFightersFor', 'stepFighter', 'blankCtrl', 'aiControl',
  'playerCtrl', 'localPlayerCtrl', 'setNetInputSource', 'processPhysicsEvents',
  'Fighter', 'groundYAt', 'distFromCenter', 'applyHazardsForDifficulty', 'applyPowerup', 'spawnPowerup',
  'koFighter', 'koByFall', 'useAbility', 'minerSmash', 'checkHazards', 'startAttack', 'tryHit', 'applyHit',
  'mapSync', 'edgeDist', 'jumpApex', 'canLandAt', 'groundAhead',
  /* --- match flow --- */
  'resetToMenu', 'startMatch', 'endMatch', 'checkMatchEnd', 'showResults', 'announce',
  /* --- input plumbing (the multiplayer seam) --- */
  'Input', 'clearInput', 'clearEdges', 'readKeys', 'DEV', 'keys', 'touch', 'touchBtn',
  /* --- scene handles (only used to keep the fake renderer happy) --- */
  'scene', 'camera', 'renderer', 'hazards',
];

/**
 * @param {string} htmlPath  path to the game html
 * @param {object} [opts]
 * @param {boolean} [opts.report]  collect every global the game touched
 */
/**
 * The game source, read once and kept.
 *
 * Every match used to re-read the file from disk. That is slow, and it means a
 * transient filesystem hiccup at the exact moment someone presses READY takes
 * the whole room down — which is exactly what happened once, with EPERM, when
 * the file was momentarily unavailable. The game cannot change while the
 * process is running, so there is nothing to re-read for.
 */
const _sourceCache = new Map();
function readGameSource(htmlPath) {
  if (!_sourceCache.has(htmlPath)) _sourceCache.set(htmlPath, fs.readFileSync(htmlPath, 'utf8'));
  return _sourceCache.get(htmlPath);
}

function loadSim(htmlPath, opts = {}) {
  const html = readGameSource(htmlPath);
  const scripts = extractGameScript(html);
  if (!scripts.length) throw new Error(`no inline <script> found in ${htmlPath}`);

  const code = scripts.map(s => s.code).join('\n;\n');
  const doc = makeDocument();
  const win = makeWindow(doc);

  const sandbox = Object.assign(Object.create(null), win, {
    document: doc,
    THREE,
    console: opts.quiet
      ? { log() {}, warn() {}, error() {}, info() {}, debug() {} }
      : Object.assign(Object.create(console), {
        log: (...a) => console.log('[game]', ...a),
        warn: (...a) => console.warn('[game]', ...a),
        error: (...a) => console.error('[game]', ...a),
        info: (...a) => console.info('[game]', ...a),
      }),
    __SIM__: true,
  });

  // Pre-stub every identifier the static scan thinks might be a free global.
  const scanned = scanGlobals(code);
  for (const name of scanned) {
    if (!(name in sandbox)) sandbox[name] = inert(name);
  }

  const ctx = vm.createContext(sandbox, { name: 'vibe-sim' });

  // Return the simulation's internals. `const`/`let` at the top level of a vm
  // script live in script scope, not on the global object, so we wrap the whole
  // thing and hand back an explicit view. Getters are used for anything the
  // game reassigns (fighters, player, powerups) so we never hold a stale array.
  const getters = SIM_EXPORTS.map(n => `get ${n}(){ return (typeof ${n} !== 'undefined') ? ${n} : undefined; }`).join(',\n    ');
  const wrapper = `(function(){\n${code}\n; return {\n    ${getters}\n  };\n})()`;

  const compileOpts = { filename: path.basename(htmlPath) + '::sim', displayErrors: true };

  let api;
  const missing = [];
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      api = vm.runInContext(wrapper, ctx, compileOpts);
      break;
    } catch (e) {
      const m = /^(\w+) is not defined$/.exec(e.message || '');
      if (m && !(m[1] in sandbox)) {
        missing.push(m[1]);
        sandbox[m[1]] = inert(m[1]);
        continue;
      }
      throw e;
    }
  }
  if (!api) throw new Error('simulation failed to boot after 400 stub additions');

  api.__sandbox = sandbox;
  api.__globalsTouched = scanned;
  api.__globalsMissing = missing;
  api.__scriptCount = scripts.length;
  api.__scriptBytes = code.length;

  /* Let the host read/write values back into the sandbox (e.g. inject the
   * multiplayer input source). vm's global object is the contextified sandbox,
   * so this is a genuine two-way bridge. */
  api.global = sandbox;
  api.setGlobal = (k, v) => { sandbox[k] = v; };

  return api;
}




/* ===================== PART 2/2 — SERVER ===================== */
/* ===========================================================================
   VIBER BRAWL — AUTHORITATIVE MULTIPLAYER SERVER
   ===========================================================================
   Built as one file on purpose: the user deploys exactly two files.
   This section is concatenated after the headless simulation host, which gives
   us `loadSim()` — the game's own simulation, running in a sandbox with a fake
   browser. That means the server and the browser run THE SAME gameplay code.
   There is no second copy of the physics to drift out of sync.
   =========================================================================== */







/* ------------------------------------------------------------------ *
 * 1. Tunables — every magic number in one place
 * ------------------------------------------------------------------ */

const NET = {
  BUILD: '2.0.0',

  /* simulation */
  TICK_HZ: 60,
  DT: 1 / 60,
  MAX_CATCHUP_STEPS: 5,        // never spiral if the host stalls

  /* room / seating */
  SLOTS: 4,                    // fighter slots, always 4
  MAX_CLIENTS: 8,              // 4 fighters + up to 4 spectators
  CODE_LEN: 6,
  CODE_ALPHABET: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',   // no I O 0 1 — read aloud safely

  /* lobby */
  MIN_HUMANS_TO_START: 1,
  COUNTDOWN_SECONDS: 3.999,    // gives "3", "2", "1", "FIGHT!"
  DIFFICULTY: 'medium',        // hazard mix, same as the game's own default

  /* matchmaking */
  QUEUE_FILL_MS: 20000,        // wait this long, then top up with bots
  QUEUE_RESCAN_MS: 500,

  /* resilience */
  RECONNECT_SECONDS: 15,
  EMPTY_ROOM_TTL_MS: 60000,    // keep a room alive briefly so people can rejoin

  /* network quality */
  PING_INTERVAL_MS: 2000,
  PING_FAST_MS: 80,
  PING_SLOW_MS: 150,
  SNAPSHOT_HZ_FAST: 30,
  SNAPSHOT_HZ_NORMAL: 20,
  SNAPSHOT_HZ_SLOW: 15,

  /* Input hygiene.
     ---------------------------------------------------------------------------
     INPUT_QUEUE_MAX is a JITTER BUFFER, not a flood guard, and sizing it like a
     flood guard was a serious bug. The queue naturally holds
     (one-way latency x send rate) entries — at 250 ms RTT and 60 inputs/s that
     is ~8, before any jitter at all. Capping it at 4 made the server silently
     discard roughly half of every player's button presses, while the client
     predicted using all of them. The result was constant divergence, constant
     correction, and a character that barely obeyed its owner.
     48 entries is 0.8 s of slack at 60 Hz: far more than any real link needs,
     still bounded, and only a genuinely abusive client will reach it.
     --------------------------------------------------------------------------- */
  INPUT_QUEUE_MAX: 48,
  INPUTS_PER_SEC_CAP: 240,     // hard flood guard, separate from the buffer above

  /* events */
  EVENT_BATCH_MAX: 64,
};

/* ------------------------------------------------------------------ *
 * 2. Wire format
 * ------------------------------------------------------------------ *
 * Client -> server
 *   { t:'hello',  name, charId }          pick a name + character
 *   { t:'char',   charId }                change character (lobby only)
 *   { t:'ready',  v }                     ready up / down
 *   { t:'i', s, dx, dz, j, jp, q, h, d, a }   one frame of input
 *   { t:'rematch' }                       vote to play again
 *   { t:'pong', id }                      ping reply
 *
 * Server -> client
 *   { t:'welcome', slot, code, seed, tickHz, reconnectToken, spectator }
 *   { t:'ev', tick, list:[...] }          resolved combat events, sent IMMEDIATELY
 *   { t:'ping', id }
 *   { t:'say', text, kind }               server-side announcements
 *
 * Everything else (positions, health, lobby, phase) rides on the Colyseus
 * schema, which is delta-encoded — a fighter standing still costs ~2 bytes.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 3. Schema — the replicated state
 * ------------------------------------------------------------------ */

class FighterState extends Schema {}
defineTypes(FighterState, {
  index: 'uint8',
  charId: 'string',
  name: 'string',
  /* position / velocity */
  x: 'float32', y: 'float32', z: 'float32',
  vx: 'float32', vy: 'float32', vz: 'float32',
  /* status */
  health: 'float32',
  maxHealth: 'float32',
  lives: 'uint8',
  state: 'string',              // active | ko | respawning | dead
  facing: 'float32',
  hitstun: 'float32',
  invuln: 'float32',
  /* attack */
  attackType: 'string',         // '' | quick | heavy
  attackPhase: 'string',        // '' | startup | active | recovery
  attackT: 'float32',
  /* powerups */
  speedBuff: 'float32',
  damageBuff: 'float32',
  dashBuff: 'float32',
  shield: 'float32',
  phaseT: 'float32',
  /* bookkeeping */
  kos: 'uint8',
  ownerSlot: 'int8',            // -1 = bot, otherwise the player seat
  isBot: 'boolean',
  connected: 'boolean',
  /* The sequence number of the LAST input the simulation actually consumed for
     this fighter. The client replays its own inputs after this point to work out
     how wrong its prediction was. Only advances for human-controlled slots. */
  ack: 'uint32',
});

class PlayerState extends Schema {}
defineTypes(PlayerState, {
  sessionId: 'string',
  name: 'string',
  slot: 'int8',
  charId: 'string',
  ready: 'boolean',
  connected: 'boolean',
  spectator: 'boolean',
  ping: 'uint16',
  ack: 'uint32',
  wantsRematch: 'boolean',
  botNow: 'boolean',
});

class PowerupState extends Schema {}
defineTypes(PowerupState, {
  id: 'uint8',
  typeId: 'string',
  x: 'float32', y: 'float32', z: 'float32',
  life: 'float32',
});

class MatchState extends Schema {}
defineTypes(MatchState, {
  /* identity */
  roomCode: 'string',
  mode: 'string',               // 'rooms' | 'quick'
  /* lobby */
  phase: 'string',              // lobby | countdown | playing | over
  humanCount: 'uint8',
  botCount: 'uint8',
  readyCount: 'uint8',
  /* clock */
  tick: 'uint32',
  seed: 'uint32',
  countdown: 'float32',
  matchTime: 'float32',
  matchTimeTotal: 'float32',
  /* outcome */
  winnerSlot: 'int8',
  winnerName: 'string',
  matchNumber: 'uint8',
  /* net quality */
  snapshotHz: 'uint8',
  serverPingMs: 'uint16',
  /* world state the client cannot derive on its own */
  spinAngle: 'float32',
  padPhase: 'uint8',            // bitmask, one bit per pad
  /* collections */
  players: { map: PlayerState },
  fighters: { array: FighterState },
  powerups: { array: PowerupState },
});

/* ------------------------------------------------------------------ *
 * 4. Room-code registry
 * ------------------------------------------------------------------ *
 * Colyseus 0.15 has no `filterBy`, so we keep our own code -> roomId map.
 * Single process, so a Map is exactly right. Collisions are retried, and
 * entries are removed when the room is disposed.
 * ------------------------------------------------------------------ */

const codeRegistry = new Map();   // CODE -> roomId

function randomCode() {
  let out = '';
  for (let i = 0; i < NET.CODE_LEN; i++) {
    out += NET.CODE_ALPHABET[crypto.randomInt(NET.CODE_ALPHABET.length)];
  }
  return out;
}

/** Allocates a code that is not currently in use. Retries, then gives up loudly. */
function allocateCode() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const code = randomCode();
    if (!codeRegistry.has(code)) return code;
  }
  throw new Error('room-code space exhausted');
}

/** A room's seed. Derived from its code so a room is reproducible from its name. */
function seedForCode(code) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h || 1) >>> 0;
}

const normaliseCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, NET.CODE_LEN);

/* ------------------------------------------------------------------ *
 * 5. The simulation wrapper — one headless game per room
 * ------------------------------------------------------------------ */

/* The game file ships next to the server. Try a few sensible places so the
   server also runs from the repo root, from dist/, or via `node _src/...`. */
function findGameHtml() {
  const here = __dirname;
  const candidates = [
    path.join(here, 'vibe-brawl.html'),                 // deployed layout
    path.join(here, 'dist', 'vibe-brawl.html'),         // repo root, built client
    path.join(here, '_src', 'game', 'vibe-brawl.html'), // repo root, source game
    path.join(here, '..', 'vibe-brawl.html'),           // run from _src/server
    path.join(here, '..', '..', 'vibe-brawl.html'),
    path.join(process.cwd(), 'vibe-brawl.html'),
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) { /* keep looking */ } }
  return candidates[0];
}
const GAME_HTML = findGameHtml();

class Match {
  /**
   * Owns a sandboxed copy of the game and drives it at a fixed 60 Hz.
   * Nothing in here knows about networking; it just steps and reports.
   */
  constructor(seed, charIds) {
    this.sim = loadSim(GAME_HTML, { quiet: true });
    this.seed = seed >>> 0;
    this._queues = {};      // slot -> FIFO of {seq, ctrl}, filled by the room
    this._lastCtrl = {};    // slot -> last applied ctrl, so a slow client keeps moving
    this._ackSeq = {};      // slot -> last sequence the sim actually consumed
    this._poppedAt = {};    // slot -> tick we last consumed an input on
    this._humanSlots = [];  // slots driven by a person, drained every tick
    this.reset(seed, charIds);
  }

  reset(seed, charIds) {
    const sim = this.sim;
    this.seed = seed >>> 0;
    sim.setSeed(this.seed);
    sim.createFightersFor(charIds.map((id, i) => {
      const def = sim.CHARACTERS.find((c) => c.id === id) || sim.CHARACTERS[i];
      return def;
    }));
    sim.applyHazardsForDifficulty(NET.DIFFICULTY);

    const G = sim.Game;
    G.mode = 'play';
    G.over = false;
    G.paused = false;
    G.rotPaused = false;
    G.countdown = NET.COUNTDOWN_SECONDS;
    G.matchTime = sim.CFG.matchTime;
    G.hitStop = 0;
    G.shake = 0;
    G.winner = null;
    G.victoryPhase = null;
    G.victoryT = 0;
    G.playerSurvived = 0;
    G.time = 0;

    /* every human slot is a "player" as far as the sim is concerned: that is
       what makes it read controls from `netInputSource` instead of the AI.
       Bots keep isPlayer=false and drive themselves. */
    sim.setNetInputSource((f) => this._inputFor(f));
    this.acc = 0;
    this.tick = 0;
    this.events = [];
  }

  get fighters() { return this.sim.fighters; }

  /** Marks slot `i` as human-controlled (or not). */
  setSlotHuman(i, isHuman) {
    const f = this.fighters[i];
    if (f) f.isPlayer = !!isHuman;
    if (isHuman) {
      if (this._humanSlots.indexOf(i) === -1) this._humanSlots.push(i);
    } else {
      this._humanSlots = this._humanSlots.filter((s) => s !== i);
    }
  }

  /** Points the sim at the room's live input arrays (same array objects). */
  setInputQueue(slot, q) { this._queues[slot] = q; }

  /** Last input sequence this slot actually consumed. 0 = nothing consumed yet. */
  ackFor(slot) { return (this._ackSeq && this._ackSeq[slot]) >>> 0; }

  /**
   * Consume exactly ONE queued input for `slot` this tick, and only once.
   *
   * This used to happen implicitly, from inside playerCtrl() — which the game
   * only calls when the fighter is `active` and the match is not in countdown.
   * So while a player was knocked out, respawning, or waiting through 3-2-1,
   * nothing drained their queue: it filled to its cap, the server silently
   * discarded real button presses, and on respawn the player received a burst
   * of stale input all at once.
   *
   * Measured: the sim ran 60 steps/s but consumed only 38.6 inputs/s, dropping
   * 168 of 601 presses in ten seconds. That is the "my character barely obeys
   * me" bug.
   *
   * Now it is driven by the tick, not by the game's control flow, so the queue
   * always drains and never accumulates stale input.
   */
  _popInput(slot) {
    if (this._poppedAt[slot] === this.tick) return;   // already served this tick
    this._poppedAt[slot] = this.tick;
    const q = this._queues && this._queues[slot];
    if (!q || !q.length) return;                      // nothing new; keep last
    const pkt = q.shift();
    this._pops = (this._pops || 0) + 1;
    this._lastCtrl[slot] = pkt.ctrl;
    this._ackSeq[slot] = pkt.seq;
  }

  /** What the sim should use for this fighter right now. */
  _inputFor(f) {
    this._popInput(f.index);
    return this._lastCtrl[f.index] || this.sim.blankCtrl();
  }

  /** Advances the simulation by exactly one fixed step and collects events. */
  step() {
    const sim = this.sim;
    /* Drain every human's queue BEFORE the sim runs, whatever it is about to
       do. The sim may then ignore the input (countdown, knocked out) — that is
       fine and correct; the important part is that it does not pile up. */
    for (let i = 0; i < this._humanSlots.length; i++) this._popInput(this._humanSlots[i]);
    sim.physicsEvents.length = 0;
    sim.updatePhysics(NET.DT);
    const evs = sim.physicsEvents;
    for (let i = 0; i < evs.length; i++) this.events.push(evs[i]);
    this.tick++;
  }

  /** Runs the accumulator so physics is 60 Hz no matter how the host timer behaves. */
  advance(deltaMs) {
    this.acc += deltaMs;
    let steps = 0;
    while (this.acc >= NET.DT * 1000 && steps < NET.MAX_CATCHUP_STEPS) {
      this.step();
      this.acc -= NET.DT * 1000;
      steps++;
    }
    if (steps === NET.MAX_CATCHUP_STEPS) this.acc = 0;   // drop the debt, don't spiral
    return steps;
  }

  drainEvents() {
    if (!this.events.length) return null;
    const out = this.events;
    this.events = [];
    return out;
  }

  get over() { return !!this.sim.Game.over; }
  get countdown() { return this.sim.Game.countdown; }
  get matchTime() { return this.sim.Game.matchTime; }
  get winnerIndex() {
    const w = this.sim.Game.winner;
    return w ? w.index : -1;
  }
}

/* ------------------------------------------------------------------ *
 * 6. Event serialisation
 * ------------------------------------------------------------------ *
 * The sim's events are plain data except for `abilityRing`, which carries a
 * live Fighter reference. Swap that for an index; the client re-resolves it.
 * ------------------------------------------------------------------ */

const EVENT_TYPES = new Set([
  'burst', 'impactRing', 'sfx', 'sfxCount', 'dashChips', 'koShards', 'hitSparks',
  'abilityRing', 'doubleJumpRing', 'padActivate',
]);

function serialiseEvent(ev) {
  if (ev.f) {
    const { f, ...rest } = ev;
    return Object.assign({}, rest, { fi: f.index });
  }
  return ev;
}

function serialiseEvents(list) {
  const out = [];
  for (const ev of list) {
    if (!ev || !EVENT_TYPES.has(ev.type)) continue;
    out.push(serialiseEvent(ev));
    if (out.length >= NET.EVENT_BATCH_MAX) break;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 7. BattleRoom
 * ------------------------------------------------------------------ */

class BattleRoom extends Room {
  onCreate(options) {
    this.maxClients = NET.MAX_CLIENTS;
    this.autoDispose = true;

    this.mode = options.mode === 'quick' ? 'quick' : 'rooms';
    this.code = normaliseCode(options.code) || allocateCode();
    this.seed = seedForCode(this.code);

    /* seating */
    this.slotOwner = [-1, -1, -1, -1];     // slot -> seat index, -1 = open
    this.seats = new Map();                // sessionId -> seat record
    this.nextSeat = 0;
    this.botTakeover = new Map();          // slot -> seat index that owns it while away
    this.disconnected = new Map();         // sessionId -> { seat, timer }

    /* input plumbing */
    this.inputQueues = [[], [], [], []];
    this.inputBudget = new Map();          // sessionId -> { count, windowStart }
    this.lastCtrl = {};

    /* lobby / match */
    this.phase = 'lobby';
    this.match = null;
    this.matchNumber = 0;
    this.lobbyChar = ['miner', 'moss', 'volt', 'phantom'];
    this.queueDeadline = 0;
    this.createdAt = Date.now();   // oldest-first ordering for Quick Play
    this.emptySince = 0;
    this._lastTickAt = 0;

    /* network quality */
    this.pings = new Map();                // sessionId -> ms
    this.pingSeq = 0;

    this.setState(new MatchState());
    /* Colyseus does NOT auto-create collection fields declared with
       `{ map: X }` / `{ array: X }` — they must be assigned explicitly, or the
       first `.set()` throws and the client is dropped with error 4216. */
    this.state.players = new MapSchema();
    this.state.fighters = new ArraySchema();
    this.state.powerups = new ArraySchema();
    this.state.roomCode = this.code;
    this.state.mode = this.mode;
    this.state.phase = 'lobby';
    this.state.seed = this.seed;
    this.state.matchTimeTotal = 0;
    this.state.winnerSlot = -1;
    this.state.winnerName = '';
    this.state.matchNumber = 0;
    this.state.snapshotHz = NET.SNAPSHOT_HZ_NORMAL;
    this.state.serverPingMs = 0;
    this.state.spinAngle = 0;
    this.state.padPhase = 0;

    codeRegistry.set(this.code, this.roomId);

    /* ---------------- message handlers ---------------- */
    this.onMessage('hello', (client, msg) => this._onHello(client, msg));
    this.onMessage('char', (client, msg) => this._onPickChar(client, msg));
    this.onMessage('ready', (client, msg) => this._onReady(client, msg));
    this.onMessage('i', (client, msg) => this._onInput(client, msg));
    this.onMessage('rematch', (client) => this._onRematch(client));
    this.onMessage('pong', (client, msg) => this._onPong(client, msg));

    /* ---------------- fixed 60 Hz simulation ---------------- */
    this.setSimulationInterval((dt) => this._tick(dt), Math.round(1000 / NET.TICK_HZ));
    this.setPatchRate(Math.round(1000 / NET.SNAPSHOT_HZ_NORMAL));

    this.clock.setInterval(() => this._sendPings(), NET.PING_INTERVAL_MS);
    this.clock.setInterval(() => this._housekeeping(), 1000);
    if (this.mode === 'quick') {
      this.clock.setInterval(() => this._matchmake(), NET.QUEUE_RESCAN_MS);
    }

    this._log(`created code=${this.code} mode=${this.mode} roomId=${this.roomId}`);
  }

  _log(...a) { if (process.env.VIBER_VERBOSE) console.log(`[room ${this.code}]`, ...a); }

  /* ---------------- seating ---------------- */

  _findOpenSlot() {
    for (let i = 0; i < NET.SLOTS; i++) if (this.slotOwner[i] === -1) return i;
    return -1;
  }

  _humanCount() {
    let n = 0;
    for (const p of this.state.players.values()) if (!p.spectator && !p.botNow) n++;
    return n;
  }

  onJoin(client, options) {
    const name = this._cleanName(options && options.name);
    const wanted = this._validChar(options && options.charId);

    let slot = this._findOpenSlot();
    let spectator = false;

    if (slot === -1) {
      /* Room is full of people. Mid-match, a bot slot can be handed over. */
      slot = this._botSlotToClaim();
      if (slot === -1) spectator = true;
    }

    const seat = {
      sessionId: client.sessionId,
      name,
      slot,
      charId: wanted,
      ready: false,
      spectator,
      rematch: false,
      away: false,
    };
    this.seats.set(client.sessionId, seat);
    if (slot >= 0) this.slotOwner[slot] = 0;   // owned by a human seat

    const p = new PlayerState();
    p.sessionId = client.sessionId;
    p.name = name;
    p.slot = slot;
    p.charId = wanted;
    p.ready = false;
    p.connected = true;
    p.spectator = spectator;
    p.ping = 0;
    p.ack = 0;
    p.wantsRematch = false;
    p.botNow = false;
    this.state.players.set(client.sessionId, p);

    if (slot >= 0 && !spectator) {
      this.lobbyChar[slot] = wanted;
      this.inputQueues[slot] = [];
    }

    client.send('welcome', {
      slot,
      spectator,
      code: this.code,
      seed: this.seed,
      tickHz: NET.TICK_HZ,
      mode: this.mode,
      build: NET.BUILD,
      reconnectToken: client.reconnectionToken || null,
    });

    this._log(`join ${name} slot=${slot} spectator=${spectator} (${this._humanCount()} humans)`);

    /* A mid-match arrival into a bot slot inherits that bot's fighter. */
    if (this.phase === 'playing' && slot >= 0 && !spectator) this._seatInheritsFighter(slot);

    this._refreshCounts();
    this._refreshLobbyFighters();
    if (this.mode === 'quick' && this.phase === 'lobby') this._matchmake();
    else this._maybeStartCountdown();
    return true;
  }

  _seatInheritsFighter(slot) {
    if (!this.match) return;
    this.match.setSlotHuman(slot, true);
    this._syncFighter(slot);
    this.broadcast('say', { text: `${this.state.players.get(this._seatSessionForSlot(slot))?.name || 'A player'} joined the fight!`, kind: 'join' });
  }

  _botSlotToClaim() {
    for (let i = 0; i < NET.SLOTS; i++) {
      const f = this.state.fighters[i];
      if (f && f.isBot) return i;
    }
    return -1;
  }

  _seatSessionForSlot(slot) {
    for (const [sid, seat] of this.seats) if (seat.slot === slot && !seat.spectator) return sid;
    return null;
  }

  async onLeave(client, consented) {
    const seat = this.seats.get(client.sessionId);
    if (!seat) return;
    const slot = seat.slot;

    seat.away = true;
    const p = this.state.players.get(client.sessionId);
    if (p) p.connected = false;
    this.pings.delete(client.sessionId);
    this.inputBudget.delete(client.sessionId);
    this._refreshCounts();

    const canReconnect = !consented && this.phase !== 'lobby' && slot >= 0 && !seat.spectator;

    if (canReconnect) {
      /* Hand the fighter to a bot RIGHT NOW so the match never pauses. */
      this._handToBot(slot, seat);
      this.broadcast('say', { text: `${seat.name} lost connection — a bot is covering for them.`, kind: 'warn' });
      try {
        const reconnected = await this.allowReconnection(client, NET.RECONNECT_SECONDS);
        this._handBackToPlayer(slot, seat, reconnected);
      } catch (e) {
        /* window expired: the bot keeps the slot for the rest of the match */
        this.seats.delete(client.sessionId);
        this.state.players.delete(client.sessionId);
        this._refreshCounts();
        this._log(`reconnect window expired for ${seat.name} (slot ${slot})`);
      }
    } else {
      /* clean exit: free the slot */
      if (slot >= 0 && this.slotOwner[slot] !== -1) {
        this.slotOwner[slot] = -1;
        this.inputQueues[slot] = [];
      }
      this.seats.delete(client.sessionId);
      this.state.players.delete(client.sessionId);
      this._refreshCounts();
      if (this.phase === 'playing') this._handToBot(slot, seat);
      this._log(`left ${seat.name} consented=${consented}`);
    }

    if (this.phase === 'lobby' && this.mode === 'quick') this._matchmake();
    this._maybeStartCountdown();
    if (this.clients.length === 0) this.emptySince = Date.now();
  }

  _handToBot(slot, seat) {
    if (slot < 0 || !this.match) return;
    this.match.setSlotHuman(slot, false);
    this.inputQueues[slot] = [];
    const f = this.state.fighters[slot];
    if (f) { f.isBot = true; f.ownerSlot = -1; f.connected = true; }
    const p = seat ? this.state.players.get(seat.sessionId) : null;
    if (p) { p.botNow = true; p.connected = false; }
    this._refreshCounts();
  }

  _handBackToPlayer(slot, seat, client) {
    if (!this.match) return;
    this.match.setSlotHuman(slot, true);
    this.inputQueues[slot] = [];
    this.slotOwner[slot] = 0;
    seat.away = false;
    const p = this.state.players.get(client.sessionId);
    if (p) { p.connected = true; p.botNow = false; }
    const f = this.state.fighters[slot];
    if (f) { f.isBot = false; f.ownerSlot = 0; f.connected = true; }
    this.broadcast('say', { text: `${seat.name} is back!`, kind: 'join' });
    client.send('welcome', {
      slot, spectator: false, code: this.code, seed: this.seed,
      tickHz: NET.TICK_HZ, mode: this.mode, build: NET.BUILD, resumed: true,
    });
    this._refreshCounts();
    this._log(`reconnected ${seat.name} to slot ${slot}`);
  }

  /* ---------------- lobby ---------------- */

  _cleanName(raw) {
    let n = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (!n) n = `Guest ${this.nextSeat + 1}`;
    return n.slice(0, 16);
  }

  _validChar(id) {
    const sim = this.match ? this.match.sim : null;
    const list = sim ? sim.CHARACTERS.map((c) => c.id) : ['miner', 'moss', 'volt', 'phantom'];
    return list.includes(id) ? id : list[0];
  }

  _onHello(client, msg) {
    const seat = this.seats.get(client.sessionId);
    if (!seat) return;
    if (msg && msg.name) {
      seat.name = this._cleanName(msg.name);
      const p = this.state.players.get(client.sessionId);
      if (p) p.name = seat.name;
    }
    if (msg && msg.charId) this._onPickChar(client, msg);
  }

  _onPickChar(client, msg) {
    const seat = this.seats.get(client.sessionId);
    if (!seat || seat.spectator) return;
    if (this.phase !== 'lobby') return;                 // characters are locked in a match
    const id = this._validChar(msg && msg.charId);
    seat.charId = id;
    this.lobbyChar[seat.slot] = id;
    const p = this.state.players.get(client.sessionId);
    if (p) { p.charId = id; p.ready = false; }          // changing character un-readies you
    this._refreshLobbyFighters();
    this._refreshCounts();
  }

  _onReady(client, msg) {
    const seat = this.seats.get(client.sessionId);
    if (!seat || seat.spectator) return;
    if (this.phase !== 'lobby') return;
    seat.ready = !!(msg && msg.v);
    const p = this.state.players.get(client.sessionId);
    if (p) p.ready = seat.ready;
    this._refreshCounts();
    this._maybeStartCountdown();
  }

  _onRematch(client) {
    const seat = this.seats.get(client.sessionId);
    if (!seat) return;
    seat.rematch = true;
    const p = this.state.players.get(client.sessionId);
    if (p) p.wantsRematch = true;

    /* every human present must agree; then we go straight back to the lobby */
    let humans = 0, agreed = 0;
    for (const s of this.seats.values()) {
      if (s.spectator) continue;
      humans++;
      if (s.rematch) agreed++;
    }
    if (humans > 0 && agreed === humans) this._resetToLobby();
  }

  _resetToLobby() {
    this.phase = 'lobby';
    this.state.phase = 'lobby';
    this.state.winnerSlot = -1;
    this.state.winnerName = '';
    this.match = null;
    this.queueDeadline = 0;
    for (const s of this.seats.values()) {
      s.ready = false;
      s.rematch = false;
      const p = this.state.players.get(s.sessionId);
      if (p) { p.ready = false; p.wantsRematch = false; p.botNow = false; p.connected = true; }
    }
    for (let i = 0; i < NET.SLOTS; i++) {
      const sid = this._seatSessionForSlot(i);
      this.lobbyChar[i] = sid ? (this.seats.get(sid).charId) : this.lobbyChar[i];
      this.slotOwner[i] = sid ? 0 : -1;
      this.inputQueues[i] = [];
    }
    this.state.fighters.clear();
    this.state.powerups.clear();
    this._refreshCounts();
    this.broadcast('say', { text: 'Back to the lobby — ready up for a rematch.', kind: 'info' });
    this._log('reset to lobby');
  }

  /* ---------------- match lifecycle ---------------- */

  _maybeStartCountdown() {
    if (this.phase !== 'lobby') return;
    if (this.mode === 'quick') { this._matchmake(); return; }

    let humans = 0, ready = 0;
    for (const s of this.seats.values()) {
      if (s.spectator || s.away) continue;
      humans++;
      if (s.ready) ready++;
    }
    if (humans >= NET.MIN_HUMANS_TO_START && humans === ready) this._startMatch();
  }

  _matchmake() {
    if (this.phase !== 'lobby') return;
    const humans = this._humanCount();
    if (humans <= 0) { this.queueDeadline = 0; return; }

    /* 4 humans: go now. Otherwise start a 20s clock on the first arrival. */
    if (humans >= NET.SLOTS) { this._startMatch(); return; }
    if (!this.queueDeadline) this.queueDeadline = Date.now() + NET.QUEUE_FILL_MS;
    if (Date.now() >= this.queueDeadline) this._startMatch();
  }

  _startMatch() {
    if (this.phase !== 'lobby') return;

    /* who is fighting, and as what */
    const charIds = [];
    const owners = [];
    for (let i = 0; i < NET.SLOTS; i++) {
      const sid = this._seatSessionForSlot(i);
      if (sid) {
        const s = this.seats.get(sid);
        charIds.push(s.charId);
        owners.push(i);
      } else {
        /* empty slot -> bot, keeping the character the lobby was showing */
        charIds.push(this.lobbyChar[i]);
        owners.push(-1);
      }
    }

    /* fresh seed every match so a rematch is a genuinely new fight */
    this.matchNumber = (this.matchNumber + 1) & 0xff;
    const seed = (this.seed + this.matchNumber * 0x9E3779B9) >>> 0;

    this.match = new Match(seed, charIds);
    for (let i = 0; i < NET.SLOTS; i++) this.match.setInputQueue(i, this.inputQueues[i]);
    for (let i = 0; i < NET.SLOTS; i++) this.match.setSlotHuman(i, owners[i] >= 0);

    this.phase = 'countdown';
    this.state.phase = 'countdown';
    this.state.seed = seed;
    this.state.matchNumber = this.matchNumber;
    this.state.winnerSlot = -1;
    this.state.winnerName = '';
    this.state.matchTimeTotal = this.match.sim.CFG.matchTime;
    this.state.countdown = NET.COUNTDOWN_SECONDS;
    this.state.matchTime = this.match.sim.CFG.matchTime;

    this._rebuildFighterSchema(charIds, owners);
    this.state.powerups.clear();
    this.startedAt = Date.now();
    this._refreshCounts();
    this.broadcast('say', { text: 'GET READY', kind: 'info' });
    this._log(`match ${this.matchNumber} starting: ${charIds.join(',')} owners=${owners.join(',')}`);
  }

  _rebuildFighterSchema(charIds, owners) {
    const sim = this.match.sim;
    this.state.fighters.clear();
    for (let i = 0; i < NET.SLOTS; i++) {
      const f = sim.fighters[i];
      const fs = new FighterState();
      fs.index = i;
      fs.charId = charIds[i];
      fs.name = this._displayNameForSlot(i);
      fs.ownerSlot = owners[i];
      fs.isBot = owners[i] < 0;
      fs.connected = true;
      fs.maxHealth = f.maxHealth;
      fs.health = f.health;
      fs.lives = f.lives;
      fs.state = f.state;
      fs.attackType = '';
      fs.attackPhase = '';
      this.state.fighters.push(fs);
    }
  }

  _displayNameForSlot(slot) {
    const sid = this._seatSessionForSlot(slot);
    if (!sid) return 'BOT';
    const s = this.seats.get(sid);
    return s ? s.name : 'BOT';
  }

  /* ---------------- the loop ---------------- */

  _tick() {
    /* Measure the interval ourselves rather than trusting the timer callback's
       argument. A chained setTimeout/setInterval does NOT fire every 16.67 ms on
       every host (it drifts to ~30 ms on Windows), and the accumulator below is
       what restores a true 60 Hz — but only if the elapsed time is real. */
    const now = Date.now();
    const deltaMs = this._lastTickAt ? Math.min(250, now - this._lastTickAt) : (1000 / NET.TICK_HZ);
    this._lastTickAt = now;

    if (!this.match) return;

    if (this.phase === 'countdown') {
      if (this.match.countdown <= 0) {
        this.phase = 'playing';
        this.state.phase = 'playing';
        this.broadcast('say', { text: 'FIGHT!', kind: 'go' });
        this._log('FIGHT');
      }
    }

    if (this.phase !== 'countdown' && this.phase !== 'playing') {
      /* still drain so nothing leaks between matches */
      this.match.drainEvents();
      return;
    }

    const steps = this.match.advance(deltaMs);

    /* --- push simulation state into the schema --- */
    this._syncFighters();
    this.state.tick = this.match.tick;
    this.state.countdown = Math.max(0, this.match.countdown);
    this.state.matchTime = Math.max(0, this.match.matchTime);
    const sim = this.match.sim;
    if (sim.hazards.spinBar) this.state.spinAngle = sim.hazards.spinBar.rotation.y;
    let padMask = 0;
    sim.hazards.pads.forEach((p, i) => { if (p.active) padMask |= (1 << i); });
    this.state.padPhase = padMask;
    this._syncPowerups();

    /* --- discrete events go out IMMEDIATELY, not on the snapshot clock ---
       Bundling them into the 20 Hz patch is what makes hits feel late: a quick
       attack is over in under 50 ms, so its feedback would always miss a
       snapshot. Sending them the moment they resolve costs one extra packet. */
    const evs = this.match.drainEvents();
    if (evs && evs.length) {
      const list = serialiseEvents(evs);
      if (list.length) this.broadcast('ev', { tick: this.match.tick, list });
    }

    /* --- end of match --- */
    if (this.phase === 'playing' && this.match.over) this._finishMatch();
  }

  _finishMatch() {
    const idx = this.match.winnerIndex;
    this.phase = 'over';
    this.state.phase = 'over';
    this.state.winnerSlot = idx;
    const f = idx >= 0 ? this.match.sim.fighters[idx] : null;
    this.state.winnerName = f ? (this._displayNameForSlot(idx) || 'BOT') : 'Nobody';
    this._syncFighters();
    this._refreshCounts();
    this.broadcast('say', { text: f ? `${this.state.winnerName} wins!` : 'Nobody survived.', kind: 'end' });
    this._log(`match ${this.matchNumber} over, winner slot ${idx}`);
  }

  _syncFighters() {
    const sim = this.match.sim;
    for (let i = 0; i < NET.SLOTS; i++) {
      const f = sim.fighters[i];
      const fs = this.state.fighters[i];
      if (!f || !fs) continue;
      fs.x = f.pos.x; fs.y = f.pos.y; fs.z = f.pos.z;
      fs.vx = f.vx; fs.vy = f.vy; fs.vz = f.vz;
      fs.health = f.health;
      fs.maxHealth = f.maxHealth;
      fs.lives = f.lives;
      fs.state = f.state;
      fs.facing = f.facing;
      fs.hitstun = f.hitstun;
      fs.invuln = f.invuln;
      fs.attackType = f.attackType || '';
      fs.attackPhase = f.attackPhase || '';
      fs.attackT = f.attackT;
      fs.speedBuff = f.speedBuff;
      fs.damageBuff = f.damageBuff;
      fs.dashBuff = f.dashBuff;
      fs.shield = f.shield;
      fs.phaseT = f.phaseT;
      fs.kos = f.kos;
      /* honest ack: the sequence the sim consumed, not the last one received */
      if (!fs.isBot) fs.ack = this.match.ackFor(i);
    }
  }

  _syncFighter(i) {
    const f = this.match && this.match.sim.fighters[i];
    const fs = this.state.fighters[i];
    if (f && fs) { fs.isBot = !f.isPlayer; fs.ownerSlot = f.isPlayer ? 0 : -1; }
  }

  _syncPowerups() {
    const sim = this.match.sim;
    const live = sim.powerups;
    const schema = this.state.powerups;

    /* power-ups are few (max 3), so a simple rebuild is cheaper than diffing */
    if (live.length !== schema.length) {
      schema.clear();
      for (let i = 0; i < live.length; i++) {
        const p = live[i];
        const ps = new PowerupState();
        ps.id = i;
        ps.typeId = p.type.id;
        ps.x = p.pos.x; ps.y = p.pos.y; ps.z = p.pos.z;
        ps.life = p.life;
        schema.push(ps);
      }
      return;
    }
    for (let i = 0; i < live.length; i++) {
      const p = live[i], ps = schema[i];
      ps.typeId = p.type.id;
      ps.x = p.pos.x; ps.y = p.pos.y; ps.z = p.pos.z;
      ps.life = p.life;
    }
  }

  /* ---------------- input ---------------- */

  _onInput(client, msg) {
    const seat = this.seats.get(client.sessionId);
    if (!seat || seat.spectator) return;
    if (this.phase !== 'countdown' && this.phase !== 'playing') return;
    const slot = seat.slot;
    if (slot < 0 || this.slotOwner[slot] === -1) return;

    /* flood guard: a client sending 3x normal rate is fine, 240/s is not */
    const now = Date.now();
    let b = this.inputBudget.get(client.sessionId);
    if (!b || now - b.windowStart > 1000) { b = { count: 0, windowStart: now }; this.inputBudget.set(client.sessionId, b); }
    b.count++;
    if (b.count > NET.INPUTS_PER_SEC_CAP) return;

    const seq = (msg && msg.s) >>> 0;
    const q = this.inputQueues[slot];
    q.push({ seq, ctrl: this._sanitiseCtrl(msg) });
    this.inputsIn = (this.inputsIn || 0) + 1;
    /* Only reached by a client genuinely sending faster than the sim ticks.
       Counted, because a silent drop here is invisible from the outside and
       looks exactly like "my controls do not work". */
    if (q.length > NET.INPUT_QUEUE_MAX) {
      const lost = q.length - NET.INPUT_QUEUE_MAX;
      q.splice(0, lost);
      this.inputDrops = (this.inputDrops || 0) + lost;
    }

    /* ack: the highest sequence the server has accepted for this slot */
    const p = this.state.players.get(client.sessionId);
    if (p) p.ack = seq;
  }

  /** Never trust a client. Coerce every field into the exact shape the sim expects. */
  _sanitiseCtrl(msg) {
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    let dx = num(msg && msg.dx), dz = num(msg && msg.dz);
    const len = Math.hypot(dx, dz);
    if (len > 1) { dx /= len; dz /= len; }            // no diagonal speed boost
    return {
      dirX: Math.max(-1, Math.min(1, dx)),
      dirZ: Math.max(-1, Math.min(1, dz)),
      jump: !!(msg && msg.j),
      jumpPressed: !!(msg && msg.jp),
      quick: !!(msg && msg.q),
      heavy: !!(msg && msg.h),
      dash: !!(msg && msg.d),
      ability: !!(msg && msg.a),
    };
  }

  /* ---------------- ping / snapshot rate ---------------- */

  _sendPings() {
    if (!this.clients.length) return;
    const id = (this.pingSeq = (this.pingSeq + 1) & 0xffff);
    this._pingSentAt = this._pingSentAt || new Map();
    this._pingSentAt.set(id, Date.now());
    this.broadcast('ping', { id });
  }

  _onPong(client, msg) {
    const id = msg && msg.id;
    const sentAt = this._pingSentAt && this._pingSentAt.get(id);
    if (sentAt == null) return;
    this._pingSentAt.delete(id);
    const rtt = Math.max(0, Math.min(65535, Date.now() - sentAt));
    this.pings.set(client.sessionId, rtt);
    const p = this.state.players.get(client.sessionId);
    if (p) p.ping = rtt;
    this._recomputeRate();
  }

  _recomputeRate() {
    let worst = 0, any = false;
    for (const [sid, ms] of this.pings) {
      const p = this.state.players.get(sid);
      if (!p || !p.connected) continue;
      any = true;
      if (ms > worst) worst = ms;
    }
    if (!any) return;

    let hz = NET.SNAPSHOT_HZ_FAST;
    if (worst > NET.PING_SLOW_MS) hz = NET.SNAPSHOT_HZ_SLOW;
    else if (worst > NET.PING_FAST_MS) hz = NET.SNAPSHOT_HZ_NORMAL;

    if (this.state.snapshotHz !== hz) {
      this.state.snapshotHz = hz;
      this.setPatchRate(Math.round(1000 / hz));
      this._log(`snapshot rate -> ${hz}/s (worst ping ${worst}ms)`);
    }
    this.state.serverPingMs = worst;
  }

  /* ---------------- housekeeping ---------------- */

  _refreshCounts() {
    /* Counted the way a player reads it: there are always four seats, so
       humans + bots === 4. A seat whose owner has dropped is a bot right now. */
    let humans = 0, ready = 0;
    for (const p of this.state.players.values()) {
      if (p.spectator) continue;
      if (p.connected && !p.botNow) humans++;
      if (p.ready) ready++;
    }
    this.state.humanCount = Math.min(humans, NET.SLOTS);
    this.state.botCount = Math.max(0, NET.SLOTS - humans);
    this.state.readyCount = ready;
  }

  _refreshLobbyFighters() {
    /* in the lobby we still show four fighters so the client has something to
       draw; they are rebuilt properly when the match starts */
    if (this.phase !== 'lobby') return;
    const sim = this.match ? this.match.sim : null;
    this.state.fighters.clear();
    for (let i = 0; i < NET.SLOTS; i++) {
      const sid = this._seatSessionForSlot(i);
      const fs = new FighterState();
      fs.index = i;
      fs.charId = this.lobbyChar[i];
      fs.name = sid ? this.seats.get(sid).name : 'BOT';
      fs.ownerSlot = sid ? 0 : -1;
      fs.isBot = !sid;
      fs.connected = !!sid;
      fs.health = 100; fs.maxHealth = 100; fs.lives = 3;
      fs.state = 'active';
      this.state.fighters.push(fs);
    }
  }

  _housekeeping() {
    if (this.clients.length === 0) {
      if (!this.emptySince) this.emptySince = Date.now();
      else if (Date.now() - this.emptySince > NET.EMPTY_ROOM_TTL_MS) {
        this._log('empty for too long — disposing');
        this.disconnect();
      }
    } else {
      this.emptySince = 0;
    }
  }

  onDispose() {
    if (codeRegistry.get(this.code) === this.roomId) codeRegistry.delete(this.code);
    this._log('disposed');
  }
}

/* ------------------------------------------------------------------ *
 * 8. Quick Play — the room IS the queue
 * ------------------------------------------------------------------ */

class QuickPlayRoom extends BattleRoom {
  onCreate(options) {
    super.onCreate(Object.assign({}, options, { mode: 'quick' }));
    /* quick play has no ready-up step: people are matched, then it starts */
    this.state.mode = 'quick';
  }
}

/* ------------------------------------------------------------------ *
 * 9. HTTP layer
 * ------------------------------------------------------------------ */

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

/* --- tiny in-memory rate limiter so the matchmaking endpoints can't be hammered --- */
const rateBuckets = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let b = rateBuckets.get(ip);
  if (!b || now - b.start > 10000) { b = { start: now, n: 0 }; rateBuckets.set(ip, b); }
  b.n++;
  if (b.n > 60) return res.status(429).json({ error: 'slow down' });
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of rateBuckets) if (now - b.start > 60000) rateBuckets.delete(ip);
}, 60000).unref();

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    build: NET.BUILD,
    rooms: codeRegistry.size,
    uptime: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    node: process.version,
  });
});

/** Diagnostics: what rooms exist right now. Handy when someone says "my code doesn't work". */
app.get('/api/rooms', (req, res) => {
  const out = [];
  for (const [code, roomId] of codeRegistry) {
    const room = matchMaker.getRoomById(roomId);
    if (!room) continue;
    out.push({
      code, roomId, mode: room.mode, phase: room.phase,
      humans: room.state ? room.state.humanCount : 0,
      bots: room.state ? room.state.botCount : 0,
      /* diagnostics: if inputDrops climbs, the server is starving a player of
         their own controls, which is invisible from the client's side */
      inputsIn: room.inputsIn || 0,
      inputDrops: room.inputDrops || 0,
      queueDepth: room.inputQueues.map((q) => q.length),
      simTick: room.match ? room.match.tick : 0,
      inputPops: room.match ? (room.match._pops || 0) : 0,
      uptimeMs: Date.now() - room.createdAt,
    });
  }
  res.json({ rooms: out });
});

/** Create a private room. Returns the 6-character code to share. */
app.post('/api/create', rateLimit, async (req, res) => {
  try {
    const code = allocateCode();
    const { roomId } = await matchMaker.createRoom('brawl', { code, mode: 'rooms' });
    codeRegistry.set(code, roomId);
    res.json({ code, roomId });
  } catch (e) {
    console.error('[create] failed:', e && e.message);
    res.status(500).json({ error: 'could not create a room' });
  }
});

/** Look up a room by its code. */
app.get('/api/find', rateLimit, (req, res) => {
  const code = normaliseCode(req.query.code);
  if (code.length !== NET.CODE_LEN) return res.status(400).json({ error: 'a room code is 6 characters' });
  const roomId = codeRegistry.get(code);
  if (!roomId) return res.status(404).json({ error: 'no room with that code — check it and try again' });
  const room = matchMaker.getRoomById(roomId);
  if (!room) { codeRegistry.delete(code); return res.status(404).json({ error: 'that room has closed' }); }
  res.json({
    code, roomId, mode: room.mode, phase: room.phase,
    humans: room.state ? room.state.humanCount : 0,
    bots: room.state ? room.state.botCount : 0,
  });
});

/**
 * Quick Play. Hands back the oldest room that is still waiting for players,
 * or makes a new one. "Oldest first" is what makes the queue fair.
 */
app.get('/api/quickplay', rateLimit, async (req, res) => {
  try {
    let best = null;
    for (const [code, roomId] of codeRegistry) {
      const room = matchMaker.getRoomById(roomId);
      if (!room || room.mode !== 'quick') continue;
      if (room.phase !== 'lobby') continue;
      if (!room.state || room.state.humanCount >= NET.SLOTS) continue;
      /* oldest first: whoever has been waiting longest gets the next player */
      if (!best || room.createdAt < best.createdAt) best = room;
    }
    if (best) {
      return res.json({ code: best.code, roomId: best.roomId, mode: 'quick', reused: true });
    }
    const code = allocateCode();
    const { roomId } = await matchMaker.createRoom('quickplay', { code, mode: 'quick' });
    codeRegistry.set(code, roomId);
    res.json({ code, roomId, mode: 'quick', reused: false });
  } catch (e) {
    console.error('[quickplay] failed:', e && e.message);
    res.status(500).json({ error: 'matchmaking is unavailable right now' });
  }
});

/* --- the game itself ---
   Served from memory so a deploy can never half-copy the file. Deliberately NOT
   express.static over the project root: that would expose the server source. */
let _gameCache = null;
app.get(['/', '/vibe-brawl.html', '/play'], (req, res) => {
  try {
    if (!_gameCache) _gameCache = fs.readFileSync(GAME_HTML, 'utf8');
    res.type('html').set('Cache-Control', 'no-cache').send(_gameCache);
  } catch (e) {
    res.status(503).send('game file not found at ' + GAME_HTML);
  }
});
app.get('/favicon.ico', (req, res) => res.status(204).end());

/* ------------------------------------------------------------------ *
 * 10. Boot
 * ------------------------------------------------------------------ */

const port = Number(process.env.PORT) || 2567;
const host = process.env.HOST || '0.0.0.0';

const gameServer = new Server({
  transport: new WebSocketTransport({ pingInterval: 5000, pingMaxRetries: 3 }),
});

gameServer.define('brawl', BattleRoom);
gameServer.define('quickplay', QuickPlayRoom);

const httpServer = http.createServer(app);
gameServer.attach({ server: httpServer });

/* Colyseus owns /matchmake and the websocket upgrade; express owns everything else. */
httpServer.listen(port, host, () => {
  console.log(`VIBER BRAWL server ${NET.BUILD} listening on ${host}:${port}`);
  console.log(`  health : http://localhost:${port}/api/health`);
  console.log(`  game   : http://localhost:${port}/`);
});

/* Render sends SIGTERM on redeploy — close cleanly so rooms are not orphaned. */
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  try { gameServer.gracefullyShutdown(false); } catch (e) { /* ignore */ }
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
