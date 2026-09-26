/**
 * 本地存档。
 *
 * 必须每次读写都 try/catch：微信无痕模式、iOS 存储满、企业微信内核都会让
 * localStorage 直接抛异常，抛出来就是白屏。全游戏只用一个 key 存一份 JSON，
 * 写入做防抖，不要每帧写。
 */

const KEY = 'crowdedbus.v1';
const SAVE_DEBOUNCE_MS = 600;

export interface Profile {
  v: 1;
  /** 打过多少局。用局数而不是布尔判断要不要出教学：清缓存重来一遍不亏。 */
  matches: number;
  /** 跳过了教学。 */
  tutorialSkipped: boolean;
  best: {
    rank: number;
    score: number;
    knockouts: number;
    seatSeconds: number;
  };
  /** 累计量，用于角色解锁条件。 */
  totals: {
    knockouts: number;
    seatSeconds: number;
    survived: number;
  };
  /** 最近 10 局。 */
  history: { rank: number; score: number; at: number }[];
  /** 音效开关（含震动）。旧存档没有这个字段，read() 按缺省"开"补上，不用升版本。 */
  sound: boolean;
}

const EMPTY: Profile = {
  v: 1,
  matches: 0,
  tutorialSkipped: false,
  best: { rank: 99, score: 0, knockouts: 0, seatSeconds: 0 },
  totals: { knockouts: 0, seatSeconds: 0, survived: 0 },
  history: [],
  sound: true
};

function read(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY, best: { ...EMPTY.best }, totals: { ...EMPTY.totals }, history: [] };
    const p = JSON.parse(raw) as Partial<Profile>;
    if (p.v !== 1) return { ...EMPTY, best: { ...EMPTY.best }, totals: { ...EMPTY.totals }, history: [] };
    return {
      ...EMPTY,
      ...p,
      best: { ...EMPTY.best, ...(p.best ?? {}) },
      totals: { ...EMPTY.totals, ...(p.totals ?? {}) },
      history: Array.isArray(p.history) ? p.history.slice(-10) : [],
      // 只认显式的 false：字段缺失或被写坏都当"开"，宁可有声也别让玩家以为游戏坏了。
      sound: p.sound !== false
    };
  } catch {
    // 存储不可用（无痕/配额满）时退回内存态，游戏照常能玩。
    return { ...EMPTY, best: { ...EMPTY.best }, totals: { ...EMPTY.totals }, history: [] };
  }
}

let cache: Profile | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function getProfile(): Profile {
  if (!cache) cache = read();
  return cache;
}

function writeNow(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* 存不下就算了，不能因此白屏 */
  }
}

export function saveProfile(next: Profile): void {
  cache = next;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, SAVE_DEBOUNCE_MS);
}

export interface MatchOutcome {
  rank: number;
  score: number;
  knockouts: number;
  seatSeconds: number;
  survived: boolean;
}

/**
 * 记录一局结果，返回刷新了哪些纪录（结算页用来打"新纪录"）。
 *
 * 首局只建立基线、不报纪录：以前 best.rank 初始是 99，第一局哪怕倒数第一
 * 也会弹"🎉 新纪录：最好名次 第 8 名"，等于在嘲讽新手。
 */
export function applyMatchResult(o: MatchOutcome): string[] {
  const p = getProfile();
  const records: string[] = [];
  const hasBaseline = p.matches > 0;
  const note = (text: string) => { if (hasBaseline) records.push(text); };
  if (o.rank < p.best.rank) { p.best.rank = o.rank; note(`最好名次 第 ${o.rank} 名`); }
  if (o.score > p.best.score) { p.best.score = o.score; note(`最高分 ${o.score}`); }
  if (o.knockouts > p.best.knockouts) {
    p.best.knockouts = o.knockouts;
    note(`单局最多挤下 ${o.knockouts} 人`);
  }
  if (o.seatSeconds > p.best.seatSeconds) p.best.seatSeconds = o.seatSeconds;
  p.totals.knockouts += o.knockouts;
  p.totals.seatSeconds += o.seatSeconds;
  if (o.survived) p.totals.survived++;
  p.matches++;
  p.history = [...p.history, { rank: o.rank, score: o.score, at: Date.now() }].slice(-10);
  saveProfile(p);
  return records;
}

/** 首局才出教学；玩家点过跳过就永久不再出。 */
export function shouldShowTutorial(): boolean {
  const p = getProfile();
  return p.matches === 0 && !p.tutorialSkipped;
}

export function skipTutorial(): void {
  const p = getProfile();
  p.tutorialSkipped = true;
  saveProfile(p);
}

export function getSoundEnabled(): boolean {
  return getProfile().sound;
}

/**
 * 音效开关立即落盘，不走防抖：这是低频操作，玩家常常点完就切走或关掉页面，
 * 600ms 的防抖窗口里被杀掉，下次打开又是响的。
 */
export function setSoundEnabled(on: boolean): void {
  const p = getProfile();
  p.sound = on;
  cache = p;
  writeNow();
}
