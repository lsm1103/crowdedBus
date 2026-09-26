/** 随机事件池（对应 docs/02-game-design.md 第 7 节）。 */
export type EventKind = 'brake' | 'turn' | 'boarding' | 'luggage' | 'doorfault';

export interface EventDef {
  kind: EventKind;
  label: string;
  warnText: string;
  /** 作用持续时间（秒）；brake/turn 为瞬时冲量 + 短滑动。 */
  duration: number;
  /** 是否扩大车门危险区。 */
  expandDoor?: 'front' | 'back';
}

export const EVENTS: Record<EventKind, EventDef> = {
  // 急刹：这一站刹得更猛（见 BALANCE.emergencyBrakeRate），推人的是刹车本身的惯性，
  // 不再是预警结束后补一下的冲量。duration 只用来让事件在界面上多挂一会儿。
  brake: { kind: 'brake', label: '急刹车', warnText: '急刹车，抓稳扶手！', duration: 1.1 },
  // 急转弯不在到站事件池里：它在行驶途中（车速接近满速时）单独触发，方向写进横幅，
  // duration 由 BALANCE.turnDuration 决定，这里的值不用。
  turn: { kind: 'turn', label: '急转弯', warnText: '前方急转弯！', duration: 1.2 },
  boarding: { kind: 'boarding', label: '下一站上人', warnText: '人更多了！', duration: 1.0 },
  luggage: { kind: 'luggage', label: '大件行李', warnText: '小心行李！', duration: 2.5 },
  // expandDoor 交给运行时按对局种子决定：写死在模块里会让整场游戏永远开同一扇门，
  // 也破坏了 Simulation 里 mulberry32 的确定性。
  doorfault: { kind: 'doorfault', label: '车门故障', warnText: '车门危险区扩大！', duration: 4 }
};
