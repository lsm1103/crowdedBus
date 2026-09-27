import { Simulation, type RosterEntry } from './simulation';
import type { RoundResult } from './types';

/**
 * 整场（docs/08 第 3.3、6.1 节）：按回合打，先赢 winsNeeded 回合的人拿下整场。
 *
 * 一回合的赢家：只剩 1 人时是他；到终点时是所有还在车上的人（每人各记 1 胜）；
 * 全灭时是最后一个下车的人。所以可能几个人同一回合一起到达 winsNeeded ——
 * 这时先比胜场，再比"本回合赢了没有"，还分不出就比整场扔下车的人数，最后按出场顺序。
 */
export class Match {
  readonly roster: RosterEntry[];
  readonly winsNeeded: number;
  /** 每人的回合胜场（下标 = 角色 id = roster 下标）。 */
  readonly wins: number[];
  /** 每人整场累计把几个人扔 / 挤下了车。 */
  readonly throwOuts: number[];
  /** 已记录的每回合结果。 */
  readonly history: RoundResult[] = [];
  /** 当前回合数（第一次 newRound 之后为 1）。 */
  round = 0;
  champion: number | null = null;

  constructor(roster: RosterEntry[], winsNeeded = 3) {
    this.roster = roster.slice();
    this.winsNeeded = winsNeeded;
    this.wins = roster.map(() => 0);
    this.throwOuts = roster.map(() => 0);
  }

  /** 开新的一回合：返回已 setup 好的模拟。seed 显式传入时整回合可复现。 */
  newRound(seed?: number): Simulation {
    const s = seed ?? Math.floor(Math.random() * 0xffffffff);
    const sim = new Simulation(s);
    sim.setup(this.roster, s);
    this.round++;
    return sim;
  }

  /** 记下本回合赢家（回合必须已结束）并返回结果；同一回合重复记录无效。 */
  recordRound(sim: Simulation): RoundResult {
    const r = sim.roundResult();
    if (!r) throw new Error('回合还没结束，不能记录');
    if (this.history.length >= this.round) return this.history[this.history.length - 1];
    this.history.push({ winners: r.winners.slice(), eliminated: r.eliminated.slice() });
    for (const id of r.winners) if (id >= 0 && id < this.wins.length) this.wins[id]++;
    for (const c of sim.characters) if (c.id < this.throwOuts.length) this.throwOuts[c.id] += c.throwOuts;
    if (this.champion === null) this.champion = this.pickChampion(r.winners);
    return r;
  }

  /** 某人的回合胜场。 */
  winsOf(id: number): number {
    return this.wins[id] ?? 0;
  }

  get over(): boolean {
    return this.champion !== null;
  }

  private pickChampion(roundWinners: number[]): number | null {
    const cands = this.wins.map((w, id) => ({ w, id })).filter((x) => x.w >= this.winsNeeded);
    if (cands.length === 0) return null;
    const won = new Set(roundWinners);
    cands.sort((a, b) =>
      b.w - a.w
      || Number(won.has(b.id)) - Number(won.has(a.id))
      || this.throwOuts[b.id] - this.throwOuts[a.id]
      || a.id - b.id);
    return cands[0].id;
  }
}
