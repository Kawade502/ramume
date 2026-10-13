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

// 開栓後のシュワシュワ。
// pressure は開けた瞬間に 1 になって減っていく。それに合わせて
// ・液の中の泡（bubbles）が底や壁から湧いて上り、
// ・首の中を泡の層（column）がせり上がり、
// ・キャップからあふれた泡のかたまり（foam）が首を伝って垂れる。
export function createFizz() {
  let rand = mulberry32(7);
  const bubbles = [];
  const foam = [];
  const streams = [];
  let since = -1;
  let pressure = 0;
  let bubAcc = 0;
  let foamAcc = 0;

  function reset() {
    rand = mulberry32(7);
    bubbles.length = 0;
    foam.length = 0;
    streams.length = 0;
    since = -1;
    pressure = 0;
    bubAcc = 0;
    foamAcc = 0;
  }

  function open() {
    since = 0;
    pressure = 1;
    // あふれた泡が流れ落ちる筋。ひとつは手前側に向ける。
    streams.length = 0;
    streams.push(Math.PI / 2 + (rand() - 0.5) * 1.2, rand() * Math.PI * 2, rand() * Math.PI * 2);
  }

  function spawnBubble(level) {
    const th = rand() * Math.PI * 2;
    const r0 = 0.22 + rand() * 0.3;
    let y;
    let rr;
    if (rand() < 0.55) {
      y = 8.5 + rand() * 2;
      rr = Math.sqrt(rand()) * 22;
    } else {
      y = 10 + rand() * Math.max(level - 16, 1);
      rr = innerR(y) - r0 - 0.4;
    }
    return { x: Math.cos(th) * rr, y, z: Math.sin(th) * rr, r: r0, ph: rand() * 6.28 };
  }

  // 玉押しのつばの下からあふれ出す泡。
  function spawnFoam() {
    // 半分は玉押しのまわりにまんべんなく、残りは垂れる筋に沿って。
    const th = rand() < 0.5 ? rand() * Math.PI * 2 : streams[Math.floor(rand() * streams.length)] + (rand() - 0.5) * 0.7;
    const r0 = 2.8 + rand() * 1.9;
    const rr = CAP.buttonR - 1 + rand() * 2;
    return {
      x: Math.cos(th) * rr,
      y: CAP.collarY1 + r0 * 0.3,
      z: Math.sin(th) * rr,
      r: 0,
      r0,
      vr: 12 + rand() * 18,
      vy: 0,
      fall: 14 + rand() * 22,
      falling: false,
      life: 0,
      maxLife: 2.0 + rand() * 2.0,
    };
  }

  function step(dt, ctx) {
    if (since >= 0) {
      since += dt;
      pressure = Math.exp(-since / 1.1);
    }
    const P = pressure;
    const fizz = since >= 0 ? Math.exp(-since / 10) : 0;
    const level = ctx.level;

    // 液の中の泡：底や壁から生まれ、ふくらみながら上って液面で消える。
    bubAcc += dt * (260 * P + 24 * fizz);
    while (bubAcc >= 1) {
      bubAcc -= 1;
      if (bubbles.length < MAX_BUB) bubbles.push(spawnBubble(level));
    }
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const b = bubbles[i];
      b.r = Math.min(b.r + dt * (0.3 + 0.9 * P), 1.7);
      b.y += (16 + 34 * b.r + 70 * P) * dt;
      b.ph += dt * 7;
      b.x += Math.cos(b.ph) * dt * 3;
      b.z += Math.sin(b.ph * 1.3) * dt * 3;
      const lim = innerR(b.y) - b.r - 0.4;
      const rr = Math.hypot(b.x, b.z);
      if (rr > lim && rr > 0) {
        b.x *= lim / rr;
        b.z *= lim / rr;
      }
      if (b.y + b.r > level - 0.15) bubbles.splice(i, 1);
    }

    // 首を満たした泡があふれている間、つばの下から泡を出す。
    if (since > 0.18 && P > 0.12) foamAcc += dt * 70 * Math.pow(P, 0.7);
    while (foamAcc >= 1) {
      foamAcc -= 1;
      if (foam.length < MAX_FOAM) foam.push(spawnFoam());
    }

    // あふれた泡：リングの上を外へ広がり、首を伝ってゆっくり垂れていく。
    for (let i = foam.length - 1; i >= 0; i--) {
      const b = foam[i];
      b.life += dt;
      const t = b.life / b.maxLife;
      b.r = b.r0 * smoothstep(0, 0.12, b.life) * (1 - smoothstep(0.35, 1, t));
      let rr = Math.hypot(b.x, b.z);
      const ux = b.x / rr;
      const uz = b.z / rr;
      if (!b.falling && rr < CAP.collarRo - b.r * 0.2) {
        // リングの上：外へ押し出される。
        rr += Math.max(b.vr, 6) * dt;
        b.vr *= Math.exp(-dt * 1.2);
        b.y = CAP.collarY1 + b.r * 0.3;
      } else {
        // 外側：表面に沿って滑り落ちる。
        b.falling = true;
        b.vy = Math.max(b.vy - 120 * dt, -b.fall);
        b.y += b.vy * dt;
        rr = surfaceR(b.y) + b.r * 0.2;
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
    const density = 0.17 * (0.3 + 0.7 * smoothstep(0, 0.5, P));
    return [level - 1.5, top, top - level > 0.3 ? density : 0];
  }

  const active = () => pressure > 0.004 || bubbles.length > 0 || foam.length > 0 || (since >= 0 && since < 30);

  return {
    reset,
    open,
    step,
    column,
    active,
    bubbles,
    foam,
    get pressure() {
      return pressure;
    },
    get since() {
      return since;
    },
  };
}
