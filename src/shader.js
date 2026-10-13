import { BASE, CAP, DIMPLE, LIP, PROFILE_N } from './bottle.js';

export const MAX_BUB = 64;
export const MAX_FOAM = 64;

// 小数点付きの GLSL 定数にする。
const f = (x) => (Number.isInteger(x) ? `${x}.0` : `${+x.toFixed(5)}`);

// sRGB の色を線形にする。
const lin = (hex) => {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const c = v.map((x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
  return `vec3(${c.map(f).join(', ')})`;
};

// 光源の向き（キーライトのソフトボックスの中心）。
const KEY_AZ = -0.85;
const KEY_EL = 0.75;
const KEY = [Math.sin(KEY_AZ) * Math.cos(KEY_EL), Math.sin(KEY_EL), Math.cos(KEY_AZ) * Math.cos(KEY_EL)];

export const VERT = /* glsl */ `
in vec3 position;
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const BLIT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uTex;
uniform vec2 uRes;
out vec4 fragColor;
void main() {
  fragColor = texture(uTex, gl_FragCoord.xy / uRes);
}
`;

export const TRACE_FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform vec2 uRes;
uniform vec3 uCamPos;
uniform mat3 uCamBasis;
uniform float uTanHalf;
uniform sampler2D uProf;
uniform vec4 uMarble;
uniform float uLevel;
uniform float uPushY;
uniform vec4 uBub[${MAX_BUB}];
uniform int uBubN;
uniform vec4 uFoam[${MAX_FOAM}];
uniform int uFoamN;
uniform vec3 uFoamLo;
uniform vec3 uFoamHi;
uniform float uRipple;
uniform float uHaze;
uniform float uTime;
uniform vec2 uSpin;
uniform vec3 uColumn;

out vec4 fragColor;

// 屈折を通った光線ほど床の模様をぼかす（ガラス越しのモアレを防ぐ）。
float gBlur = 1.0;

#define PI 3.14159265
#define AIR 0
#define GLASS 1
#define LIQ 2

const float PROF_N = ${f(PROFILE_N)};
const float LIP_Y = ${f(LIP.y)};
const float LIP_RC = ${f(LIP.rc)};
const float LIP_RT = ${f(LIP.rt)};
const float DIMPLE_Y = ${f(DIMPLE.y)};
const float DIMPLE_W = ${f(DIMPLE.w)};
const float DIMPLE_D = ${f(DIMPLE.depth)};
const float PUNT = ${f(BASE.punt)};
const float PUNT_R2 = ${f(BASE.puntR * BASE.puntR)};
const float BIN_Y = ${f(BASE.innerY)};
const float BIN_RISE = ${f(BASE.innerRise)};
const float BIN_R = ${f(BASE.innerR)};
const float COLLAR_RI = ${f(CAP.collarRi)};
const float COLLAR_RO = ${f(CAP.collarRo)};
const float COLLAR_Y0 = ${f(CAP.collarY0)};
const float COLLAR_Y1 = ${f(CAP.collarY1)};
const float COLLAR_TOP_RI = ${f(CAP.collarTopRi)};
const float STEM_R = ${f(CAP.stemR)};
const float STEM_H = ${f(CAP.stemH)};
const float BTN_R = ${f(CAP.buttonR)};
const float BTN_H = ${f(CAP.buttonH)};

const float BOUND_R = 38.0;
const float BOUND_Y0 = -0.5;
const float BOUND_Y1 = 196.0;

const float EPS = 0.015;
const int MAX_STEPS = 260;
const float IOR_GLASS = 1.5;
const float IOR_LIQ = 1.34;
const float IOR_MARBLE = 1.52;
// 1mm あたりの吸収。瓶のガラスは赤を吸って水色に、ビー玉はほんのり緑に。
const vec3 ABS_GLASS = vec3(0.034, 0.0085, 0.0105);
const vec3 ABS_LIQ = vec3(0.0016, 0.0007, 0.0005);
const vec3 ABS_MARBLE = vec3(0.014, 0.0042, 0.0062);

const vec3 LIGHT = vec3(${KEY.map(f).join(', ')});
const vec3 HORIZON = ${lin('#f6eedc')};
const vec3 ZENITH = ${lin('#bfe3f2')};
const vec3 FLOOR = ${lin('#f8f5ec')};
const vec3 GINGHAM = ${lin('#9cc8ea')};
const vec3 SHADOW_TINT = ${lin('#8fd3cb')};
const vec3 CAUSTIC = ${lin('#d4fff4')};
const vec3 CAP_COLLAR = ${lin('#1d5fd8')};
const vec3 CAP_PUSHER = ${lin('#3b7fec')};

// ---------------------------------------------------------------- 形

vec4 prof(float y) {
  float fy = clamp(y / LIP_Y, 0.0, 1.0) * (PROF_N - 1.0);
  int i = int(fy);
  vec4 a = texelFetch(uProf, ivec2(i, 0), 0);
  vec4 b = texelFetch(uProf, ivec2(min(i + 1, int(PROF_N) - 1), 0), 0);
  return mix(a, b, fy - float(i));
}

float smax(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return max(a, b) + h * h * k * 0.25;
}

float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

// x: ガラスまでの距離, y: 瓶の内部空間までの距離（どちらも負なら内側）。
vec2 sdBottle(vec3 p) {
  float r = length(p.xz);
  float c = r > 1e-4 ? (p.x * uSpin.x + p.z * uSpin.y) / r : 0.0;
  float c2 = c * c;
  float c4 = c2 * c2;
  float c8 = c4 * c4;
  float dy = (p.y - DIMPLE_Y) / DIMPLE_W;
  r += DIMPLE_D * exp(-dy * dy) * c8 * c8;
  vec4 P = prof(p.y);
  float dOut = (r - P.x) * inversesqrt(1.0 + P.y * P.y);
  float dIn = (r - P.z) * inversesqrt(1.0 + P.w * P.w);
  float bOut = PUNT * max(0.0, 1.0 - r * r / PUNT_R2) - p.y;
  float q = r / BIN_R;
  q *= q;
  float bIn = BIN_Y + BIN_RISE * q * q - p.y;
  float outer = max(smax(dOut, bOut, 2.0), p.y - LIP_Y);
  float cav = smax(dIn, bIn, 2.5);
  float glass = max(outer, -cav);
  glass = min(glass, length(vec2(r - LIP_RC, p.y - LIP_Y)) - LIP_RT);
  return vec2(glass, cav);
}

vec3 glassNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float h = 0.02;
  return normalize(
    k.xyy * sdBottle(p + k.xyy * h).x +
    k.yyx * sdBottle(p + k.yyx * h).x +
    k.yxy * sdBottle(p + k.yxy * h).x +
    k.xxx * sdBottle(p + k.xxx * h).x
  );
}

// (r, y) 平面の角丸の箱。
float sdBox2(vec2 p, vec2 c, vec2 h, float rr) {
  vec2 d = abs(p - c) - h + rr;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - rr;
}

// x: キャップまでの距離, y: 0 ならリング、1 なら玉押し。
vec2 sdCap(vec3 p) {
  if (p.y < COLLAR_Y0 - 3.0) return vec2(COLLAR_Y0 - 3.0 - p.y + 1.0, 0.0);
  vec2 q = vec2(length(p.xz), p.y);
  float wall = sdBox2(q,
    vec2((COLLAR_RI + COLLAR_RO) * 0.5, (COLLAR_Y0 + COLLAR_Y1) * 0.5),
    vec2((COLLAR_RO - COLLAR_RI) * 0.5, (COLLAR_Y1 - COLLAR_Y0) * 0.5), 0.7);
  float top = sdBox2(q,
    vec2((COLLAR_TOP_RI + COLLAR_RO) * 0.5, COLLAR_Y1 - 1.25),
    vec2((COLLAR_RO - COLLAR_TOP_RI) * 0.5, 1.25), 0.7);
  float collar = smin(wall, top, 0.6);
  float b = uPushY;
  float stem = sdBox2(q, vec2(0.0, b + STEM_H * 0.5), vec2(STEM_R, STEM_H * 0.5), 1.0);
  float btn = sdBox2(q, vec2(0.0, b + STEM_H - 1.0 + BTN_H * 0.5), vec2(BTN_R, BTN_H * 0.5), 1.3);
  float pusher = smin(stem, btn, 0.8);
  return collar < pusher ? vec2(collar, 0.0) : vec2(pusher, 1.0);
}

vec3 capNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float h = 0.02;
  return normalize(
    k.xyy * sdCap(p + k.xyy * h).x +
    k.yyx * sdCap(p + k.yyx * h).x +
    k.yxy * sdCap(p + k.yxy * h).x +
    k.xxx * sdCap(p + k.xxx * h).x
  );
}

// あふれた泡のかたまり。w には 半径×100 の整数部と、泡らしさ（0〜1）の小数部を詰めてある。
float sdFoam(vec3 p) {
  vec3 c = clamp(p, uFoamLo, uFoamHi);
  float db = length(p - c);
  if (db > 0.5) return db;
  float d = 1e4;
  for (int i = 0; i < ${MAX_FOAM}; i++) {
    if (i >= uFoamN) break;
    vec4 b = uFoam[i];
    if (b.w < 1.0) continue;
    d = smin(d, length(p - b.xyz) - floor(b.w) * 0.01, 3.4);
  }
  // 泡のつぶつぶ感。
  d += 0.15 * sin(p.x * 1.3 + sin(p.y * 1.1)) * sin(p.y * 1.5 + p.z * 0.7) * sin(p.z * 1.4 + p.x * 0.4);
  return d;
}

// その点での泡らしさ。近い泡ほど重く平均する。
float foaminess(vec3 p) {
  float wsum = 0.0;
  float fsum = 0.0;
  for (int i = 0; i < ${MAX_FOAM}; i++) {
    if (i >= uFoamN) break;
    vec4 b = uFoam[i];
    if (b.w < 1.0) continue;
    float d = length(p - b.xyz) - floor(b.w) * 0.01;
    float w = exp(-max(d, 0.0) * 1.5);
    wsum += w;
    fsum += w * fract(b.w);
  }
  return wsum > 0.0 ? fsum / wsum : 1.0;
}

vec3 foamNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  const float h = 0.05;
  return normalize(
    k.xyy * sdFoam(p + k.xyy * h) +
    k.yyx * sdFoam(p + k.yyx * h) +
    k.yxy * sdFoam(p + k.yxy * h) +
    k.xxx * sdFoam(p + k.xxx * h)
  );
}

float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x),
        mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x),
        mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}

vec3 hash33(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453);
}

// 泡の膜の模様（ボロノイ）。x: いちばん近い泡の中心まで, y: 2 番目まで。
// off はいちばん近い泡の中心へのずれ。
vec2 voronoi(vec3 x, out vec3 off) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  float f1 = 8.0;
  float f2 = 8.0;
  off = vec3(0.0);
  for (int k = -1; k <= 1; k++)
  for (int j = -1; j <= 1; j++)
  for (int n = -1; n <= 1; n++) {
    vec3 g = vec3(float(n), float(j), float(k));
    vec3 r = g + hash33(i + g) - f;
    float d = dot(r, r);
    if (d < f1) { f2 = f1; f1 = d; off = r; }
    else if (d < f2) { f2 = d; }
  }
  return sqrt(vec2(f1, f2));
}

// 外から球に当たるときの距離。当たらなければ -1。
float sphereHit(vec3 ro, vec3 rd, vec3 c, float r) {
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  float h = b * b - dot(oc, oc) + r * r;
  if (h < 0.0) return -1.0;
  float t = -b - sqrt(h);
  return t > 1e-4 ? t : -1.0;
}

// 球の内側から外へ抜けるまでの距離。
float sphereExit(vec3 ro, vec3 rd, vec3 c, float r) {
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  return -b + sqrt(max(b * b - dot(oc, oc) + r * r, 0.0));
}

// ---------------------------------------------------------------- スタジオ

float softbox(vec3 rd, float az0, float el0, float aw, float eh, float soft) {
  float az = atan(rd.x, rd.z);
  float el = asin(clamp(rd.y, -1.0, 1.0));
  float da = abs(mod(az - az0 + PI, 2.0 * PI) - PI);
  return (1.0 - smoothstep(aw - soft, aw + soft, da)) *
         (1.0 - smoothstep(eh - soft, eh + soft, abs(el - el0)));
}

vec3 sky(vec3 rd) {
  vec3 c = mix(HORIZON, ZENITH, smoothstep(0.0, 0.75, rd.y));
  c += vec3(1.0, 0.98, 0.95) * 7.0 * softbox(rd, ${f(KEY_AZ)}, ${f(KEY_EL)}, 0.2, 0.42, 0.04);
  c += vec3(0.95, 0.98, 1.0) * 2.6 * softbox(rd, 1.05, 0.55, 0.11, 0.38, 0.03);
  c += vec3(1.0) * 3.2 * softbox(rd, PI - 0.78, 0.6, 0.09, 0.42, 0.03);
  c += vec3(1.0) * 3.2 * softbox(rd, -(PI - 0.78), 0.6, 0.09, 0.42, 0.03);
  // 左右の黒い板。ガラスの輪郭を締める。
  c *= 1.0 - 0.85 * softbox(rd, 1.7, 0.25, 0.32, 0.6, 0.18);
  c *= 1.0 - 0.85 * softbox(rd, -1.7, 0.25, 0.32, 0.6, 0.18);
  return c;
}

// 矩形波を幅 fw でぼかした値（遠くのチェックがちらつかないように）。
float stripe(float u, float fw) {
  float a = u - fw * 0.5;
  float b = u + fw * 0.5;
  float ia = floor(a) * 0.5 + max(fract(a) - 0.5, 0.0);
  float ib = floor(b) * 0.5 + max(fract(b) - 0.5, 0.0);
  return (ib - ia) / fw;
}

// 床の点 fp から光源へ向かう線が、瓶の軸から何倍の半径のところを通るか。
float shadowRatio(vec2 a, vec2 b, float y) {
  return length(a + b * y) / prof(y).x;
}

vec3 floorShade(vec3 fp) {
  float dist = length(fp.xz);
  // うすい水色のギンガムチェック。
  const float CHECK = 26.0;
  float fw = max(length(fp - uCamPos) * uTanHalf * 2.0 / uRes.y / CHECK * gBlur, 1e-3);
  float g = stripe(fp.x / CHECK, fw) + stripe(fp.z / CHECK + 0.25, fw);
  vec3 c = mix(FLOOR, GINGHAM, 0.24 * g * (1.0 - smoothstep(380.0, 1000.0, dist)));

  float sh = 0.0;
  float ca = 0.0;
  if (dist < 460.0) {
    // 光源へ向かう線をたどり、瓶の輪郭にいちばん近づく高さを探す。
    vec2 a = fp.xz - LIGHT.xz * fp.y / LIGHT.y;
    vec2 b = LIGHT.xz / LIGHT.y;
    const float H = LIP_Y + 2.0;
    const int N = 24;
    float best = 1e9;
    float by = 0.0;
    for (int i = 0; i < N; i++) {
      float y = (float(i) + 0.5) / float(N) * H;
      float x = shadowRatio(a, b, y);
      if (x < best) { best = x; by = y; }
    }
    float h = H / float(N) * 0.5;
    for (int i = 0; i < 4; i++) {
      float y0 = clamp(by - h, 0.0, H);
      float y1 = clamp(by + h, 0.0, H);
      float x0 = shadowRatio(a, b, y0);
      float x1 = shadowRatio(a, b, y1);
      if (x0 < best) { best = x0; by = y0; }
      if (x1 < best) { best = x1; by = y1; }
      h *= 0.5;
    }
    float soft = 0.05 + by * 0.0009;
    float inside = 1.0 - smoothstep(1.0 - soft, 1.0 + soft, best);
    sh = inside * mix(0.4, 0.85, smoothstep(0.45, 1.0, best));
    ca = inside * exp(-best * best * 11.0) * (by < uLevel ? 1.0 : 0.35);
  }
  c *= mix(vec3(1.0), SHADOW_TINT, sh) * (1.0 - 0.4 * sh);
  c += CAUSTIC * ca * 0.85;
  c *= 1.0 - 0.5 * exp(-max(dist - 25.0, 0.0) / 4.5);
  return mix(c, HORIZON, smoothstep(500.0, 2600.0, dist));
}

vec3 background(vec3 ro, vec3 rd) {
  if (rd.y < -1e-4) {
    float t = max(-ro.y / rd.y, 0.0);
    return floorShade(ro + rd * t);
  }
  return sky(rd);
}

// ---------------------------------------------------------------- 光の受け渡し

float fresnel(float cosi, float eta) {
  float st2 = eta * eta * (1.0 - cosi * cosi);
  if (st2 >= 1.0) return 1.0;
  float ct = sqrt(1.0 - st2);
  float rs = (eta * cosi - ct) / (eta * cosi + ct);
  float rp = (cosi - eta * ct) / (cosi + eta * ct);
  return 0.5 * (rs * rs + rp * rp);
}

float iorOf(int med) {
  return med == GLASS ? IOR_GLASS : (med == LIQ ? IOR_LIQ : 1.0);
}

vec3 absorbOf(int med) {
  return med == GLASS ? ABS_GLASS : (med == LIQ ? ABS_LIQ : vec3(0.0));
}

// N は光が来た側を向く。屈折して先へ進めば true、全反射して戻れば false。
bool crossSurface(vec3 hp, vec3 N, float n1, float n2, inout vec3 rd, out vec3 p, inout vec3 col, inout vec3 thru) {
  float eta = n1 / n2;
  float cosi = clamp(-dot(rd, N), 0.0, 1.0);
  float F = fresnel(cosi, eta);
  vec3 rf = reflect(rd, N);
  if (F >= 0.999) {
    rd = rf;
    p = hp + N * 2.0 * EPS;
    return false;
  }
  col += thru * F * background(hp, rf);
  thru *= 1.0 - F;
  rd = refract(rd, N, eta);
  p = hp - N * 2.0 * EPS;
  return true;
}

// 球（ビー玉や泡）を通り抜ける。内側で全反射したら数回まで跳ね返す。
void throughSphere(vec3 hp, vec3 c, float R, float nOut, float nIn, vec3 absorb, inout vec3 rd, inout vec3 p, inout vec3 col, inout vec3 thru) {
  vec3 N = normalize(hp - c);
  float F = fresnel(clamp(-dot(rd, N), 0.0, 1.0), nOut / nIn);
  vec3 rf = reflect(rd, N);
  if (F >= 0.999) {
    rd = rf;
    p = hp + N * 2.0 * EPS;
    return;
  }
  col += thru * F * background(hp, rf);
  thru *= 1.0 - F;
  vec3 d = refract(rd, N, nOut / nIn);
  vec3 q = hp;
  for (int j = 0; j < 3; j++) {
    float tt = sphereExit(q, d, c, R);
    thru *= exp(-absorb * tt);
    vec3 e = q + d * tt;
    vec3 Ni = -normalize(e - c);
    float F2 = fresnel(clamp(-dot(d, Ni), 0.0, 1.0), nIn / nOut);
    if (F2 < 0.999 || j == 2) {
      thru *= 1.0 - min(F2, 0.999);
      vec3 out_ = refract(d, Ni, nIn / nOut);
      rd = dot(out_, out_) > 0.0 ? out_ : d;
      p = e - Ni * 2.0 * EPS;
      return;
    }
    d = reflect(d, Ni);
    q = e;
  }
}

vec3 shadeCap(vec3 hp, vec3 rd, float part) {
  vec3 n = capNormal(hp);
  vec3 alb = part < 0.5 ? CAP_COLLAR : CAP_PUSHER;
  float diff = max(dot(n, LIGHT), 0.0);
  vec3 amb = mix(FLOOR * 0.55, ZENITH * 0.9, n.y * 0.5 + 0.5);
  vec3 c = alb * (amb + diff * 1.4);
  float F = 0.04 + 0.96 * pow(1.0 - max(dot(-rd, n), 0.0), 5.0);
  return c * (1.0 - F) + F * sky(reflect(rd, n));
}

// あふれた泡の表面。小さな泡ひとつひとつがドームになって光を返す。
// 泡がつぶれて液に戻るほど透けて、濡れたつやだけが残る。
void shadeFoam(vec3 hp, vec3 rd, inout vec3 col, inout vec3 thru) {
  float f = foaminess(hp);
  vec3 n = foamNormal(hp);
  vec3 off;
  vec2 v = voronoi(hp * 1.15, off);
  vec3 offT = off - n * dot(off, n);
  vec3 bn = normalize(n - offT * mix(0.6, 1.3, f));
  float wall = 1.0 - smoothstep(0.0, 0.16, v.y - v.x);
  float wrap = dot(bn, LIGHT) * 0.5 + 0.5;
  vec3 base = vec3(0.95, 0.97, 1.0) * (0.52 + 0.55 * wrap);
  base = mix(base * 0.84, vec3(1.02), wall * 0.7);
  base += vec3(0.55, 0.85, 0.95) * 0.06 * (1.0 - wrap);
  float F = 0.04 + 0.96 * pow(1.0 - max(dot(-rd, bn), 0.0), 5.0);
  vec3 spec = sky(reflect(rd, bn)) * mix(0.9, 0.45, f);
  float opacity = mix(0.06, 0.96, smoothstep(0.05, 0.75, f));
  col += thru * (base * opacity + F * spec);
  thru *= (1.0 - opacity) * (1.0 - F);
}

// 首の中にせり上がる泡の層。瓶の内側の空気を通る区間だけ白く濁らせ、
// ガラスに押し付けられた泡の膜の模様を入口に描く。
void foamColumn(vec3 p, vec3 rd, float t, inout vec3 col, inout vec3 thru) {
  float t0 = 0.0;
  float t1 = t;
  float top = uColumn.y + 2.0;
  if (abs(rd.y) > 1e-5) {
    float ta = (uColumn.x - p.y) / rd.y;
    float tb = (top - p.y) / rd.y;
    t0 = max(t0, min(ta, tb));
    t1 = min(t1, max(ta, tb));
  } else if (p.y < uColumn.x || p.y > top) {
    return;
  }
  if (t1 <= t0) return;
  if (sdBottle(p + rd * (0.5 * (t0 + t1))).y > 0.0) return;
  float dens = 0.0;
  for (int i = 0; i < 4; i++) {
    vec3 q = p + rd * mix(t0, t1, (float(i) + 0.5) / 4.0);
    float n = vnoise(q * 0.5 + vec3(0.0, -uTime * 7.0, 0.0));
    // 上端はでこぼこにぼかす。
    float head = uColumn.y + (vnoise(vec3(q.xz * 0.3, uTime * 0.8)) - 0.5) * 5.0;
    dens += (0.35 + 1.3 * n) * smoothstep(head + 1.0, head - 2.0, q.y);
  }
  dens *= 0.25;
  float T = exp(-uColumn.z * (t1 - t0) * dens);
  vec3 off;
  vec2 v = voronoi((p + rd * t0) * 0.75 + vec3(0.0, -uTime * 1.2, 0.0), off);
  float wall = 1.0 - smoothstep(0.0, 0.22, v.y - v.x);
  float cellLit = pow(clamp(1.0 - v.x * 1.4, 0.0, 1.0), 3.0);
  vec3 fc = mix(vec3(0.74, 0.84, 0.89), vec3(1.0), wall);
  fc += vec3(0.25) * cellLit;
  col += thru * (1.0 - T) * fc;
  thru *= T;
}

// 開けた直後、液全体を白く濁らせる細かい泡。下から上へ流れる筋になる。
void liquidHaze(vec3 p, vec3 rd, float t, inout vec3 col, inout vec3 thru) {
  float n = 0.0;
  for (int i = 0; i < 3; i++) {
    vec3 q = p + rd * t * (float(i) + 0.5) / 3.0;
    float m = vnoise(vec3(q.x * 0.3, q.y * 0.1 - uTime * 3.2, q.z * 0.3));
    n += m * m;
  }
  n /= 3.0;
  float T = exp(-uHaze * t * (0.15 + 2.2 * n));
  col += thru * (1.0 - T) * vec3(0.86, 0.93, 0.96);
  thru *= T;
}

// ---------------------------------------------------------------- レイトレース

vec2 boundHit(vec3 ro, vec3 rd) {
  float a = dot(rd.xz, rd.xz);
  float b = dot(ro.xz, rd.xz);
  float c = dot(ro.xz, ro.xz) - BOUND_R * BOUND_R;
  float h = b * b - a * c;
  if (h < 0.0 || a < 1e-8) return vec2(1.0, -1.0);
  h = sqrt(h);
  vec2 t = vec2(-b - h, -b + h) / a;
  float iy = 1.0 / rd.y;
  vec2 ty = vec2((BOUND_Y0 - ro.y) * iy, (BOUND_Y1 - ro.y) * iy);
  if (ty.x > ty.y) ty = ty.yx;
  return vec2(max(t.x, ty.x), min(t.y, ty.y));
}

vec3 trace(vec3 ro, vec3 rd) {
  vec2 tb = boundHit(ro, rd);
  if (tb.y <= max(tb.x, 0.0)) return background(ro, rd);
  vec3 p = ro + rd * max(tb.x, 0.0);
  int med = AIR;
  vec3 col = vec3(0.0);
  vec3 thru = vec3(1.0);
  int steps = 0;
  bool foamOff = false; // 透けた泡を一度通り抜けたら、その先は泡を無視する

  for (int ev = 0; ev < 16; ev++) {
    // 解析的に求まる面：ビー玉、液面、泡。
    float tA = 1e5;
    int aKind = 0;
    int aIdx = 0;
    if (med != GLASS) {
      float tm = sphereHit(p, rd, uMarble.xyz, uMarble.w);
      if (tm > 0.0) { tA = tm; aKind = 1; }
      if (abs(rd.y) > 1e-6) {
        float tp = (uLevel - p.y) / rd.y;
        if (tp > 1e-4 && tp < tA && (med == LIQ || sdBottle(p + rd * tp).y < 0.0)) { tA = tp; aKind = 2; }
      }
      if (med == LIQ) {
        for (int i = 0; i < ${MAX_BUB}; i++) {
          if (i >= uBubN) break;
          vec4 b = uBub[i];
          if (b.w <= 0.0) continue;
          float tbb = sphereHit(p, rd, b.xyz, b.w);
          if (tbb > 0.0 && tbb < tA) { tA = tbb; aKind = 3; aIdx = i; }
        }
      }
    }

    // 距離場をたどる面：ガラス、キャップ、あふれた泡。
    float t = 0.0;
    int kind = -1; // -1: 予算切れ, 0: 外へ抜けた, 1: ガラス, 2: キャップ, 3: 泡, 4: 解析的な面
    float capPart = 0.0;
    for (int s = 0; s < MAX_STEPS; s++) {
      if (++steps > MAX_STEPS) break;
      vec3 q = p + rd * t;
      vec2 B = sdBottle(q);
      float d = med == GLASS ? -B.x : B.x;
      int k = 1;
      if (med == AIR) {
        vec2 cp = sdCap(q);
        if (cp.x < d) { d = cp.x; k = 2; capPart = cp.y; }
        if (!foamOff) {
          float df = sdFoam(q);
          if (df < d) { d = df; k = 3; }
        }
      }
      if (d < EPS) { kind = k; break; }
      float stepLen = d * (abs(q.y - DIMPLE_Y) < 3.0 * DIMPLE_W ? 0.6 : 0.85);
      if (t + stepLen >= tA) { t = tA; kind = 4; break; }
      t += stepLen;
      if (med == AIR) {
        vec3 qn = p + rd * t;
        if ((length(qn.xz) > BOUND_R && dot(qn.xz, rd.xz) > 0.0) ||
            (qn.y > BOUND_Y1 && rd.y > 0.0) || (qn.y < BOUND_Y0 && rd.y < 0.0)) { kind = 0; break; }
      }
    }

    if (med == AIR && uColumn.z > 0.0) foamColumn(p, rd, t, col, thru);
    if (med == LIQ && uHaze > 0.0) liquidHaze(p, rd, t, col, thru);
    thru *= exp(-absorbOf(med) * t);
    vec3 hp = p + rd * t;

    if (kind <= 0) {
      return col + thru * background(hp, rd);
    }
    if (kind == 2) return col + thru * shadeCap(hp, rd, capPart);
    if (kind == 3) {
      shadeFoam(hp, rd, col, thru);
      if (max(thru.r, max(thru.g, thru.b)) < 0.02) return col;
      foamOff = true;
      p = hp + rd * 0.05;
      continue;
    }

    if (kind == 1) {
      vec3 n = glassNormal(hp);
      vec3 N = dot(rd, n) < 0.0 ? n : -n;
      int next = GLASS;
      if (med == GLASS) {
        vec3 probe = hp - N * 3.0 * EPS;
        next = (sdBottle(probe).y < 0.0 && probe.y < uLevel) ? LIQ : AIR;
      }
      if (crossSurface(hp, N, iorOf(med), iorOf(next), rd, p, col, thru)) med = next;
      gBlur += 9.0;
      continue;
    }

    // 解析的な面。
    if (aKind == 1) {
      throughSphere(hp, uMarble.xyz, uMarble.w, iorOf(med), IOR_MARBLE, ABS_MARBLE, rd, p, col, thru);
      gBlur += 4.0;
    } else if (aKind == 2) {
      vec3 n = vec3(0.0, 1.0, 0.0);
      n.xz += uRipple * 0.12 * vec2(sin(hp.x * 0.9 + uTime * 9.0) + sin(hp.z * 1.7 - uTime * 6.0),
                                     sin(hp.z * 0.8 - uTime * 7.0) + sin(hp.x * 1.5 + uTime * 5.0));
      n = normalize(n);
      vec3 N = dot(rd, n) < 0.0 ? n : -n;
      int next = med == LIQ ? AIR : LIQ;
      if (crossSurface(hp, N, iorOf(med), iorOf(next), rd, p, col, thru)) med = next;
    } else {
      vec4 b = uBub[aIdx];
      throughSphere(hp, b.xyz, b.w, IOR_LIQ, 1.0, vec3(0.0), rd, p, col, thru);
    }
  }
  return col + thru * background(p, rd);
}

// 白飛びの手前でやわらかく丸める。
vec3 tonemap(vec3 c) {
  const float k = 0.78;
  vec3 over = max(c - k, 0.0);
  return min(c, k) + (1.0 - k) * (1.0 - exp(-over / (1.0 - k)));
}

void main() {
  vec2 uv = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  uv.x *= uRes.x / uRes.y;
  vec3 rd = normalize(uCamBasis * vec3(uv * uTanHalf, 1.0));
  vec3 c = trace(uCamPos, rd);
  vec2 v = gl_FragCoord.xy / uRes - 0.5;
  c *= 1.0 - 0.22 * dot(v, v) * 2.0;
  c = tonemap(c);
  c = pow(c, vec3(1.0 / 2.2));
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  c += (n - 0.5) / 255.0;
  fragColor = vec4(c, 1.0);
}
`;
