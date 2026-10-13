import * as THREE from 'three';
import './style.css';
import { CAP, LEVEL, MARBLE_R, MARBLE_STOPS, SPILL, makeProfileTexture } from './bottle.js';
import { createFizz } from './foam.js';
import { BLIT_FRAG, MAX_BUB, MAX_FOAM, TRACE_FRAG, VERT } from './shader.js';

const TARGET = new THREE.Vector3(0, 93, 0);
const DIST = 560;
const PITCH = 0.085;
const TURN_PERIOD = 36; // 回転中、瓶がひと回りする秒数
const IDLE_REST = 30; // これだけ触られなければ回転を止めて描画を休む (秒)
const STEP = 1 / 120;

const POP_AT = 2.0; // 玉押しをこれだけ押すとビー玉が外れる (mm)
const GRAVITY = 6000; // ちょっとだけゆっくり落とす (mm/s²)
const BOUNCE = 0.38;
const PRESS_RATIO = 0.3; // 画面上で 1mm ドラッグすると 0.3mm 押し込む
const TAP_SLOP = 6;

// 自動で押すときの動き [秒, 押し込み mm]。
const AUTO_PRESS = [
  [0, 0],
  [0.22, 1.4],
  [0.34, POP_AT + 0.4],
  [0.5, CAP.maxPush],
  [1.6, CAP.maxPush],
  [2.0, 0],
];

const params = new URLSearchParams(location.search);
const testMode = params.has('test');

const canvas = document.getElementById('stage');
const hint = document.getElementById('hint');
const errorBox = document.getElementById('error');
const again = document.getElementById('again');

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
} catch (e) {
  errorBox.hidden = false;
  throw e;
}
renderer.setPixelRatio(1);
renderer.autoClear = false;

const quad = new THREE.PlaneGeometry(2, 2);
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

const vec4s = (n) => Array.from({ length: n }, () => new THREE.Vector4());
const uniforms = {
  uRes: { value: new THREE.Vector2(1, 1) },
  uCamPos: { value: new THREE.Vector3() },
  uCamBasis: { value: new THREE.Matrix3() },
  uTanHalf: { value: 0.2 },
  uProf: { value: makeProfileTexture() },
  uMarble: { value: new THREE.Vector4(0, MARBLE_STOPS.seal, 0, MARBLE_R) },
  uLevel: { value: LEVEL },
  uPushY: { value: CAP.restY },
  uBub: { value: vec4s(MAX_BUB) },
  uBubN: { value: 0 },
  uFoam: { value: vec4s(MAX_FOAM) },
  uFoamN: { value: 0 },
  uFoamLo: { value: new THREE.Vector3(0, -1e4, 0) },
  uFoamHi: { value: new THREE.Vector3(0, -1e4, 0) },
  uRipple: { value: 0 },
  uTime: { value: 0 },
  uSpin: { value: new THREE.Vector2(1, 0) },
  uColumn: { value: new THREE.Vector3() },
};

const traceMat = new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: VERT,
  fragmentShader: TRACE_FRAG,
  uniforms,
  depthTest: false,
  depthWrite: false,
});
const traceScene = new THREE.Scene();
traceScene.add(new THREE.Mesh(quad, traceMat));

const target = new THREE.WebGLRenderTarget(1, 1, {
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  depthBuffer: false,
});
const blitMat = new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: VERT,
  fragmentShader: BLIT_FRAG,
  uniforms: { uTex: { value: target.texture }, uRes: { value: new THREE.Vector2(1, 1) } },
  depthTest: false,
  depthWrite: false,
});
const blitScene = new THREE.Scene();
blitScene.add(new THREE.Mesh(quad, blitMat));

// ---------------------------------------------------------------- 状態

const fizz = createFizz();

const st = {
  time: 0,
  open: false,
  push: 0, // 玉押しの押し込み (mm)
  pushV: 0,
  pushTarget: 0,
  marbleY: MARBLE_STOPS.seal,
  marbleV: 0,
  marbleFalling: false,
  level: LEVEL,
  auto: -1, // 自動で押している時間。-1 なら止まっている
};

// 照明は固定したまま瓶を軸まわりに回す（左右対称なので、凹みの向きだけが変わる）。
const view = {
  spin: 0,
  spinGoal: 0,
  pitch: PITCH,
  pitchGoal: PITCH,
  drift: true,
  idle: 0,
};

const turning = () => view.drift && view.idle < IDLE_REST;

const pointer = { down: false, mode: null, x: 0, y: 0, startX: 0, startY: 0, startPush: 0, moved: 0 };

function reset() {
  st.open = false;
  st.push = 0;
  st.pushV = 0;
  st.pushTarget = 0;
  st.marbleY = MARBLE_STOPS.seal;
  st.marbleV = 0;
  st.marbleFalling = false;
  st.level = LEVEL;
  st.auto = -1;
  fizz.reset();
  updateHint();
  wake();
}

function pop() {
  st.open = true;
  st.marbleFalling = true;
  st.marbleV = -180;
  fizz.open();
  updateHint();
}

function startAutoPress() {
  if (st.auto >= 0) return;
  st.auto = 0;
  wake();
}

function sample(frames, t) {
  if (t <= frames[0][0]) return frames[0][1];
  for (let i = 0; i < frames.length - 1; i++) {
    const [t0, v0] = frames[i];
    const [t1, v1] = frames[i + 1];
    if (t <= t1) {
      const u = (t - t0) / (t1 - t0);
      return v0 + (v1 - v0) * u * u * (3 - 2 * u);
    }
  }
  return frames[frames.length - 1][1];
}

function simulate(dt) {
  st.time += dt;

  if (st.auto >= 0) {
    st.auto += dt;
    st.pushTarget = sample(AUTO_PRESS, st.auto);
    if (st.auto > AUTO_PRESS[AUTO_PRESS.length - 1][0]) st.auto = -1;
  }

  // 玉押しは目標の押し込みへ素早く追いつくバネ。
  const k = 900;
  const c = 2 * Math.sqrt(k);
  st.pushV += (k * (st.pushTarget - st.push) - c * st.pushV) * dt;
  st.push = Math.min(Math.max(st.push + st.pushV * dt, 0), CAP.maxPush);

  if (!st.open) {
    // 開ける前のビー玉は玉押しといっしょに少し沈む（ゴムがつぶれる）。
    st.marbleY = MARBLE_STOPS.seal - st.push;
    if (st.push >= POP_AT) pop();
  } else if (st.marbleFalling) {
    st.marbleV -= GRAVITY * dt;
    st.marbleY += st.marbleV * dt;
    if (st.marbleY <= MARBLE_STOPS.rest) {
      st.marbleY = MARBLE_STOPS.rest;
      st.marbleV = -st.marbleV * BOUNCE;
      if (st.marbleV < 40) {
        st.marbleV = 0;
        st.marbleFalling = false;
      }
    }
  }
  // 玉押しより上にビー玉は行けない。
  st.marbleY = Math.min(st.marbleY, CAP.restY - st.push - MARBLE_R);

  if (st.open) st.level = LEVEL - SPILL * (1 - Math.exp(-fizz.since / 1.3));

  fizz.step(dt, { level: st.level, marble: { x: 0, y: st.marbleY, z: 0, r: MARBLE_R } });

  view.idle += dt;
  if (turning() && pointer.mode !== 'orbit') view.spinGoal += (dt / TURN_PERIOD) * Math.PI * 2;
  const ease = 1 - Math.exp(-dt * 8);
  view.spin += (view.spinGoal - view.spin) * ease;
  view.pitch += (view.pitchGoal - view.pitch) * ease;
}

function isMoving() {
  return (
    turning() ||
    pointer.mode === 'orbit' ||
    Math.abs(view.spin - view.spinGoal) > 1e-4 ||
    Math.abs(view.pitch - view.pitchGoal) > 1e-4 ||
    st.auto >= 0 ||
    Math.abs(st.push - st.pushTarget) > 1e-3 ||
    Math.abs(st.pushV) > 1e-2 ||
    st.marbleFalling ||
    fizz.active()
  );
}

// ---------------------------------------------------------------- カメラと描画

const size = { w: 1, h: 1, ratio: 1 };
let scale = 0.6;

function cameraFrame() {
  const cp = Math.cos(view.pitch);
  const pos = new THREE.Vector3(
    TARGET.x,
    TARGET.y + DIST * Math.sin(view.pitch),
    TARGET.z + DIST * cp,
  );
  const fwd = TARGET.clone().sub(pos).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd);
  const aspect = size.w / size.h;
  const tanHalf = Math.max(118 / DIST, 74 / (DIST * aspect));
  return { pos, fwd, right, up, tanHalf, aspect };
}

function updateUniforms() {
  const cam = cameraFrame();
  uniforms.uCamPos.value.copy(cam.pos);
  uniforms.uCamBasis.value.set(
    cam.right.x, cam.up.x, cam.fwd.x,
    cam.right.y, cam.up.y, cam.fwd.y,
    cam.right.z, cam.up.z, cam.fwd.z,
  );
  uniforms.uTanHalf.value = cam.tanHalf;
  uniforms.uMarble.value.set(0, st.marbleY, 0, MARBLE_R);
  uniforms.uLevel.value = st.level;
  uniforms.uPushY.value = CAP.restY - st.push;
  uniforms.uRipple.value = Math.min(fizz.pressure * 1.6, 1) + (fizz.bubbles.length ? 0.08 : 0);
  uniforms.uTime.value = st.time;
  uniforms.uSpin.value.set(Math.cos(view.spin), Math.sin(view.spin));
  uniforms.uColumn.value.fromArray(fizz.column(st.level));

  const bub = uniforms.uBub.value;
  fizz.bubbles.forEach((b, i) => bub[i].set(b.x, b.y, b.z, b.r));
  uniforms.uBubN.value = fizz.bubbles.length;

  const foam = uniforms.uFoam.value;
  const lo = uniforms.uFoamLo.value.set(Infinity, Infinity, Infinity);
  const hi = uniforms.uFoamHi.value.set(-Infinity, -Infinity, -Infinity);
  let n = 0;
  for (const b of fizz.foam) {
    if (b.r <= 0.05) continue;
    foam[n++].set(b.x, b.y, b.z, b.r);
    const pad = b.r + 3;
    lo.min(new THREE.Vector3(b.x - pad, b.y - pad, b.z - pad));
    hi.max(new THREE.Vector3(b.x + pad, b.y + pad, b.z + pad));
  }
  uniforms.uFoamN.value = n;
  if (!n) {
    lo.set(0, -1e4, 0);
    hi.set(0, -1e4, 0);
  }
  return cam;
}

function resize() {
  size.ratio = Math.min(window.devicePixelRatio || 1, 2);
  size.w = Math.max(1, Math.round(window.innerWidth * size.ratio));
  size.h = Math.max(1, Math.round(window.innerHeight * size.ratio));
  renderer.setSize(size.w, size.h, false);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  stillDrawn = false;
  wake();
}

function render(s) {
  updateUniforms();
  const w = Math.max(1, Math.round(size.w * s));
  const h = Math.max(1, Math.round(size.h * s));
  if (s >= 0.999) {
    uniforms.uRes.value.set(size.w, size.h);
    renderer.setRenderTarget(null);
    renderer.setViewport(0, 0, size.w, size.h);
    renderer.render(traceScene, orthoCam);
    return;
  }
  if (target.width !== w || target.height !== h) target.setSize(w, h);
  uniforms.uRes.value.set(w, h);
  renderer.setRenderTarget(target);
  renderer.render(traceScene, orthoCam);
  renderer.setRenderTarget(null);
  blitMat.uniforms.uRes.value.set(size.w, size.h);
  renderer.render(blitScene, orthoCam);
}

// ---------------------------------------------------------------- ループ

let raf = 0;
let last = 0;
let acc = 0;
let stillDrawn = false;
let frameAvg = 1 / 60;
let frames = 0;

function wake() {
  stillDrawn = false;
  view.idle = 0;
  if (testMode || raf) return;
  last = performance.now();
  raf = requestAnimationFrame(tick);
}

function tick(now) {
  raf = 0;
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  acc += dt;
  while (acc >= STEP) {
    simulate(STEP);
    acc -= STEP;
  }

  if (isMoving()) {
    // 重いときは解像度を下げ、余裕があれば戻す。
    frameAvg += (dt - frameAvg) * 0.1;
    if (++frames % 12 === 0) {
      if (frameAvg > 1 / 40) scale = Math.max(0.3, scale - 0.05);
      else if (frameAvg < 1 / 55) scale = Math.min(1, scale + 0.05);
    }
    render(scale);
    raf = requestAnimationFrame(tick);
  } else if (!stillDrawn) {
    // 止まったら、いちばんきれいな 1 枚を描いて休む。
    render(1);
    stillDrawn = true;
  }
}

// ---------------------------------------------------------------- 入力

// キャップのあたりを押したかどうか（画面上の位置で判定）。
function overCap(px, py) {
  const cam = cameraFrame();
  const project = (x, y, z) => {
    const v = new THREE.Vector3(x, y, z).sub(cam.pos);
    const zc = v.dot(cam.fwd);
    return [v.dot(cam.right) / (zc * cam.tanHalf * cam.aspect), v.dot(cam.up) / (zc * cam.tanHalf)];
  };
  const ndcX = (px / window.innerWidth) * 2 - 1;
  const ndcY = 1 - (py / window.innerHeight) * 2;
  const [cx, top] = project(0, CAP.restY + CAP.stemH + 6, 0);
  const [, bottom] = project(0, CAP.collarY0 - 6, 0);
  const [ex] = project(CAP.collarRo + 8, (CAP.collarY0 + CAP.restY) / 2, 0);
  const half = Math.abs(ex - cx);
  return Math.abs(ndcX - cx) < half && ndcY < top && ndcY > bottom;
}

function pxPerMm() {
  const cam = cameraFrame();
  return window.innerHeight / 2 / (cam.tanHalf * DIST);
}

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointer.down = true;
  pointer.x = pointer.startX = e.clientX;
  pointer.y = pointer.startY = e.clientY;
  pointer.moved = 0;
  if (overCap(e.clientX, e.clientY) && st.auto < 0) {
    pointer.mode = 'press';
    pointer.startPush = st.pushTarget;
  } else {
    pointer.mode = 'orbit';
  }
  wake();
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointer.down) {
    canvas.style.cursor = overCap(e.clientX, e.clientY) ? 'pointer' : 'grab';
    return;
  }
  const dx = e.clientX - pointer.x;
  const dy = e.clientY - pointer.y;
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  pointer.moved = Math.max(pointer.moved, Math.hypot(e.clientX - pointer.startX, e.clientY - pointer.startY));
  if (pointer.mode === 'press') {
    const down = ((e.clientY - pointer.startY) / pxPerMm()) * PRESS_RATIO;
    st.pushTarget = Math.min(Math.max(pointer.startPush + down, 0), CAP.maxPush);
  } else if (pointer.mode === 'orbit') {
    canvas.style.cursor = 'grabbing';
    view.spinGoal += dx * 0.01;
    view.pitchGoal = Math.min(Math.max(view.pitchGoal + dy * 0.003, -0.02), 0.5);
  }
  wake();
});

function endPointer(e) {
  if (!pointer.down) return;
  pointer.down = false;
  if (pointer.mode === 'press') {
    if (pointer.moved < TAP_SLOP) startAutoPress();
    else st.pushTarget = 0;
  }
  pointer.mode = null;
  canvas.style.cursor = overCap(e.clientX, e.clientY) ? 'pointer' : 'grab';
  wake();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.key === 'p' || e.key === 'P' || e.key === 'Enter') startAutoPress();
  else if (e.key === 'r' || e.key === 'R') reset();
  else if (e.key === ' ') {
    view.drift = !view.drift;
    e.preventDefault();
  } else return;
  wake();
});

window.addEventListener('resize', resize);
again.addEventListener('click', () => reset());

function updateHint() {
  hint.dataset.state = st.open ? 'open' : 'sealed';
}

// ---------------------------------------------------------------- テスト用の入口

window.__ramune = {
  press: startAutoPress,
  reset,
  hold(mm) {
    st.pushTarget = Math.min(Math.max(mm, 0), CAP.maxPush);
  },
  release() {
    st.pushTarget = 0;
  },
  advance(sec) {
    const n = Math.round(sec / STEP);
    for (let i = 0; i < n; i++) simulate(STEP);
  },
  view(spin, pitch = PITCH) {
    view.drift = false;
    view.spin = view.spinGoal = spin;
    view.pitch = view.pitchGoal = pitch;
  },
  render(s = 1) {
    render(s);
    renderer.getContext().finish();
  },
  state: () => ({
    open: st.open,
    push: +st.push.toFixed(3),
    marbleY: +st.marbleY.toFixed(2),
    level: +st.level.toFixed(2),
    pressure: +fizz.pressure.toFixed(3),
    bubbles: fizz.bubbles.length,
    foam: fizz.foam.length,
    moving: isMoving(),
  }),
};

updateHint();
resize();
if (testMode) render(1);
