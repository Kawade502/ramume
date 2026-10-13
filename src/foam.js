import { CAP, LIP_Y, profileAt } from './bottle.js';
import { MAX_BUB, MAX_FOAM } from './shader.js';

// 再現できる乱数（スクリーンショットを毎回同じにするため）。
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smoothstep = (a, b, x) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

const innerR = (y) => profileAt(Math.min(y, LIP_Y))[2];

// 瓶の外側で、泡が沿って流れる面の半径。
function surfaceR(y) {
  if (y >= CAP.collarY0 - 0.5) return CAP.collarRo;
  return profileAt(Math.min(y, LIP_Y))[0];
}

const COLUMN_TOP = LIP_Y + 1;
const SITES = 14;

// 開栓後のシュワシュワ。
// pressure は開けた瞬間に 1 になって減っていく。それに合わせて
// ・液の中の泡（bubbles）が、壁や底の決まった場所から列になって上り、
// ・液全体が細かい泡で白く濁り（haze）、
// ・首の中を泡の層（column）がせり上がり、
// ・キャップからあふれた泡（foam）が首を伝って垂れ、だんだん透明な液に戻る。
export function createFizz() {
  let rand = mulberry32(7);
  const bubbles = [];
  const foam = [];
  const streams = [];
  const sites = [];
  let since = -1;
  let pressure = 0;
  let bubAcc = 0;
  let foamAcc = 0;

  function reset() {
    rand = mulberry32(7);
    bubbles.length = 0;
    foam.length = 0;
    streams.length = 0;
    sites.length = 0;
    since = -1;
    pressure = 0;
    bubAcc = 0;
    foamAcc = 0;
  }

  function open(level) {
    since = 0;
    pressure = 1;
    // あふれた泡が流れ落ちる筋。ひとつは手前側に向ける。
    streams.length = 0;
    streams.push(Math.PI / 2 + (rand() - 0.5) * 1.0, rand() * Math.PI * 2, rand() * Math.PI * 2);
    // 泡が湧き続ける場所（ガラスの細かな傷）。同じ場所から出た泡は列になる。
    sites.length = 0;
    for (let i = 0; i < SITES; i++) {
      const th = rand() * Math.PI * 2;
      if (i < 4) {
        const rr = 4 + rand() * 18;
        sites.push({ x: Math.cos(th) * rr, y: 8.6, z: Math.sin(th) * rr });
      } else {
        const y = 12 + rand() * Math.max(level - 22, 1);
        const rr = innerR(y) - 0.5;
        sites.push({ x: Math.cos(th) * rr, y, z: Math.sin(th) * rr });
      }
    }
  }

  // 液の中にあるか（瓶を傾けると液面も傾く）。
  const below = (x, y, z, ctx, margin) => x * ctx.up[0] + y * ctx.up[1] + z * ctx.up[2] < ctx.liqD - margin;

  function spawnBubble(ctx, P) {
    const level = ctx.level;
    const s = sites.length && rand() < 0.7 ? sites[Math.floor(rand() * sites.length)] : null;
    if (s && below(s.x, s.y, s.z, ctx, 1)) {
      return {
        x: s.x + (rand() - 0.5) * 0.3,
        y: s.y,
        z: s.z + (rand() - 0.5) * 0.3,
        r: 0.16 + rand() * 0.12,
        ph: rand() * 6.28,
        wob: 0.6,
      };
    }
    const th = rand() * Math.PI * 2;
    const r0 = 0.22 + rand() * 0.3 + P * rand() * 0.7;
    let y;
    let rr;
    if (rand() < 0.5) {
      y = 8.5 + rand() * 2;
      rr = Math.sqrt(rand()) * 22;
    } else {
      y = 10 + rand() * Math.max(level - 16, 1);
      rr = Math.sqrt(rand()) * (innerR(y) - r0 - 0.4);
    }
    const b = { x: Math.cos(th) * rr, y, z: Math.sin(th) * rr, r: r0, ph: rand() * 6.28, wob: 3 };
    return below(b.x, b.y, b.z, ctx, 1) ? b : null;
  }

  // 玉押しのつばの下からあふれ出す泡。
  function spawnFoam(P) {
    // 半分は玉押しのまわりにまんべんなく、残りは垂れる筋に沿って。
    const th = rand() < 0.5 ? rand() * Math.PI * 2 : streams[Math.floor(rand() * streams.length)] + (rand() - 0.5) * 0.6;
    const r0 = 2.2 + rand() * 1.6;
    const rr = CAP.buttonR - 1 + rand() * 2;
    return {
      x: Math.cos(th) * rr,
      y: CAP.collarY1 + r0 * 0.3,
      z: Math.sin(th) * rr,
      r: 0,
      r0,
      f: 1, // 泡らしさ。1 なら真っ白な泡、0 なら透明な液のしずく
      vr: 10 + rand() * 16,
      vy: 25 * P * rand(), // 勢いがあるうちは、つばの上へ盛り上がる
      fall: 12 + rand() * 20,
      falling: false,
      life: 0,
      maxLife: 2.4 + rand() * 2.2,
    };
  }

  function step(dt, ctx) {
    if (since >= 0) {
      since += dt;
      pressure = Math.exp(-since / 1.1);
    }
    const P = pressure;
    const fizz = since >= 0 ? Math.exp(-since / 10) : 0;
    const up = ctx.up;

    // 液の中の泡：生まれた場所から、ふくらみながら上って液面で消える。
    bubAcc += dt * (300 * P + 26 * fizz);
    while (bubAcc >= 1) {
      bubAcc -= 1;
      if (bubbles.length >= MAX_BUB) continue;
      const b = spawnBubble(ctx, P);
      if (b) bubbles.push(b);
    }
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      if (!b.big) b.r = Math.min(b.r + dt * (0.25 + 1.0 * P), 2.0);
      // 浮力で、世界の上向きへ上る。
      const rise = (b.big ? 70 + 25 * b.r : 14 + 36 * b.r + 80 * P) * dt;
      b.x += up[0] * rise;
      b.y += up[1] * rise;
      b.z += up[2] * rise;
      b.ph += dt * 7;
      b.x += Math.cos(b.ph) * dt * b.wob;
      b.z += Math.sin(b.ph * 1.3) * dt * b.wob;
      const lim = innerR(b.y) - b.r - 0.4;
      const rr = Math.hypot(b.x, b.z);
      if (rr > lim && rr > 0) {
        b.x *= lim / rr;
        b.z *= lim / rr;
      }
      if (!below(b.x, b.y, b.z, ctx, b.r + 0.15) || b.y < 8) bubbles.splice(i, 1);
    }

    // 首を満たした泡があふれている間、つばの下から泡を出す。
    if (since > 0.15 && P > 0.1) foamAcc += dt * 110 * Math.pow(P, 0.7);
    while (foamAcc >= 1) {
      foamAcc -= 1;
      if (foam.length < MAX_FOAM) foam.push(spawnFoam(P));
    }

    // あふれた泡：リングの上で盛り上がって外へ広がり、首を伝ってゆっくり垂れる。
    // 垂れながら泡がつぶれて、透明な液のしずくになっていく。
    for (let i = foam.length - 1; i >= 0; i--) {
      const b = foam[i];
      b.life += dt;
      const t = b.life / b.maxLife;
      b.f = 1 - smoothstep(0.3, 0.85, t);
      b.r = b.r0 * smoothstep(0, 0.12, b.life) * (1 - 0.55 * smoothstep(0.35, 1, t)) * (1 - smoothstep(0.85, 1, t));
      let rr = Math.hypot(b.x, b.z);
      const ux = b.x / rr;
      const uz = b.z / rr;
      if (!b.falling && rr < CAP.collarRo - b.r * 0.2) {
        // リングの上：盛り上がりながら外へ押し出される。
        rr += Math.max(b.vr, 6) * dt;
        b.vr *= Math.exp(-dt * 1.2);
        b.vy -= 300 * dt;
        b.y = Math.max(CAP.collarY1 + b.r * 0.3, b.y + b.vy * dt);
      } else {
        // 外側：表面に沿って滑り落ちる。液に戻るほど速く垂れる。
        if (!b.falling) b.vy = Math.min(b.vy, 0);
        b.falling = true;
        b.vy = Math.max(b.vy - 120 * dt, -b.fall * (1 + (1 - b.f) * 1.5));
        b.y += b.vy * dt;
        rr = surfaceR(b.y) + b.r * (0.1 + 0.15 * b.f);
      }
      b.x = ux * rr;
      b.z = uz * rr;
      if (t >= 1) foam.splice(i, 1);
    }
  }

  // 首の中の泡の層 [下端, 上端, 濃さ]。
  function column(level) {
    if (since < 0) return [0, 0, 0];
    const P = pressure;
    const surge = Math.min(1 - Math.exp(-since / 0.09), smoothstep(0.03, 0.4, P));
    const top = Math.max(level + (COLUMN_TOP - level) * surge, level + 4 * Math.exp(-since / 5));
    const density = 0.26 * (0.3 + 0.7 * smoothstep(0, 0.5, P));
    return [level - 1.5, top, top - level > 0.3 ? density : 0];
  }

  // 液の濁り（細かい泡）の濃さ。1mm あたり。
  const haze = () => (since < 0 ? 0 : 0.03 * Math.pow(pressure, 1.3));

  // 飲んだとき口から入る空気の大きな泡（ゴボッ）。いっぱいなら小さな泡と入れ替える。
  function glug(x, y, z, r) {
    if (bubbles.length >= MAX_BUB) {
      const i = bubbles.findIndex((b) => !b.big);
      if (i < 0) return;
      bubbles.splice(i, 1);
    }
    bubbles.push({ x, y, z, r, ph: rand() * 6.28, wob: 6, big: true });
  }

  const active = () => pressure > 0.004 || bubbles.length > 0 || foam.length > 0 || (since >= 0 && since < 30);

  return {
    reset,
    open,
    step,
    glug,
    column,
    haze,
    active,
    bubbles,
    foam,
    get pressure() {
      return pressure;
    },
    get since() {
      return since;
    },
    get trail() {
      return since < 0 ? 0 : Math.exp(-since / 10);
    },
  };
}
