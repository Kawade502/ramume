// 効果音はすべて Web Audio で合成する（音声ファイルは使わない）。
//   ポン      ビー玉が外れた瞬間。空気の抜ける音と、瓶の中で響く低い音
//   カラン    ビー玉が凹みに当たって跳ねるたび。ガラスの澄んだ倍音
//   シュワ    液の中で泡がはじける細かいパチパチと、吹き出す瞬間のシャー
//   ブクブク  キャップからあふれる泡
//   コロコロ  ビー玉が瓶の内側を転がっている間
//   ゴクッ    ひと口飲むたび
//   コポッ    飲んで口から空気が入り、大きな泡が上るとき
//   カチッ    玉押しを押し始めたとき
//   コトッ    新しい瓶を置いたとき

function makeNoise(ctx, seconds) {
  const buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

// 泡がはじける音：まばらな、減衰の速い高い音の粒を並べたもの。
function makeCrackle(ctx, seconds, perSecond) {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.round(sr * seconds), sr);
  const d = buf.getChannelData(0);
  const p = perSecond / sr;
  for (let i = 0; i < d.length; i++) {
    if (Math.random() >= p) continue;
    const a = (0.15 + 0.85 * Math.random() ** 2) * (Math.random() < 0.5 ? -1 : 1);
    const f = 1800 + Math.random() * 7000;
    const tau = sr * (0.0008 + Math.random() * 0.003);
    const len = Math.min(Math.round(tau * 5), d.length - i);
    for (let k = 0; k < len; k++) d[i + k] += a * Math.exp(-k / tau) * Math.sin((2 * Math.PI * f * k) / sr);
  }
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  for (let i = 0; i < d.length; i++) d[i] *= 0.9 / (peak || 1);
  return buf;
}

// AudioContext でも OfflineAudioContext でも使えるように、音を作る部分だけを分けておく。
export function createVoices(ctx, out) {
  const noise = makeNoise(ctx, 2);
  const crackle = makeCrackle(ctx, 4, 220);

  const gainAt = (t, peak, attack, decay) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    g.connect(out);
    return g;
  };

  const noiseAt = (t, dur) => {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.start(t, Math.random() * Math.max(0, noise.duration - dur), dur);
    return src;
  };

  const tone = (t, type, f0, f1, glide, peak, attack, decay) => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t + glide);
    osc.connect(gainAt(t, peak, attack, decay));
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
  };

  function pop(t, s = 1) {
    // 栓が抜けて空気がはじける「ポッ」。
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.1;
    bp.frequency.setValueAtTime(1500, t);
    bp.frequency.exponentialRampToValueAtTime(650, t + 0.08);
    noiseAt(t, 0.2).connect(bp).connect(gainAt(t, 0.6 * s, 0.002, 0.1));
    // 瓶の中で響く「ン」。
    tone(t, 'sine', 620, 230, 0.06, 0.85 * s, 0.003, 0.3);
    tone(t, 'triangle', 930, 345, 0.06, 0.12 * s, 0.003, 0.16);
    tone(t, 'sine', 120, 60, 0.08, 0.4 * s, 0.002, 0.1);
    // ガスが抜ける「シュッ」。
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2600;
    noiseAt(t + 0.04, 0.8).connect(hp).connect(gainAt(t + 0.04, 0.1 * s, 0.05, 0.6));
  }

  function clink(t, v = 1) {
    // ガラス玉どうしの、整数倍にならない澄んだ倍音。
    const k = 0.96 + Math.random() * 0.08;
    const partials = [
      [2890, 0.5, 0.35],
      [4620, 0.32, 0.22],
      [6370, 0.2, 0.14],
      [8150, 0.12, 0.09],
    ];
    for (const [f, a, d] of partials) tone(t, 'sine', f * k, f * k, 0, a * v * 0.8, 0.001, d * (0.6 + 0.4 * v));
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    noiseAt(t, 0.01).connect(hp).connect(gainAt(t, 0.3 * v, 0.0005, 0.006));
  }

  function click(t) {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2300;
    bp.Q.value = 3;
    noiseAt(t, 0.03).connect(bp).connect(gainAt(t, 0.5, 0.001, 0.02));
    tone(t, 'sine', 1250, 1250, 0, 0.1, 0.001, 0.012);
  }

  function gulp(t) {
    // のどを通る低い「ゴクッ」。
    tone(t, 'sine', 170, 80, 0.09, 0.55, 0.004, 0.14);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 350;
    noiseAt(t, 0.08).connect(lp).connect(gainAt(t, 0.3, 0.003, 0.06));
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1200;
    bp.Q.value = 2;
    noiseAt(t, 0.02).connect(bp).connect(gainAt(t, 0.12, 0.001, 0.01));
  }

  // 泡が生まれたときの「コポッ」。大きい泡ほど低い（半径 r mm）。
  function glug(t, r = 4) {
    const f = Math.min(1600, 3260 / r);
    tone(t, 'sine', f * 0.85, f * 1.6, 0.06, 0.35, 0.002, 0.1);
  }

  function thunk(t) {
    tone(t, 'sine', 190, 95, 0.06, 0.5, 0.002, 0.15);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 500;
    noiseAt(t, 0.04).connect(lp).connect(gainAt(t, 0.35, 0.001, 0.03));
    tone(t, 'sine', 1420, 1420, 0, 0.03, 0.002, 0.25);
  }

  // シュワシュワは鳴らしっぱなしにして、音量だけを動かす。
  const layer = (buf, rate, type, freq) => {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.playbackRate.value = rate;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(filt).connect(g).connect(out);
    return { src, g };
  };
  const hiss = layer(noise, 1, 'highpass', 4200);
  const crack = layer(crackle, 1, 'highpass', 1500);
  const gurgle = layer(crackle, 0.4, 'lowpass', 1100);
  // 転がる音：ガラスどうしがこすれる細かなコツコツと、低いゴロゴロ。
  const rollTick = layer(crackle, 0.3, 'bandpass', 1500);
  const rollRumble = layer(noise, 1, 'lowpass', 260);

  const fizz = {
    start(t) {
      hiss.src.start(t);
      crack.src.start(t, 1.3);
      gurgle.src.start(t, 2.6);
      rollTick.src.start(t, 0.7);
      rollRumble.src.start(t, 0.4);
    },
    // pressure: 吹き出しの勢い, trail: 残ったシュワシュワ, overflow: あふれる泡の量（どれも 0〜1）
    set(pressure, trail, overflow, t) {
      hiss.g.gain.setTargetAtTime(0.16 * pressure ** 1.6, t, 0.06);
      crack.g.gain.setTargetAtTime(0.55 * Math.min(1, 0.9 * pressure + 0.6 * trail), t, 0.08);
      gurgle.g.gain.setTargetAtTime(0.5 * overflow * Math.sqrt(pressure), t, 0.08);
    },
  };

  // speed: ビー玉が転がる速さ (mm/s)
  const roll = {
    set(speed, t) {
      const a = Math.min(1, speed / 260);
      rollTick.g.gain.setTargetAtTime(0.45 * a, t, 0.05);
      rollTick.src.playbackRate.setTargetAtTime(0.2 + 0.35 * a, t, 0.05);
      rollRumble.g.gain.setTargetAtTime(0.18 * a, t, 0.05);
    },
  };

  return { pop, clink, click, thunk, gulp, glug, fizz, roll };
}

const MUTE_KEY = 'ramune:muted';

export function createSound() {
  let ctx = null;
  let master = null;
  let voices = null;
  let muted = false;
  try {
    muted = localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    // 保存できない環境では毎回音ありで始める。
  }

  // ブラウザは操作があるまで音を出させないので、最初のクリックやキー入力で作る。
  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.9;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp).connect(ctx.destination);
      voices = createVoices(ctx, master);
      voices.fizz.start(ctx.currentTime);
    }
    if (ctx.state === 'suspended') ctx.resume();
  }

  const ready = () => ctx && ctx.state === 'running';

  return {
    unlock,
    pop(s) {
      if (ready()) voices.pop(ctx.currentTime, s);
    },
    clink(v) {
      if (ready()) voices.clink(ctx.currentTime, v);
    },
    click() {
      if (ready()) voices.click(ctx.currentTime);
    },
    thunk() {
      if (ready()) voices.thunk(ctx.currentTime);
    },
    gulp() {
      if (ready()) voices.gulp(ctx.currentTime);
    },
    glug(r, delay = 0) {
      if (ready()) voices.glug(ctx.currentTime + delay, r);
    },
    setFizz(pressure, trail, overflow) {
      if (ready()) voices.fizz.set(pressure, trail, overflow, ctx.currentTime);
    },
    setRoll(speed) {
      if (ready()) voices.roll.set(speed, ctx.currentTime);
    },
    pause() {
      if (ctx && ctx.state === 'running') ctx.suspend();
    },
    resume() {
      if (ctx && ctx.state === 'suspended') ctx.resume();
    },
    toggleMute() {
      muted = !muted;
      try {
        localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
      } catch {
        // 保存できなくても切り替え自体はできる。
      }
      if (master) master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.02);
      return muted;
    },
    get muted() {
      return muted;
    },
  };
}
