/**
 * 本地存档。
 *
 * 必须每次读写都 try/catch：微信无痕模式、iOS 存储满、企业微信内核都会让
 * localStorage 直接抛异常，抛出来就是白屏。全游戏只用一个 key 存一份 JSON，
 * 写入做防抖，不要每帧写。
 *
 * v2（派对玩法，docs/08）：记的是"整场"的结果 —— 先赢 3 回合拿下整场，没有积分。
 * v1 存档（旧玩法：名次、积分、坐座秒数）读到时只保留音效开关，其余从零开始：
 * 旧数据在新规则下没有意义；教学也要重新出一次，因为操作（抓 / 推·扔 / 冲）整个换了。
 */

const KEY = 'crowdedbus.v1';
const SAVE_DEBOUNCE_MS = 600;

export interface Profile {
  v: 2;
  /** 打完的整场数。用局数而不是布尔判断要不要出教学：清缓存重来一遍不亏。 */
  matches: number;
  /** 拿下的整场数。 */
  wins: number;
  /** 累计打过的回合数。 */
  rounds: number;
  /** 累计赢下的回合数。 */
  roundWins: number;
  /** 累计扔 / 挤下车的人数。 */
  throwOuts: number;
  /** 当前整场连胜。 */
  streak: number;
  /** 最好成绩（单场）。 */
  best: {
    /** 单场最多扔下车几人。 */
    throwOuts: number;
    /** 单场最多赢几回合（拿下整场时就是先赢的回合数）。 */
    roundWins: number;
    /** 最长整场连胜。 */
    streak: number;
  };
  /** 上次用的角色：回大厅时默认选中它。 */
  lastCharId: string | null;
  /** 跳过了教学。 */
  tutorialSkipped: boolean;
  /** 最近 10 场。 */
  history: { won: boolean; roundWins: number; throwOuts: number; at: number }[];
  /** 音效开关（含震动）。字段缺失按"开"补上。 */
  sound: boolean;
}

const fresh = (): Profile => ({
  v: 2,
  matches: 0,
  wins: 0,
  rounds: 0,
  roundWins: 0,
  throwOuts: 0,
  streak: 0,
  best: { throwOuts: 0, roundWins: 0, streak: 0 },
  lastCharId: null,
  tutorialSkipped: false,
  history: [],
  sound: true
});

/** 非负整数，读坏了（NaN、负数、字符串）一律按 0。 */
const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

/** 只认显式的 false：字段缺失或被写坏都当"开"，宁可有声也别让玩家以为游戏坏了。 */
const soundOf = (raw: Record<string, unknown>): boolean => raw.sound !== false;

/** 把任意 JSON 规整成 v2 存档：缺什么补默认值，类型不对的丢掉。 */
function normalize(raw: Record<string, unknown>): Profile {
  const p = fresh();
  p.sound = soundOf(raw);
  if (raw.v !== 2) return p; // v1 或更早：只保留音效开关
  p.matches = count(raw.matches);
  p.wins = Math.min(count(raw.wins), p.matches);
  p.rounds = count(raw.rounds);
  p.roundWins = Math.min(count(raw.roundWins), p.rounds);
  p.throwOuts = count(raw.throwOuts);
  p.streak = count(raw.streak);
  const best = (raw.best && typeof raw.best === 'object' ? raw.best : {}) as Record<string, unknown>;
  p.best = {
    throwOuts: count(best.throwOuts),
    roundWins: count(best.roundWins),
    streak: Math.max(count(best.streak), p.streak)
  };
  // 主播小麦改名时尚姐阿娇（id 跟角色工程统一成 ajia）。
  p.lastCharId = raw.lastCharId === 'xiaomai' ? 'ajia' : typeof raw.lastCharId === 'string' ? raw.lastCharId : null;
  p.tutorialSkipped = raw.tutorialSkipped === true;
  p.history = Array.isArray(raw.history)
    ? raw.history
      .filter((h): h is Record<string, unknown> => !!h && typeof h === 'object')
      .map((h) => ({
        won: h.won === true,
        roundWins: count(h.roundWins),
        throwOuts: count(h.throwOuts),
        at: count(h.at)
      }))
      .slice(-10)
    : [];
  return p;
}

function read(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fresh();
    return normalize(parsed as Record<string, unknown>);
  } catch {
    // 存储不可用（无痕/配额满）或 JSON 写坏了：退回内存态，游戏照常能玩。
    return fresh();
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

/** 一整场（先赢 3 回合的那一场）的结果。 */
export interface MatchOutcome {
  charId: string;
  /** 拿下了整场。 */
  won: boolean;
  /** 这一场打了几回合。 */
  rounds: number;
  /** 玩家赢了几回合。 */
  roundWins: number;
  /** 整场把几个人扔 / 挤下车。 */
  throwOuts: number;
}

/**
 * 记录一整场结果，返回刷新了哪些纪录（结算页用来打"新纪录"）。
 *
 * 首局只建立基线、不报纪录：否则第一场哪怕一回合没赢，也会弹"新纪录"，等于在嘲讽新手。
 * 拿下整场时"单场最多赢几回合"必然刷新，不单独报（"拿下整场"本身更响亮）。
 */
export function applyMatchResult(o: MatchOutcome): string[] {
  const p = getProfile();
  const records: string[] = [];
  const hasBaseline = p.matches > 0;
  const note = (text: string) => { if (hasBaseline) records.push(text); };
  const throwOuts = count(o.throwOuts);
  const roundWins = count(o.roundWins);

  if (o.won) {
    if (p.wins === 0) note('第一次拿下整场');
    p.wins++;
    p.streak++;
    if (p.streak > p.best.streak) {
      p.best.streak = p.streak;
      if (p.streak >= 2) note(`连胜 ${p.streak} 场`);
    }
  } else {
    p.streak = 0;
  }
  if (throwOuts > p.best.throwOuts) {
    p.best.throwOuts = throwOuts;
    note(`单场扔下车 ${throwOuts} 人`);
  }
  if (roundWins > p.best.roundWins) {
    p.best.roundWins = roundWins;
    if (!o.won) note(`单场赢了 ${roundWins} 回合`);
  }

  p.matches++;
  p.rounds += count(o.rounds);
  p.roundWins += roundWins;
  p.throwOuts += throwOuts;
  p.lastCharId = o.charId;
  p.history = [...p.history, { won: o.won, roundWins, throwOuts, at: Date.now() }].slice(-10);
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
