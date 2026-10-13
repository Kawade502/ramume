import { CAP, MARBLE_R, MARBLE_STOPS, cavityNormal, sdBottle } from './bottle.js';

const GRAVITY = 6000; // ちょっとだけゆっくり (mm/s²)
const ROLL = 5 / 7; // 転がる球は、滑る物体より加速がゆるい
const BOUNCE = 0.38;
const FRICTION = 2.2; // 壁に触れている間の転がり抵抗 (1/s)
const SINK = 0.6; // 液の中では浮力で重さが 6 割に
const DRAG = 4; // 液の中の抵抗 (1/s)

// ビー玉の表面にとった点。この点が壁にめり込んだら押し戻す。
const SAMPLES = (() => {
  const pts = [];
  const n = 60;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2;
    const rr = Math.sqrt(1 - y * y);
    pts.push([Math.cos(golden * i) * rr * MARBLE_R, y * MARBLE_R, Math.sin(golden * i) * rr * MARBLE_R]);
  }
  return pts;
})();

// 開けた後のビー玉。瓶のローカル座標で、内側の壁に沿って転がる。
// 傾けると低いほうへ転がり、凹みに引っかかったり、逆さにすると口にはまって栓をしたりする。
export function createMarble() {
  const p = [0, MARBLE_STOPS.seal, 0];
  const v = [0, 0, 0];
  let free = false;
  let sleepG = null; // 眠ったときの下向き。変わったら起きる
  let rolling = 0;
  let quiet = 0;
  const anchor = [0, 0, 0]; // 止まったかどうかを見るための、少し前の位置

  function reset() {
    p[0] = 0;
    p[1] = MARBLE_STOPS.seal;
    p[2] = 0;
    v[0] = v[1] = v[2] = 0;
    free = false;
    sleepG = null;
    rolling = 0;
  }

  // 開ける前：玉押しに押されて真下へ沈むだけ。
  function hold(y) {
    p[0] = 0;
    p[1] = y;
    p[2] = 0;
  }

  function release(speed) {
    free = true;
    sleepG = null;
    v[0] = 0;
    v[1] = -speed;
    v[2] = 0;
  }

  // いちばん深くめり込んでいる点を探す。
  function deepest() {
    let best = 0;
    let at = null;
    for (const s of SAMPLES) {
      const x = p[0] + s[0];
      const y = p[1] + s[1];
      const z = p[2] + s[2];
      const d = sdBottle(x, y, z)[1];
      if (d > best) {
        best = d;
        at = [x, y, z];
      }
    }
    return at ? { depth: best, n: cavityNormal(at[0], at[1], at[2]) } : null;
  }

  // gravity: 瓶のローカル座標での下向き（長さ 1）。
  // ctx.inLiquid(p) が true なら液の中、ctx.pusherY は玉押しの下端。
  // 戻り値は、この間に壁へぶつかった強さ（0 なら何もなし）。
  function step(dt, gravity, ctx) {
    if (!free) return 0;
    // 速いときは細かく刻んで、凹みをすり抜けないようにする。
    const n = Math.min(24, Math.max(1, Math.ceil((Math.hypot(v[0], v[1], v[2]) * dt) / 0.4)));
    let impact = 0;
    for (let i = 0; i < n; i++) impact = Math.max(impact, substep(dt / n, gravity, ctx));
    return impact;
  }

  function substep(dt, gravity, ctx) {
    // 下向きが変われば、寝ていても起きる。
    if (sleepG) {
      if (Math.abs(gravity[0] - sleepG[0]) + Math.abs(gravity[1] - sleepG[1]) + Math.abs(gravity[2] - sleepG[2]) < 0.01) return 0;
      sleepG = null;
    }

    const wet = ctx.inLiquid(p);
    const g = GRAVITY * ROLL * (wet ? SINK : 1);
    for (let k = 0; k < 3; k++) v[k] += gravity[k] * g * dt;
    if (wet) for (let k = 0; k < 3; k++) v[k] *= Math.exp(-DRAG * dt);
    for (let k = 0; k < 3; k++) p[k] += v[k] * dt;

    // 壁から押し戻す。何回か繰り返すと、凹みの角でも安定する。
    let impact = 0;
    let touching = false;
    for (let it = 0; it < 4; it++) {
      const c = deepest();
      if (!c) break;
      touching = true;
      for (let k = 0; k < 3; k++) p[k] -= c.n[k] * c.depth;
      const vn = v[0] * c.n[0] + v[1] * c.n[1] + v[2] * c.n[2];
      if (vn > 0) {
        impact = Math.max(impact, vn);
        for (let k = 0; k < 3; k++) v[k] -= (1 + (vn > 60 ? BOUNCE : 0)) * vn * c.n[k];
      }
    }
    // 玉押しより上には行けない。
    const top = ctx.pusherY - MARBLE_R;
    if (p[1] > top && Math.hypot(p[0], p[2]) < CAP.stemR) {
      p[1] = top;
      if (v[1] > 0) v[1] = 0;
    }

    const speed = Math.hypot(v[0], v[1], v[2]);
    if (touching) for (let k = 0; k < 3; k++) v[k] *= Math.exp(-FRICTION * dt);
    rolling = touching ? speed : 0;

    // 壁に触れたまま 0.3 秒ほとんど動かなければ眠らせて、計算と描画を休む。
    quiet = touching ? quiet + dt : 0;
    if (quiet > 0.3) {
      const moved = Math.hypot(p[0] - anchor[0], p[1] - anchor[1], p[2] - anchor[2]);
      anchor[0] = p[0];
      anchor[1] = p[1];
      anchor[2] = p[2];
      quiet = 0;
      if (moved < 0.08) {
        v[0] = v[1] = v[2] = 0;
        sleepG = [gravity[0], gravity[1], gravity[2]];
        rolling = 0;
      }
    }
    return impact;
  }

  return {
    reset,
    hold,
    release,
    step,
    pos: p,
    get free() {
      return free;
    },
    get moving() {
      return free && !sleepG;
    },
    // 壁に沿って転がっている速さ (mm/s)。転がる音に使う。
    get rolling() {
      return rolling;
    },
  };
}
