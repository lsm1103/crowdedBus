import type { Vec2 } from '../core/math';
import type { EventKind } from '../config/events';

export type Phase = 'boarding' | 'ignition' | 'driving' | 'finale' | 'ended';

export type CharacterStatus =
  | 'idle'
  | 'walking'
  | 'dashing'
  | 'pushing'
  | 'grabbing'
  | 'stunned'
  | 'sitting'
  | 'returning'
  | 'eliminated';

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
  alive: boolean;
  /** 冷却与状态（秒）。 */
  dashCd: number;
  pushCd: number;
  skillCd: number;
  skillRemaining: number;
  hitProtect: number;
  /** 硬直剩余时间：>0 时操作被大幅削弱。 */
  stunTimer: number;
  /** 当前抓取的扶手 id，null 表示未抓。 */
  grabHandrail: number | null;
  /** 当前占着的座位 id，null 表示站着。 */
  seatId: number | null;
  /** 坐姿稳定度 0~1：被推会掉，掉到 0 就被拽起来。 */
  sitStability: number;
  /** 刚被拽起来的锁定时间，防止贴脸反复横跳。 */
  sitLockTimer: number;
  returnProtectionUsed: boolean;
  respawnTimer: number;
  emoteTimer: number;
  /** 淘汰顺序（1 = 第一个淘汰）。 */
  eliminatedOrder: number;

  // ---- 计分 ----
  /** 本局总分。名次由它决定，而不是"活着且离门远"。 */
  score: number;
  /** 分数来源拆解，结算要能告诉玩家分是怎么来的，否则改了也没人懂。 */
  scoreParts: { seat: number; zone: number; knockout: number; survive: number; push: number };
  /** 击落数。 */
  knockouts: number;
  /** 有效推中别人的次数（行驶/终局，推空不算）。兰姐的解锁条件按它累计。 */
  pushHits: number;
  /** 实际坐在座位上的秒数。不能用座位分反推 —— 那个带拥挤度和专座倍率。 */
  seatSeconds: number;
  /** 最后一次把我推中的人；用于击落归属。 */
  lastHitBy: number | null;
  lastHitAt: number;
}

/** 加分来源。push = 有效推挤（推中、逼门、拽起座位）。 */
export type ScoreReason = 'seat' | 'zone' | 'knockout' | 'survive' | 'push';

/**
 * 座位的实时归属，给视图画"哪几个空着"。
 *
 * 机制存在 ≠ 玩家知道。座位一直是可抢的，但空座和满座在画面上长得一模一样，
 * 玩家没有任何理由走过去 —— 而 bot 直接读 seatFree()，所以看起来只有 AI 会坐。
 */
export interface SeatInfo {
  id: number;
  x: number;
  z: number;
  free: boolean;
  /** 是不是玩家自己坐着的那个。 */
  mine: boolean;
}

/** 最近的空座导航信息。 */
export interface SeatGuide {
  id: number;
  x: number;
  z: number;
  dist: number;
  /** 已经在判定半径内且没被锁 —— 此时按交互键就是坐下。 */
  inReach: boolean;
  /**
   * 刚被拽起来的锁定剩余秒数。
   * 锁定期间走到座位上按键也坐不下，导航必须如实说"还要等几秒"，
   * 否则会出现"提示按【坐下】、按钮却写着抓住"的自相矛盾。
   */
  lockLeft: number;
}

export interface ActiveEvent {
  kind: EventKind;
  label: string;
  warnRemaining: number;
  remaining: number;
  expandDoor: 'front' | 'back' | null;
  /** 急转弯的甩向：+1 朝 +x 车门一侧，-1 朝 -x 座位一侧；其它事件为 0。 */
  side: number;
}

/**
 * 横幅优先级：屏幕上只有一个横幅位，同帧/相邻帧的多条必须排队。
 * 3 = 与玩家直接相关或改变规则（击落、自己出局、进终局）；
 * 2 = 普通局势（到站、关门、别人出局）；
 * 1 = 氛围提示（摇摆、卡点上车），可以被挤掉。
 */
export type BannerPrio = 1 | 2 | 3;

/** 一帧内产生的瞬态表现事件（供视图/音效消费）。 */
export type GameEvent =
  | { type: 'banner'; text: string; prio: BannerPrio; charId?: number }
  | { type: 'grab'; charId: number; railId: number }
  | { type: 'release'; charId: number }
  | { type: 'grabFail'; charId: number }
  /**
   * 技能没放出来。reason 决定提示文案：cooldown = 还在冷却；
   * blocked = 身前放不下（阿远的行李箱被墙/座垫/立杆/坐着的人挡住），不进冷却，换个方向再按就行。
   */
  | { type: 'skillFail'; charId: number; reason: 'cooldown' | 'blocked' }
  | { type: 'hit'; charId: number }
  | { type: 'eliminate'; charId: number }
  | { type: 'respawn'; charId: number }
  | { type: 'dash'; charId: number }
  | { type: 'push'; charId: number }
  | { type: 'skill'; charId: number }
  | { type: 'score'; charId: number; amount: number; reason: ScoreReason }
  | { type: 'knockout'; byId: number; victimId: number; streak: number }
  | { type: 'seatTaken'; charId: number; seatId: number }
  | { type: 'unseat'; charId: number; byId: number | null }
  | { type: 'eventStart'; kind: EventKind };

/** UI 需要的轻量快照。 */
export interface Snapshot {
  time: number;
  phase: Phase;
  crowd: number;
  aliveCount: number;
  boardTimer: number;
  stationLabel: string;
  /** 0~1 车速：驱动窗外街景的滚动，玩家能"看见"车在动、到站会停。 */
  busSpeed: number;
  /** 玩家当前抓着的扶手 id（null 表示没抓）。 */
  playerRail: number | null;
  /** 玩家技能剩余生效时间（秒），0 表示未在生效中。 */
  playerSkillActive: number;
  /** 玩家当前分数与实时名次。 */
  playerScore: number;
  playerRank: number;
  /** 玩家占着的座位与坐姿稳定度，HUD 要显示。 */
  playerSeat: number | null;
  playerSitStability: number;
  /** 交互键这一下会做什么，按钮文案跟着变。 */
  interactHint: 'sit' | 'stand' | 'grab' | 'release' | 'none';
  /** 四个座位的实时归属，视图据此高亮空座。 */
  seats: SeatInfo[];
  /** 最近的空座；玩家已坐下或全满时为 null。 */
  seatGuide: SeatGuide | null;
  /** 热区位置与半径，HUD 和视图都要画。 */
  hotZone: { x: number; z: number; r: number };
  /** 玩家是否正站在热区里。 */
  playerInZone: boolean;
  /** 玩家是否在场（返场途中/已出局为 false），HUD 与教学据此收起找座等提示。 */
  playerAlive: boolean;
  /** 行驶/终局中是否有车门开着 —— 教学"门开了会淘汰"按这个电平触发。 */
  doorsOpen: boolean;
}
