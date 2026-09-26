import type { Profile } from '../core/storage';

/**
 * 角色解锁。
 *
 * 首发只开 3 个技能最直观的角色。这不只是留存钩子 —— 它顺手解决了另一个问题：
 * 玩家一进大厅面对 8 个陌生角色 + 8 个陌生技能，是典型的选择瘫痪。少即是多。
 *
 * 心理定位上刻意**不做成"稀缺资源"**，而是"逐步展开"：存档只在 localStorage，
 * 清缓存/换设备就没了，做成稀缺的话丢了会很难受。
 */
export interface UnlockRule {
  id: string;
  desc: string;
  test: (p: Profile) => boolean;
  progress: (p: Profile) => string;
}

/** 首发就能选的。 */
export const STARTERS = ['xiaoli', 'xiaoxia', 'aqiang'];

export const UNLOCKS: UnlockRule[] = [
  {
    // 以前是"累计挤下 5 人"：抢座类打法一局挤下 0 人，几乎永远解不了。
    // "推中"对所有打法都可达（拽座、守门、乱推都在推人），又体现"挤"。
    // 老存档里已经按旧条件解锁的保留（knockouts ≥ 5 仍算）。
    id: 'lanjie', desc: '累计推中别人 20 次',
    test: (p) => (p.totals.pushHits ?? 0) >= 20 || p.totals.knockouts >= 5,
    progress: (p) => `${Math.min(20, p.totals.pushHits ?? 0)}/20 次`
  },
  {
    id: 'ayuan', desc: '单局撑到终点 1 次',
    test: (p) => p.totals.survived >= 1,
    progress: (p) => `${Math.min(1, p.totals.survived)}/1 次`
  },
  {
    id: 'xiaomai', desc: '累计玩 6 局',
    test: (p) => p.matches >= 6,
    progress: (p) => `${Math.min(6, p.matches)}/6 局`
  },
  {
    id: 'amo', desc: '累计坐座位 60 秒',
    test: (p) => p.totals.seatSeconds >= 60,
    progress: (p) => `${Math.min(60, p.totals.seatSeconds)}/60 秒`
  },
  {
    id: 'laozhou', desc: '拿到 1 次第 1 名',
    test: (p) => p.best.rank <= 1,
    progress: (p) => (p.best.rank <= 1 ? '已达成' : '还没拿过第 1')
  }
];

export function isUnlocked(id: string, p: Profile): boolean {
  if (STARTERS.includes(id)) return true;
  const rule = UNLOCKS.find((u) => u.id === id);
  return rule ? rule.test(p) : true;
}

export function unlockRule(id: string): UnlockRule | undefined {
  return UNLOCKS.find((u) => u.id === id);
}
