import type { Vec2 } from '../core/math';
import type { EventKind } from '../config/events';

/**
 * 规则层对外的数据约定（docs/08-派对玩法重构.md 第 6.4 节）。
 * 画面层、界面层、会话层只通过这里的类型读规则层；改字段要同步改文档。
 */

export type Phase = 'boarding' | 'ignition' | 'driving' | 'finale' | 'ended';

/**
 * - down：平衡值掉光摔倒，瘫着，最容易被抓起来拖走；
 * - carried：摔倒后被人抓着拖走；
 * - thrown：被扔出去，正在空中（落地后转 down）；
 * - sitting：坐在座位上，免疫机关和推挤，不能出手。
 */
export type CharacterStatus =
  | 'idle'
  | 'walking'
  | 'dashing'
  | 'down'
  | 'carried'
  | 'thrown'
  | 'sitting'
  | 'eliminated';

/** 手里抓着的东西。 */
export type HoldTarget = { kind: 'rail'; id: number } | { kind: 'char'; id: number };

export interface CharacterState {
  id: number;
  isPlayer: boolean;
  defId: string;
  name: string;
  color: string;
  pos: Vec2;
  vel: Vec2;
  facing: number;
  radius: number;
  status: CharacterStatus;
  /** 还在车上（本回合没被淘汰）。 */
  alive: boolean;
  /** 平衡值 0~1：被推、被撞、被晃都会掉，掉光摔倒。画面层用它控制踉跄幅度。 */
  balance: number;
  /** 摔倒剩余秒数（status 为 down / carried 时有效）。 */
  downTimer: number;
  /** 被扔出去后已飞行时间 / 总滞空时间（status 为 thrown 时有效），画面层画抛物线。 */
  airT: number;
  airDur: number;
  /** 我抓着什么。 */
  hold: HoldTarget | null;
  /** 谁抓着我（角色 id），没有为 null。 */
  heldBy: number | null;
  /** 坐着的座位 id。 */
  seatId: number | null;
  dashCd: number;
  pushCd: number;
  /** 被推后的短硬直：>0 时操作被大幅削弱。 */
  stunTimer: number;
  /** 淘汰顺序（1 = 本回合第一个下车），没被淘汰为 0。 */
  eliminatedOrder: number;
  /** 最后一次把我推中/扔出去的人，用于击落归属。 */
  lastHitBy: number | null;
  lastHitAt: number;
  /** 本回合把几个人扔 / 挤下了车。 */
  throwOuts: number;
}

export type NpcStatus = 'boarding' | 'riding' | 'sitting' | 'leaving';

/** 路人乘客：场景机关的一部分，不是玩家也不是机器人对手。下车后从列表里移除。 */
export interface NpcState {
  id: number;
  pos: Vec2;
  vel: Vec2;
  facing: number;
  radius: number;
  status: NpcStatus;
  seatId: number | null;
  /** 外观编号（画面层据此挑配色）。 */
  look: number;
}

/** 座位的实时占用情况。 */
export interface SeatInfo {
  id: number;
  x: number;
  z: number;
  /** 坐着时的朝向（弧度，0 = +z 车头方向，π/2 = +x 车门一侧）。 */
  facing: number;
  occupant: 'none' | 'player' | 'bot' | 'npc';
}

/** 离玩家最近的空座。 */
export interface SeatGuide {
  id: number;
  x: number;
  z: number;
  dist: number;
  /** 已经够得着：此时按"抓"就是坐下。 */
  inReach: boolean;
}

/** 到站类型：上客潮 / 下客潮 / 普通。 */
export type StationKind = 'board' | 'alight' | 'normal';

export interface ActiveEvent {
  kind: EventKind;
  label: string;
  warnRemaining: number;
  remaining: number;
  /** 急转弯的甩向：+1 朝 +x 车门一侧，-1 朝 -x；其它事件为 0。 */
  side: number;
}

/**
 * 横幅优先级：屏幕上只有一个横幅位，同帧/相邻帧的多条必须排队。
 * 3 = 与玩家直接相关或改变规则；2 = 普通局势；1 = 氛围提示，可以被挤掉。
 */
export type BannerPrio = 1 | 2 | 3;

/** 一帧内产生的瞬态表现事件（供画面、音效、横幅消费）。 */
export type GameEvent =
  | { type: 'banner'; text: string; prio: BannerPrio; charId?: number }
  | { type: 'push'; charId: number }
  | { type: 'dash'; charId: number }
  | { type: 'hit'; charId: number; byId: number }
  | { type: 'knockdown'; charId: number; byId: number | null }
  | { type: 'grab'; charId: number; target: HoldTarget }
  | { type: 'grabFail'; charId: number }
  | { type: 'release'; charId: number }
  | { type: 'throw'; byId: number; victimId: number }
  /** 把坐着的人拽了起来。 */
  | { type: 'yank'; byId: number; victimId: number }
  | { type: 'sit'; charId: number; seatId: number }
  | { type: 'stand'; charId: number }
  /** byId：击落归属（被扔出去或被推下去的最后一个出手者），环境导致为 null。 */
  | { type: 'eliminate'; charId: number; byId: number | null }
  | { type: 'eventStart'; kind: EventKind }
  | { type: 'station'; kind: StationKind }
  | { type: 'npcBoard'; count: number }
  | { type: 'npcAlight'; count: number }
  | { type: 'roundEnd'; winners: number[] };

/** 一回合的结果。 */
export interface RoundResult {
  /** 赢家（只剩 1 人时是他；到终点时是所有还在车上的人；全灭时是最后一个下车的人）。 */
  winners: number[];
  /** 淘汰顺序（先下车的在前）。 */
  eliminated: number[];
}

/** 界面层需要的轻量快照。 */
export interface Snapshot {
  time: number;
  phase: Phase;
  /** 0~1.15 车速（满速 = 1）。 */
  busSpeed: number;
  stationLabel: string;
  /** 上车阶段剩余秒数。 */
  boardTimer: number;
  /** 离本回合预定结束（到终点）还有多少秒。 */
  roundTimeLeft: number;
  /** 车上还剩几个角色（不含路人）。 */
  aliveCount: number;
  playerAlive: boolean;
  /** 玩家手里抓着什么。 */
  playerHold: 'none' | 'rail' | 'char';
  /** 玩家抓着的人是否已经摔倒（决定按钮显示"推"还是"扔"）。 */
  playerHoldingDown: boolean;
  playerSeated: boolean;
  playerBalance: number;
  /** "抓"键这一下会做什么，按钮文案跟着变。 */
  interactHint: 'grab' | 'sit' | 'stand' | 'release' | 'none';
  seats: SeatInfo[];
  seatGuide: SeatGuide | null;
  /** 行驶 / 终局中是否有车门开着。 */
  doorsOpen: boolean;
}
