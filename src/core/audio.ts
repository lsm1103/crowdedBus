/**
 * 极简合成音效。
 *
 * 全部用振荡器现场合成，不引入任何音频资源，包体不增加、也没有额外的加载等待。
 * iOS/微信要求音频上下文必须由用户手势解锁，unlock() 会挂在第一次 pointerdown 上。
 */

type Ctx = AudioContext;

let ctx: Ctx | null = null;
let master: GainNode | null = null;
let enabled = true;

const MASTER_GAIN = 0.28;

function ensure(): Ctx | null {
  if (ctx) return ctx;
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = enabled ? MASTER_GAIN : 0;
  master.connect(ctx.destination);
  return ctx;
}

/**
 * 唤醒音频。必须在用户手势里调用，否则 iOS 上永远没声音。
 *
 * 不只是"第一次"：iOS 来电、切后台、插拔耳机都会把 AudioContext 打成 suspended，
 * Safari 上还会是非标准的 'interrupted'。以前只在第一次触摸时唤醒一次，
 * 被打断后点"继续"整局都没声音。现在每次触摸都调用它，已经在播就什么都不做。
 */
export function unlockAudio(): void {
  const c = ensure();
  if (c && (c.state as string) !== 'running' && (c.state as string) !== 'closed') {
    c.resume().catch(() => { /* 没有手势时会被拒绝，等下一次触摸 */ });
  }
}

/**
 * 音效总开关（含震动）。
 *
 * 只拦新音效不够"立刻生效"：点火声 2 秒多、叮咚尾音半秒多，关掉的那一刻还在响。
 * 所以同时把总音量推到 0（10ms 时间常数，不会有爆音），并取消正在进行的震动。
 */
export function setAudioEnabled(v: boolean): void {
  enabled = v;
  if (ctx && master) {
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setValueAtTime(master.gain.value, t);
    master.gain.setTargetAtTime(v ? MASTER_GAIN : 0, t, 0.01);
  }
  if (!v) {
    try {
      navigator.vibrate?.(0);
    } catch {
      /* 平台不支持 */
    }
  }
}

export function isAudioEnabled(): boolean {
  return enabled;
}

interface ToneOpts {
  freq: number;
  to?: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  delay?: number;
}

function tone({ freq, to, dur, type = 'sine', gain = 1, delay = 0 }: ToneOpts) {
  // 先判开关再 ensure()：静音状态下不该为了一个不播的音去建 AudioContext。
  if (!enabled) return;
  const c = ensure();
  if (!c || !master) return;
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

function noise(dur: number, gain = 0.5, delay = 0) {
  if (!enabled) return;
  const c = ensure();
  if (!c || !master) return;
  const n = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, n, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(g).connect(master);
  src.start(c.currentTime + delay);
}

/**
 * 气动"嗤"声：带通滤波的噪声，中心频率从高往低扫，快起慢收。
 * 直接放白噪声像电视雪花；只留 2~6kHz 并往下扫，才像门泵泄气。
 * 带通滤掉了大部分能量，所以 gain 要比 noise() 的同等响度给得高一些。
 */
function hiss(dur: number, gain: number, delay = 0, fromHz = 6000, toHz = 2400) {
  if (!enabled) return;
  const c = ensure();
  if (!c || !master) return;
  const t0 = c.currentTime + delay;
  const n = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, n, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 0.9;
  f.frequency.setValueAtTime(fromHz, t0);
  f.frequency.exponentialRampToValueAtTime(toHz, t0 + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.025);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

/** 手机震动；不支持的平台（iOS Safari）自动跳过。 */
export function vibrate(pattern: number | number[]): void {
  if (!enabled) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* 平台不支持 */
  }
}

export const SFX = {
  push() {
    tone({ freq: 220, to: 70, dur: 0.16, type: 'square', gain: 0.5 });
    noise(0.12, 0.32);
    vibrate(18);
  },
  hit() {
    tone({ freq: 150, to: 60, dur: 0.2, type: 'sawtooth', gain: 0.45 });
    vibrate(30);
  },
  dash() {
    tone({ freq: 420, to: 900, dur: 0.16, type: 'triangle', gain: 0.34 });
  },
  grab() {
    tone({ freq: 660, to: 880, dur: 0.11, type: 'sine', gain: 0.3 });
  },
  release() {
    tone({ freq: 520, to: 330, dur: 0.1, type: 'sine', gain: 0.24 });
  },
  skill() {
    tone({ freq: 520, to: 1040, dur: 0.22, type: 'triangle', gain: 0.38 });
    tone({ freq: 780, dur: 0.18, type: 'sine', gain: 0.22, delay: 0.06 });
  },
  warn() {
    tone({ freq: 880, dur: 0.1, type: 'square', gain: 0.3 });
    tone({ freq: 880, dur: 0.1, type: 'square', gain: 0.3, delay: 0.16 });
    vibrate([20, 60, 20]);
  },
  /**
   * 开门"叮咚"：高音到低音的大三度（B5 → G5），正弦 + 一层弱的二倍频泛音做出铃声感。
   * 刻意和 warn() 的方波嘀嘀区分开：门开是全局最致命的信号，一听就要知道是"门"。
   */
  doorOpen() {
    tone({ freq: 988, dur: 0.5, type: 'sine', gain: 0.36 });
    tone({ freq: 1976, dur: 0.22, type: 'sine', gain: 0.07 });
    tone({ freq: 784, dur: 0.75, type: 'sine', gain: 0.36, delay: 0.3 });
    tone({ freq: 1568, dur: 0.3, type: 'sine', gain: 0.07, delay: 0.3 });
    vibrate([25, 70, 25]);
  },
  /** 关门：两声短促的"嘀嘀" + 门泵泄气的"嗤"。 */
  doorClose() {
    tone({ freq: 1245, dur: 0.07, type: 'triangle', gain: 0.3 });
    tone({ freq: 1245, dur: 0.07, type: 'triangle', gain: 0.3, delay: 0.11 });
    hiss(0.42, 0.42, 0.24);
  },
  eliminate() {
    tone({ freq: 300, to: 90, dur: 0.42, type: 'sawtooth', gain: 0.42 });
    noise(0.3, 0.3);
    vibrate([40, 40, 80]);
  },
  respawn() {
    tone({ freq: 300, to: 720, dur: 0.28, type: 'triangle', gain: 0.34 });
  },
  fail() {
    tone({ freq: 240, to: 170, dur: 0.12, type: 'square', gain: 0.22 });
  },
  ignition() {
    // 起动机空转 + 发动机点着：一段短促的上扬轰鸣。
    tone({ freq: 70, to: 120, dur: 1.0, type: 'sawtooth', gain: 0.3 });
    noise(0.55, 0.16);
    tone({ freq: 110, to: 88, dur: 1.4, type: 'triangle', gain: 0.22, delay: 0.9 });
    vibrate([60, 40, 120]);
  },
  start() {
    tone({ freq: 440, dur: 0.12, type: 'triangle', gain: 0.34 });
    tone({ freq: 660, dur: 0.16, type: 'triangle', gain: 0.34, delay: 0.13 });
  },
  finish() {
    tone({ freq: 523, dur: 0.16, type: 'triangle', gain: 0.36 });
    tone({ freq: 659, dur: 0.16, type: 'triangle', gain: 0.36, delay: 0.15 });
    tone({ freq: 784, dur: 0.3, type: 'triangle', gain: 0.36, delay: 0.3 });
  }
};

/**
 * 引擎声：持续的低频循环，跟着车速变。
 *
 * 两个低频振荡器（锯齿 + 方波，1:1.5）过低通 = 柴油机的"突突"底噪；
 * 一路带通噪声 = 路噪，只在车动起来时出现。车速越快音高越高、滤波越开；
 * 加速时额外多吼一点（throttle）。整条链接在总音量下面，静音开关自动生效。
 */
interface EngineNodes {
  oscA: OscillatorNode;
  oscB: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  noise: AudioBufferSourceNode;
  noiseFilter: BiquadFilterNode;
  noiseGain: GainNode;
  lfo: OscillatorNode;
  lfoGain: GainNode;
}

let engine: EngineNodes | null = null;
let engineWanted = false;
let enginePaused = false;

function buildEngine(c: Ctx): EngineNodes {
  const oscA = c.createOscillator();
  oscA.type = 'sawtooth';
  const oscB = c.createOscillator();
  oscB.type = 'square';
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 1.2;
  const gain = c.createGain();
  gain.gain.value = 0;
  // 低频颤动：柴油机怠速时那种一顿一顿的感觉。
  const lfo = c.createOscillator();
  lfo.frequency.value = 7;
  const lfoGain = c.createGain();
  lfoGain.gain.value = 0;
  lfo.connect(lfoGain);
  lfoGain.connect(gain.gain);
  oscA.connect(filter);
  oscB.connect(filter);
  filter.connect(gain);
  gain.connect(master!);

  const len = Math.floor(c.sampleRate * 1.5);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const noise = c.createBufferSource();
  noise.buffer = buf;
  noise.loop = true;
  const noiseFilter = c.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.Q.value = 0.8;
  const noiseGain = c.createGain();
  noiseGain.gain.value = 0;
  noise.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(master!);

  const t = c.currentTime;
  oscA.start(t);
  oscB.start(t);
  lfo.start(t);
  noise.start(t);
  return { oscA, oscB, filter, gain, noise, noiseFilter, noiseGain, lfo, lfoGain };
}

export const Engine = {
  /** 开局点着引擎（怠速）。静音时不建 AudioContext，之后打开音效会在下一次 set() 时补建。 */
  start() {
    engineWanted = true;
    enginePaused = false;
  },

  /**
   * 每帧调用。speed：车速（满速 = 1）；throttle：加速度（车速/秒，正 = 在加速）。
   * 目标值用 setTargetAtTime 平滑逼近，每帧都调也不会有爆音。
   */
  set(speed: number, throttle: number) {
    if (!engineWanted) return;
    if (!engine) {
      if (!enabled) return;
      const c = ensure();
      if (!c || !master) return;
      engine = buildEngine(c);
    }
    const c = ctx!;
    const t = c.currentTime;
    const s = Math.max(0, Math.min(1.2, speed));
    const rev = Math.max(0, Math.min(1, throttle / 1.2));
    const on = enginePaused ? 0 : 1;
    const f = 32 + 30 * s + 12 * rev;
    engine.oscA.frequency.setTargetAtTime(f, t, 0.12);
    engine.oscB.frequency.setTargetAtTime(f * 1.5, t, 0.12);
    engine.filter.frequency.setTargetAtTime(150 + 380 * s + 250 * rev, t, 0.12);
    engine.gain.gain.setTargetAtTime(on * (0.1 + 0.05 * s + 0.06 * rev), t, 0.1);
    engine.lfo.frequency.setTargetAtTime(7 + 9 * s, t, 0.2);
    engine.lfoGain.gain.setTargetAtTime(on * 0.035 * (1 - 0.7 * s), t, 0.2);
    engine.noiseFilter.frequency.setTargetAtTime(260 + 500 * s, t, 0.2);
    engine.noiseGain.gain.setTargetAtTime(on * 0.09 * s, t, 0.15);
  },

  /** 暂停时引擎和路噪一起静下来，继续时由下一次 set() 拉回。 */
  pause(p: boolean) {
    enginePaused = p;
    if (!engine || !ctx) return;
    const t = ctx.currentTime;
    for (const g of [engine.gain.gain, engine.noiseGain.gain, engine.lfoGain.gain]) {
      g.cancelScheduledValues(t);
      g.setTargetAtTime(p ? 0 : g.value, t, 0.05);
    }
  },

  /** 熄火：淡出后停掉所有节点。 */
  stop() {
    engineWanted = false;
    const e = engine;
    engine = null;
    if (!e || !ctx) return;
    const t = ctx.currentTime;
    for (const g of [e.gain.gain, e.noiseGain.gain, e.lfoGain.gain]) {
      g.cancelScheduledValues(t);
      g.setTargetAtTime(0, t, 0.12);
    }
    for (const n of [e.oscA, e.oscB, e.lfo, e.noise]) {
      try {
        n.stop(t + 0.8);
      } catch {
        /* 已停 */
      }
    }
  }
};
