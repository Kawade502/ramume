import * as THREE from 'three';

// 寸法はすべてミリメートル。y は底面からの高さ、r は中心軸からの半径。
// 200ml の昔ながらのラムネ瓶をもとにした形。

// 外側の輪郭 [r, y]。下から口まで。
const OUTER = [
  [26.0, 0],
  [28.3, 2],
  [29.0, 5],
  [29.1, 12],
  [28.7, 50],
  [29.1, 86],
  [28.4, 98],
  [26.0, 107],
  [22.0, 115],
  [17.8, 121.5],
  [15.0, 126.5],
  [14.0, 130],
  [14.8, 134.5],
  [16.4, 139.5],
  [17.1, 145],
  [16.6, 150],
  [15.0, 155],
  [13.6, 160],
  [12.9, 165],
  [12.7, 170],
];

// 内側の輪郭 [r, y]。口の内径 (7.7) がビー玉の半径 (8.5) より細いので、ビー玉が栓になる。
const INNER = [
  [26.4, 0],
  [26.6, 7],
  [26.7, 12],
  [26.3, 50],
  [26.7, 86],
  [26.0, 98],
  [23.6, 107],
  [19.6, 115],
  [15.4, 121.5],
  [12.6, 126.5],
  [11.6, 130],
  [12.4, 134.5],
  [14.0, 139.5],
  [14.7, 145],
  [14.2, 150],
  [12.4, 155],
  [10.6, 158.5],
  [9.2, 162],
  [8.0, 165.5],
  [7.7, 168],
  [7.7, 170],
];

export const LIP_Y = 170;

// 口の縁は丸いビード（トーラス）で閉じる。
const LIP_RO = OUTER[OUTER.length - 1][0];
const LIP_RI = INNER[INNER.length - 1][0];
export const LIP = { y: LIP_Y, rc: (LIP_RO + LIP_RI) / 2, rt: (LIP_RO - LIP_RI) / 2 };

// くびれの左右にある 2 つの凹み。開けたビー玉はここで止まる。
export const DIMPLE = { y: 130, w: 3.6, depth: 5.4 };

// 底：外側はわずかに上げ底、内側は縁に向かってせり上がる厚いガラス。
export const BASE = { punt: 1.0, puntR: 22, innerY: 7, innerRise: 2.5, innerR: 26.6 };

export const MARBLE_R = 8.5;
export const LEVEL = 118;
export const SPILL = 5;

// 青いキャップ。口を囲むリングと、ビー玉を押し込む玉押し。
export const CAP = {
  collarY0: 165,
  collarY1: 176.5,
  collarTopRi: 9,
  stemR: 6,
  stemH: 11,
  buttonR: 11.5,
  buttonH: 3.4,
};

export const PROFILE_N = 1024;

// 単調な 3 次エルミート補間。行き過ぎ（オーバーシュート）しないので、
// 輪郭が制御点の間で膨らまない。y から [r, dr/dy] を返す。
function profileCurve(points) {
  const ys = points.map((p) => p[1]);
  const rs = points.map((p) => p[0]);
  const n = points.length;
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((rs[i + 1] - rs[i]) / (ys[i + 1] - ys[i]));
  const m = new Array(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : 2 / (1 / d[i - 1] + 1 / d[i]);

  return (y) => {
    if (y <= ys[0]) return [rs[0] + m[0] * (y - ys[0]), m[0]];
    if (y >= ys[n - 1]) return [rs[n - 1], 0];
    let i = 0;
    while (y > ys[i + 1]) i++;
    const h = ys[i + 1] - ys[i];
    const t = (y - ys[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const r =
      (2 * t3 - 3 * t2 + 1) * rs[i] +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * rs[i + 1] +
      (t3 - t2) * h * m[i + 1];
    const dr =
      ((6 * t2 - 6 * t) * rs[i] +
        (3 * t2 - 4 * t + 1) * h * m[i] +
        (-6 * t2 + 6 * t) * rs[i + 1] +
        (3 * t2 - 2 * t) * h * m[i + 1]) /
      h;
    return [r, dr];
  };
}

const outerAt = profileCurve(OUTER);
const innerAt = profileCurve(INNER);

// 輪郭を細かくサンプルした表。シェーダーと CPU 側で同じ値を使う。
const table = new Float32Array(PROFILE_N * 4);
for (let i = 0; i < PROFILE_N; i++) {
  const y = (i / (PROFILE_N - 1)) * LIP_Y;
  const [ro, dro] = outerAt(y);
  const [ri, dri] = innerAt(y);
  table.set([ro, dro, ri, dri], i * 4);
}

// y の高さでの [外径, 外径の傾き, 内径, 内径の傾き]。シェーダーの prof() と同じ線形補間。
export function profileAt(y) {
  const f = (Math.min(Math.max(y / LIP_Y, 0), 1)) * (PROFILE_N - 1);
  const i = Math.floor(f);
  const j = Math.min(i + 1, PROFILE_N - 1);
  const a = f - i;
  const out = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) out[k] = table[i * 4 + k] * (1 - a) + table[j * 4 + k] * a;
  return out;
}

export function makeProfileTexture() {
  const tex = new THREE.DataTexture(table, PROFILE_N, 1, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

const smax = (a, b, k) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
};

// シェーダーの sdBottle() と同じ式。[ガラスまでの距離, 内部空間までの距離]（負なら内側）。
export function sdBottle(x, y, z) {
  let r = Math.hypot(x, z);
  const c = r > 1e-4 ? x / r : 0;
  const dy = (y - DIMPLE.y) / DIMPLE.w;
  r += DIMPLE.depth * Math.exp(-dy * dy) * Math.pow(c, 16);
  const [ro, dro, ri, dri] = profileAt(y);
  const dOut = (r - ro) / Math.sqrt(1 + dro * dro);
  const dIn = (r - ri) / Math.sqrt(1 + dri * dri);
  const bOut = BASE.punt * Math.max(0, 1 - (r * r) / (BASE.puntR * BASE.puntR)) - y;
  const q = (r / BASE.innerR) ** 2;
  const bIn = BASE.innerY + BASE.innerRise * q * q - y;
  const outer = Math.max(smax(dOut, bOut, 2.0), y - LIP_Y);
  const cav = smax(dIn, bIn, 2.5);
  let glass = Math.max(outer, -cav);
  glass = Math.min(glass, Math.hypot(r - LIP.rc, y - LIP_Y) - LIP.rt);
  return [glass, cav];
}

// ビー玉の位置を形から求める。
// 開ける前：ガス圧で口へ押し付けられた、いちばん高い位置。
// 開けた後：そこから落ちて、くびれの凹みに引っかかる位置。
function sphereSamples(count) {
  const pts = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - ((i + 0.5) / count) * 2;
    const rr = Math.sqrt(1 - y * y);
    const th = golden * i;
    pts.push([Math.cos(th) * rr, y, Math.sin(th) * rr]);
  }
  return pts;
}

function marbleFits(yc, samples) {
  for (const [x, y, z] of samples) {
    if (sdBottle(x * MARBLE_R, yc + y * MARBLE_R, z * MARBLE_R)[1] > -0.05) return false;
  }
  return true;
}

function findMarbleStops() {
  const samples = sphereSamples(2400);
  let seal = 145;
  while (marbleFits(seal + 0.01, samples)) seal += 0.01;
  let rest = seal;
  while (marbleFits(rest - 0.01, samples)) rest -= 0.01;
  return { seal, rest };
}

export const MARBLE_STOPS = findMarbleStops();

// キャップのリングは口のガラスに触れない内径にする。
let collarRi = 0;
for (let y = CAP.collarY0; y <= LIP_Y; y += 0.25) collarRi = Math.max(collarRi, profileAt(y)[0]);
CAP.collarRi = Math.max(collarRi, LIP.rc + LIP.rt) + 0.4;
CAP.collarRo = CAP.collarRi + 2.0;
// 押す前の玉押しの下端（ビー玉のてっぺん）。
CAP.restY = MARBLE_STOPS.seal + MARBLE_R;
CAP.maxPush = CAP.restY + CAP.stemH - 1 - CAP.collarY1 - 0.3;
