import * as THREE from 'three';
import './style.css';
import {
  CAP,
  LIP_Y,
  LIQUID_VOLUME,
  MARBLE_R,
  MARBLE_STOPS,
  OUTLINE,
  SPILL,
  liquidPlane,
  makeProfileTexture,
  sdBottle,
} from './bottle.js';
import { createFizz } from './foam.js';
import { createMarble } from './marble.js';
import { createSound } from './sound.js';
import { BLIT_FRAG, MAX_BUB, MAX_FOAM, TRACE_FRAG, VERT } from './shader.js';

const TARGET = new THREE.Vector3(0, 93, 0);
const CENTER = new THREE.Vector3(0, 93, 0); // 瓶のローカル座標での真ん中。カメラはここを追う
const DIST = 560;
const PITCH = 0.085;
const TURN_PERIOD = 36; // 回転中、瓶がひと回りする秒数
const IDLE_REST = 30; // これだけ触られなければ回転を止めて描画を休む (秒)
const STEP = 1 / 120;

const POP_AT = 2.0; // 玉押しをこれだけ押すとビー玉が外れる (mm)
const PRESS_RATIO = 0.3; // 画面上で 1mm ドラッグすると 0.3mm 押し込む
const TAP_SLOP = 6;

const TILT_MAX = THREE.MathUtils.degToRad(120);
const TILT_PER_PX = 0.0075; // 瓶をつかんで 1px 横に動かしたときの傾き (rad)
const TILT_KEY = THREE.MathUtils.degToRad(100); // ←→ キーを押している間の傾き
const PIVOT = new THREE.Vector3(0, 100, 0); // 手で持つあたり。ここを中心に傾ける
const HOLD_LIFT = 6; // 持ち上げたときに床から浮かせる高さ (mm)

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
const muteButton = document.getElementById('mute');
const tiltButton = document.getElementById('tilt');

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
  uRot: { value: new THREE.Matrix3() },
  uOrigin: { value: new THREE.Vector3() },
  uLightL: { value: new THREE.Vector3(0, 1, 0) },
  uLiq: { value: new THREE.Vector4(0, 1, 0, 118) },
  uMarble: { value: new THREE.Vector4(0, MARBLE_STOPS.seal, 0, MARBLE_R) },
  uPushY: { value: CAP.restY },
  uBub: { value: vec4s(MAX_BUB) },
  uBubN: { value: 0 },
  uFoam: { value: vec4s(MAX_FOAM) },
  uFoamN: { value: 0 },
  uFoamLo: { value: new THREE.Vector3(0, -1e4, 0) },
  uFoamHi: { value: new THREE.Vector3(0, -1e4, 0) },
  uRipple: { value: 0 },
  uHaze: { value: 0 },
  uTime: { value: 0 },
  uColumn: { value: new THREE.Vector3() },
  uContact: { value: 1 },
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
const marble = createMarble();
const sound = createSound();

const st = {
  time: 0,
  open: false,
  push: 0, // 玉押しの押し込み (mm)
  pushV: 0,
  pushTarget: 0,
  volume: LIQUID_VOLUME,
  auto: -1, // 自動で押している時間。-1 なら止まっている
  lastClink: -1,
};

// 照明は固定したまま瓶を軸まわりに回す（左右対称なので、凹みの向きだけが変わる）。
// 最初は凹みを手前と奥に向けておく。左右に傾けると、ビー玉が凹みに引っかからずに転がる。
const view = {
  spin: Math.PI / 2,
  spinGoal: Math.PI / 2,
  pitch: PITCH,
  pitchGoal: PITCH,
  drift: false,
  idle: 0,
  look: TARGET.clone(), // カメラが見ている点
};

// 瓶の姿勢。tilt は画面の右へ傾ける向きが正。held は手で持ち上げている度合い（0〜1）。
const pose = {
  tilt: 0,
  tiltV: 0,
  tiltGoal: 0,
  held: 0,
  heldGoal: 0,
  lift: 0,
  liftV: 0,
  keys: { left: false, right: false },
  sensor: null, // 傾きセンサーの値 (rad)。使っていなければ null
};

// 瓶のローカル座標 → 世界座標。毎ステップ作り直す。
const frame = {
  M: new THREE.Matrix4(),
  inv: new THREE.Matrix4(),
  R: new THREE.Matrix3(),
  up: [0, 1, 0], // 世界の上向きを、瓶のローカル座標で表したもの
  down: [0, -1, 0],
  liqD: 118, // 液面 dot(p, up) = liqD
};
let planeKey = '';

const turning = () => view.drift && view.idle < IDLE_REST && pose.held < 0.01 && Math.abs(pose.tilt) < 0.01;

const pointer = { down: false, mode: null, x: 0, y: 0, startX: 0, startY: 0, startPush: 0, startTilt: 0, moved: 0 };

function reset() {
  st.open = false;
  st.push = 0;
  st.pushV = 0;
  st.pushTarget = 0;
  st.volume = LIQUID_VOLUME;
  st.auto = -1;
  marble.reset();
  fizz.reset();
  sound.setFizz(0, 0, 0);
  sound.setRoll(0);
  sound.thunk();
  updateHint();
  wake();
}

function pop() {
  st.open = true;
  marble.release(180);
  fizz.open(levelOnAxis());
  sound.pop(1);
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

// 液面が軸と交わる高さ（首の泡の層に使う）。
function levelOnAxis() {
  return frame.up[1] > 0.3 ? frame.liqD / frame.up[1] : frame.liqD;
}

// 瓶の姿勢から、ローカル → 世界の変換と、液面を求める。
const _q = new THREE.Quaternion();
const _qs = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _look = new THREE.Vector3();
function updateFrame() {
  _q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -pose.tilt);
  _qs.setFromAxisAngle(new THREE.Vector3(0, 1, 0), view.spin);
  _q.multiply(_qs);
  // M = T(PIVOT + lift) · R · T(-PIVOT)
  frame.M.makeRotationFromQuaternion(_q);
  _v.copy(PIVOT).applyMatrix4(frame.M);
  frame.M.setPosition(PIVOT.x - _v.x, PIVOT.y - _v.y + pose.lift, PIVOT.z - _v.z);
  frame.inv.copy(frame.M).invert();
  frame.R.setFromMatrix4(frame.M);
  const e = frame.R.elements; // 列優先。転置をかける = 行ベクトルとして読む
  frame.up = [e[1], e[4], e[7]];
  frame.down = [-e[1], -e[4], -e[7]];

  // 液面は、液の体積が変わらない水平な面。向きか量が変わったときだけ解き直す。
  const key = `${frame.up.map((x) => x.toFixed(4)).join()}|${st.volume.toFixed(0)}`;
  if (key !== planeKey) {
    planeKey = key;
    frame.liqD = liquidPlane(frame.up, st.volume);
  }
}

// 傾けたときに床へめり込まない持ち上げ量。
function neededLift(tilt) {
  const s = Math.abs(Math.sin(tilt));
  const c = Math.cos(tilt);
  let lowest = Infinity;
  for (const [r, y] of OUTLINE) lowest = Math.min(lowest, PIVOT.y - r * s + (y - PIVOT.y) * c);
  return Math.max(0, -lowest);
}

function simulate(dt) {
  st.time += dt;

  if (st.auto >= 0) {
    st.auto += dt;
    st.pushTarget = sample(AUTO_PRESS, st.auto);
    if (st.auto > AUTO_PRESS[AUTO_PRESS.length - 1][0]) st.auto = -1;
  }

  // 玉押しは目標の押し込みへ素早く追いつくバネ。
  {
    const k = 900;
    const c = 2 * Math.sqrt(k);
    const before = st.push;
    st.pushV += (k * (st.pushTarget - st.push) - c * st.pushV) * dt;
    st.push = Math.min(Math.max(st.push + st.pushV * dt, 0), CAP.maxPush);
    if (before < 0.3 && st.push >= 0.3) sound.click();
  }

  // 傾き：つかむ／キー／センサーで目標を決め、少し揺れながら追いつく。
  let goal = 0;
  let holding = false;
  if (pointer.mode === 'tilt') {
    goal = pose.tiltGoal;
    holding = true;
  } else if (pose.keys.left !== pose.keys.right) {
    goal = pose.keys.right ? TILT_KEY : -TILT_KEY;
    holding = true;
  } else if (pose.sensor !== null && Math.abs(pose.sensor) > 0.05) {
    goal = pose.sensor;
    holding = true;
  }
  pose.tiltGoal = goal;
  pose.heldGoal = holding ? 1 : 0;
  {
    const k = 55;
    const c = 2 * Math.sqrt(k) * (holding ? 1 : 0.55);
    pose.tiltV += (k * (goal - pose.tilt) - c * pose.tiltV) * dt;
    pose.tilt += pose.tiltV * dt;
  }
  pose.held += (pose.heldGoal - pose.held) * (1 - Math.exp(-dt * 10));
  {
    // 持ち上げ量は、床にめり込まない高さへ素早く、置くときはストンと。
    const want = neededLift(pose.tilt) + HOLD_LIFT * pose.held;
    const before = pose.liftV;
    if (want >= pose.lift) {
      pose.lift = want;
      pose.liftV = 0;
    } else {
      pose.liftV -= 9810 * dt * 0.25;
      pose.lift = Math.max(want, pose.lift + pose.liftV * dt);
      if (pose.lift <= want + 1e-3) {
        if (pose.lift < 0.5 && before < -30) sound.thunk();
        pose.liftV = 0;
      }
    }
  }

  updateFrame();

  if (!st.open) {
    // 開ける前のビー玉は、ガス圧で口に押し付けられ、玉押しといっしょに少し沈むだけ。
    marble.hold(MARBLE_STOPS.seal - st.push);
    if (st.push >= POP_AT) pop();
  }
  const up = frame.up;
  const d = frame.liqD;
  const impact = marble.step(dt, frame.down, {
    inLiquid: (p) => p[0] * up[0] + p[1] * up[1] + p[2] * up[2] < d,
    pusherY: CAP.restY - st.push,
  });
  if (impact > 50) {
    // 細かな当たりが続くときは鳴らしすぎない。
    const v = Math.min(1, impact / 800);
    if (st.time - st.lastClink > 0.05 || v > 0.5) {
      sound.clink(v);
      st.lastClink = st.time;
    }
  }

  if (st.open) st.volume = LIQUID_VOLUME - SPILL * (1 - Math.exp(-fizz.since / 1.3));

  fizz.step(dt, { up, liqD: d, level: levelOnAxis() });

  view.idle += dt;
  if (turning() && pointer.mode !== 'orbit') view.spinGoal += (dt / TURN_PERIOD) * Math.PI * 2;
  const ease = 1 - Math.exp(-dt * 8);
  view.spin += (view.spinGoal - view.spin) * ease;
  view.pitch += (view.pitchGoal - view.pitch) * ease;
  view.look.lerp(lookGoal(_v), 1 - Math.exp(-dt * 4));
}

// 傾けた瓶が画面からはみ出さないよう、カメラはゆっくり瓶の真ん中を追う。
function lookGoal(out) {
  out.copy(CENTER).applyMatrix4(frame.M);
  out.y = TARGET.y + (out.y - TARGET.y) * 0.8;
  return out;
}

function isMoving() {
  return (
    turning() ||
    pointer.mode === 'orbit' ||
    pointer.mode === 'tilt' ||
    Math.abs(view.spin - view.spinGoal) > 1e-4 ||
    Math.abs(view.pitch - view.pitchGoal) > 1e-4 ||
    view.look.distanceTo(lookGoal(_look)) > 0.05 ||
    Math.abs(pose.tilt - pose.tiltGoal) > 1e-4 ||
    Math.abs(pose.tiltV) > 1e-3 ||
    Math.abs(pose.held - pose.heldGoal) > 1e-3 ||
    pose.liftV !== 0 ||
    st.auto >= 0 ||
    Math.abs(st.push - st.pushTarget) > 1e-3 ||
    Math.abs(st.pushV) > 1e-2 ||
    marble.moving ||
    fizz.active()
  );
}

// ---------------------------------------------------------------- カメラと描画

const size = { w: 1, h: 1, ratio: 1 };
let scale = 0.6;

function cameraFrame() {
  const cp = Math.cos(view.pitch);
  const at = view.look;
  const pos = new THREE.Vector3(at.x, at.y + DIST * Math.sin(view.pitch), at.z + DIST * cp);
  const fwd = at.clone().sub(pos).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd);
  const aspect = size.w / size.h;
  const tanHalf = Math.max(118 / DIST, 74 / (DIST * aspect));
  return { pos, fwd, right, up, tanHalf, aspect };
}

function updateUniforms() {
  updateFrame(); // リセット直後など、シミュレーションを挟まずに描くときも姿勢と液面をそろえる
  const cam = cameraFrame();
  uniforms.uCamPos.value.copy(cam.pos);
  uniforms.uCamBasis.value.set(
    cam.right.x, cam.up.x, cam.fwd.x,
    cam.right.y, cam.up.y, cam.fwd.y,
    cam.right.z, cam.up.z, cam.fwd.z,
  );
  uniforms.uTanHalf.value = cam.tanHalf;

  uniforms.uRot.value.copy(frame.R);
  uniforms.uOrigin.value.setFromMatrixPosition(frame.M);
  uniforms.uLightL.value.copy(LIGHT).applyMatrix3(frame.R.clone().transpose());
  uniforms.uLiq.value.set(frame.up[0], frame.up[1], frame.up[2], frame.liqD);
  uniforms.uContact.value = Math.exp(-pose.lift / 3);

  const m = marble.pos;
  uniforms.uMarble.value.set(m[0], m[1], m[2], MARBLE_R);
  uniforms.uPushY.value = CAP.restY - st.push;
  uniforms.uRipple.value = Math.min(fizz.pressure * 1.6, 1) + (fizz.bubbles.length ? 0.08 : 0) + Math.min(Math.abs(pose.tiltV) * 0.15, 0.6);
  uniforms.uTime.value = st.time;
  // 首の泡の層は、瓶がほぼ立っているときだけ。
  const col = fizz.column(levelOnAxis());
  if (frame.up[1] < 0.9) col[2] = 0;
  uniforms.uColumn.value.fromArray(col);
  uniforms.uHaze.value = fizz.haze();

  const bub = uniforms.uBub.value;
  fizz.bubbles.forEach((b, i) => bub[i].set(b.x, b.y, b.z, b.r));
  uniforms.uBubN.value = fizz.bubbles.length;

  const foam = uniforms.uFoam.value;
  const lo = uniforms.uFoamLo.value.set(Infinity, Infinity, Infinity);
  const hi = uniforms.uFoamHi.value.set(-Infinity, -Infinity, -Infinity);
  let n = 0;
  for (const b of fizz.foam) {
    if (b.r <= 0.05) continue;
    // w には 半径×100 の整数部と、泡らしさの小数部を詰める。
    foam[n++].set(b.x, b.y, b.z, Math.floor(b.r * 100) + Math.min(Math.max(b.f, 0), 0.99));
    const pad = b.r + 3;
    lo.min(_v.set(b.x - pad, b.y - pad, b.z - pad));
    hi.max(_v.set(b.x + pad, b.y + pad, b.z + pad));
  }
  uniforms.uFoamN.value = n;
  if (!n) {
    lo.set(0, -1e4, 0);
    hi.set(0, -1e4, 0);
  }
  return cam;
}

// シェーダーのキーライトと同じ向き（床の影もこの向きに落ちる）。
const LIGHT = new THREE.Vector3(Math.sin(-0.85) * Math.cos(0.75), Math.sin(0.75), Math.cos(-0.85) * Math.cos(0.75));

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

  updateLoopSound();

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
    sound.setRoll(0);
    render(1);
    stillDrawn = true;
  }
}

function updateLoopSound() {
  const overflow = Math.min(1, fizz.foam.filter((b) => b.f > 0.5).length / 24);
  // ポンとカランを聞かせてから、シュワシュワを立ち上げる。
  const onset = Math.min(Math.max((fizz.since - 0.12) / 0.3, 0), 1);
  sound.setFizz(fizz.pressure * onset, fizz.trail * Math.min(1, fizz.bubbles.length / 24), overflow);
  sound.setRoll(marble.rolling);
}

// ---------------------------------------------------------------- 入力

function pointerRay(px, py) {
  const cam = cameraFrame();
  const ndcX = (px / window.innerWidth) * 2 - 1;
  const ndcY = 1 - (py / window.innerHeight) * 2;
  const dir = cam.fwd
    .clone()
    .addScaledVector(cam.right, ndcX * cam.tanHalf * cam.aspect)
    .addScaledVector(cam.up, ndcY * cam.tanHalf)
    .normalize();
  return { cam, dir };
}

// キャップのあたりを押したかどうか（画面上の位置で判定。瓶が立っているときだけ）。
function overCap(px, py) {
  if (Math.abs(pose.tilt) > 0.05 || pose.held > 0.05) return false;
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

// 瓶そのもの（キャップを含む）を指しているか。瓶のローカル座標で距離場をたどる。
function overBottle(px, py) {
  const { cam, dir } = pointerRay(px, py);
  const o = cam.pos.clone().applyMatrix4(frame.inv);
  const d = dir.clone().applyMatrix3(frame.R.clone().transpose());
  const top = CAP.restY + CAP.stemH + CAP.buttonH;
  let t = 0;
  for (let i = 0; i < 160 && t < 1400; i++) {
    const x = o.x + d.x * t;
    const y = o.y + d.y * t;
    const z = o.z + d.z * t;
    const r = Math.hypot(x, z);
    const cap = Math.max(r - CAP.collarRo, LIP_Y - 8 - y, y - top);
    const dist = Math.min(sdBottle(x, y, z)[0], cap);
    if (dist < 2) return true;
    t += Math.max(dist * 0.9, 0.5);
  }
  return false;
}

function pxPerMm() {
  const cam = cameraFrame();
  return window.innerHeight / 2 / (cam.tanHalf * DIST);
}

function cursorFor(x, y) {
  if (overCap(x, y)) return 'pointer';
  return 'grab';
}

canvas.addEventListener('pointerdown', (e) => {
  sound.unlock();
  canvas.setPointerCapture(e.pointerId);
  pointer.down = true;
  pointer.x = pointer.startX = e.clientX;
  pointer.y = pointer.startY = e.clientY;
  pointer.moved = 0;
  if (overCap(e.clientX, e.clientY) && st.auto < 0) {
    pointer.mode = 'press';
    pointer.startPush = st.pushTarget;
  } else if (overBottle(e.clientX, e.clientY)) {
    pointer.mode = 'tilt';
    pointer.startTilt = pose.tilt;
    pose.tiltGoal = pose.tilt;
    canvas.style.cursor = 'grabbing';
  } else {
    pointer.mode = 'orbit';
  }
  wake();
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointer.down) {
    canvas.style.cursor = cursorFor(e.clientX, e.clientY);
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
  } else if (pointer.mode === 'tilt') {
    const goal = pointer.startTilt + (e.clientX - pointer.startX) * TILT_PER_PX;
    pose.tiltGoal = Math.min(Math.max(goal, -TILT_MAX), TILT_MAX);
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
  canvas.style.cursor = cursorFor(e.clientX, e.clientY);
  wake();
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    pose.keys[e.key === 'ArrowLeft' ? 'left' : 'right'] = true;
    e.preventDefault();
    sound.unlock();
    wake();
    return;
  }
  if (e.repeat) return;
  sound.unlock();
  if (e.key === 'p' || e.key === 'P' || e.key === 'Enter') startAutoPress();
  else if (e.key === 'r' || e.key === 'R') reset();
  else if (e.key === 'm' || e.key === 'M') toggleMute();
  else if (e.key === ' ') {
    view.drift = !view.drift;
    e.preventDefault();
  } else return;
  wake();
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    pose.keys[e.key === 'ArrowLeft' ? 'left' : 'right'] = false;
    wake();
  }
});

window.addEventListener('blur', () => {
  pose.keys.left = pose.keys.right = false;
  wake();
});

window.addEventListener('resize', resize);
again.addEventListener('click', () => {
  sound.unlock();
  reset();
});
muteButton.addEventListener('click', () => {
  sound.unlock();
  toggleMute();
});

function toggleMute() {
  sound.toggleMute();
  updateMuteButton();
}

function updateMuteButton() {
  muteButton.setAttribute('aria-pressed', String(sound.muted));
  muteButton.setAttribute('aria-label', sound.muted ? '音を出す' : '音を消す');
  muteButton.dataset.muted = String(sound.muted);
}

// ---------------------------------------------------------------- 傾きセンサー（スマホ）

// スマホを左右に傾けると、瓶も同じだけ傾く。
function onOrientation(e) {
  if (e.gamma === null) return;
  const angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  let deg = e.gamma;
  if (angle === 90) deg = e.beta;
  else if (angle === -90 || angle === 270) deg = -e.beta;
  pose.sensor = Math.min(Math.max(THREE.MathUtils.degToRad(deg) * 1.2, -TILT_MAX), TILT_MAX);
  wake();
}

async function toggleSensor() {
  if (pose.sensor !== null) {
    window.removeEventListener('deviceorientation', onOrientation);
    pose.sensor = null;
  } else {
    // iPhone は、タップの中で許可をもらう必要がある。
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      try {
        if ((await DOE.requestPermission()) !== 'granted') return;
      } catch {
        return;
      }
    }
    pose.sensor = 0;
    window.addEventListener('deviceorientation', onOrientation);
  }
  tiltButton.setAttribute('aria-pressed', String(pose.sensor !== null));
  wake();
}

if ('DeviceOrientationEvent' in window && matchMedia('(hover: none)').matches) {
  tiltButton.hidden = false;
  tiltButton.addEventListener('click', () => {
    sound.unlock();
    toggleSensor();
  });
}

// 裏のタブに回ったら音を止める（描画も止まるので、シュワシュワが鳴りっぱなしにならないように）。
document.addEventListener('visibilitychange', () => {
  if (document.hidden) sound.pause();
  else {
    sound.resume();
    wake();
  }
});

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
  // 瓶を持って傾ける（deg）。null で手を離す。
  tilt(deg) {
    pose.keys.left = pose.keys.right = false;
    if (deg === null) {
      pose.sensor = null;
    } else {
      pose.sensor = THREE.MathUtils.degToRad(deg);
    }
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
  overBottle,
  state: () => ({
    open: st.open,
    push: +st.push.toFixed(3),
    marble: marble.pos.map((x) => +x.toFixed(2)),
    tilt: +THREE.MathUtils.radToDeg(pose.tilt).toFixed(1),
    lift: +pose.lift.toFixed(2),
    liqD: +frame.liqD.toFixed(2),
    volumeMl: +(st.volume / 1000).toFixed(2),
    pressure: +fizz.pressure.toFixed(3),
    bubbles: fizz.bubbles.length,
    foam: fizz.foam.length,
    moving: isMoving(),
  }),
};

updateFrame();
updateHint();
updateMuteButton();
resize();
if (testMode) render(1);
