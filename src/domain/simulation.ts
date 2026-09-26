import {
  V2, v2Add, v2Sub, v2Scale, v2Norm, v2Dist, v2Len, clamp, lerp, angleLerp, type Vec2
} from '../core/math';
import { BALANCE, SCORE, SEAT, INPUT_BUFFER } from '../config/balance';
import { characterById } from '../config/characters';
import { EVENTS, type EventKind } from '../config/events';
import {
  LAYOUT, baseWalls, boardingFence, PLATFORM_FENCE, POLE_RADIUS, distToRect, seatFrontPoint,
  type BusLayout, type Rect, type Handrail, type Seat
} from './layout';
import { NavGrid } from './nav';
import type {
  CharacterState, Phase, ActiveEvent, GameEvent, Snapshot, ScoreReason, SeatGuide, BannerPrio
} from './types';
import type { InputFrame, Button } from '../core/input';
import { decideBot, resetAiMemory, type BotContext } from './ai';
import { HotZone } from './hotzone';

export interface RosterEntry {
  defId: string;
  name: string;
  color: string;
  isPlayer: boolean;
}

interface SkillFx {
  kind: string;
  remaining: number;
  data: Record<string, number>;
}

interface Luggage {
  pos: Vec2;
  vel: Vec2;
  rect: Rect;
  remaining: number;
  /**
   * true = 软障碍（兰姐菜篮）：不挡路，踩进去减速 30%。
   * 以前它和行李箱一样参与硬碰撞，人被推在框外，"减速"判定永远不成立。
   */
  slow: boolean;
  /** 滑行阻尼（1/秒）。 */
  drag: number;
  /** 谁放的（阿远/兰姐）；随机事件刷出来的为 null。行李箱撞人时记击落归属用。 */
  owner: number | null;
}

/**
 * 行李把人顶开的速度上限（格/帧）。行李刷在人身上、或滑动的箱子追上人时，
 * 人按这个速度被平滑挤开，而不是被碰撞框一帧弹出半个身位（沿用"单帧位移 ≤0.12"）。
 */
const BAG_PUSH_STEP = 0.1;

/** 行李的碰撞框半宽（x）/半深（z）。所有行李统一，由位置现算，免得出现框和位置脱节。 */
const LUG_HX = 0.6;
const LUG_HZ = 0.4;
const lugRect = (p: Vec2): Rect => ({
  minX: p.x - LUG_HX, maxX: p.x + LUG_HX, minZ: p.z - LUG_HZ, maxZ: p.z + LUG_HZ
});

/** 掉出车厢的判定留一点余量，免得刚踩到门口那一瞬间就被判死。 */
const FALL_GRACE = 0.3;

/**
 * 两人重叠时每轮迭代最多各挪这么多（3 轮迭代合计每帧约 0.11，留一点给静态求解）。
 * 不设上限时，一次性叠进去的人（返场落点、卡点上车、起身落脚）会在一帧里被弹开半个身位，
 * 画面上就是瞬移；设了上限，重叠几帧内平滑散开。
 * 正常走位每帧 0.053、被推飞每帧约 0.14，两人各退 0.12 足够分开，不影响手感。
 */
const MAX_SEP_STEP = 0.038;

/**
 * 坐下/起身的平滑过渡。
 * 座垫对站着的人是实心的，人最多贴到座垫前沿（离座位点约 0.86）；
 * 以前坐下是直接钉到座位点，画面上跳一下。现在在落座/起身硬直期间沿直线插值过去。
 */
interface SeatMove {
  from: Vec2;
  to: Vec2;
  t: number;
  dur: number;
  seatId: number;
  kind: 'in' | 'out';
  /** 起身插值走完后，落脚点还和别人叠着时原地多等的时间（期间仍是"推不动的"一方）。 */
  hold: number;
}

/** 起身落脚后最多等别人让开这么久，超时就恢复普通碰撞。 */
const SEAT_EXIT_HOLD_MAX = 0.5;
/**
 * 刚起身落地的人在这段时间里被人推开的位移每帧合计不超过 SETTLE_STEP。
 * 落脚点两侧都有人顶着时，两对重叠叠加会在一帧里把他弹开 0.12~0.16；
 * 只对这一小段时间限幅，不影响平时的推挤手感。
 */
const SETTLE_TIME = 0.3;
const SETTLE_STEP = 0.06;

const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** 不动、不按键的输入帧（终点停稳后用）。只读，别往里加按键。 */
const IDLE_FRAME: InputFrame = { move: { x: 0, z: 0 }, buttons: new Set<Button>() };

/**
 * 卡点上车的落点：后门内侧 3×3 排开。
 * 以前按 x = 1.35/0.65/-0.05 排，第三个正好落在 0 号立杆（0,-4.2）上。
 * 这组点到所有立杆 ≥ 0.66、到座垫/行李 ≥ 0.5，落下就是合法站位。
 */
const STRAGGLER_SLOTS: Vec2[] = [
  { x: 1.35, z: -4.3 }, { x: 0.65, z: -4.3 }, { x: -0.65, z: -4.3 },
  { x: 1.35, z: -3.5 }, { x: 0.65, z: -3.5 }, { x: -0.65, z: -3.5 },
  { x: 1.35, z: -2.7 }, { x: 0.65, z: -2.7 }, { x: -0.65, z: -2.7 }
];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 圆 vs 立杆（小圆）。杆心重合时往 +x 推，避免除零。 */
const resolveCirclePole = (p: Vec2, r: number, h: Handrail): Vec2 => {
  const dx = p.x - h.x;
  const dz = p.z - h.z;
  const min = r + POLE_RADIUS;
  const d2 = dx * dx + dz * dz;
  if (d2 >= min * min) return p;
  if (d2 < 1e-12) return { x: h.x + min, z: p.z };
  const d = Math.sqrt(d2);
  return { x: h.x + (dx / d) * min, z: h.z + (dz / d) * min };
};

const resolveCircleRect = (p: Vec2, r: number, rect: Rect): Vec2 => {
  const cx = clamp(p.x, rect.minX, rect.maxX);
  const cz = clamp(p.z, rect.minZ, rect.maxZ);
  const dx = p.x - cx;
  const dz = p.z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return p;
  if (d2 < 1e-9) {
    const left = p.x - rect.minX;
    const right = rect.maxX - p.x;
    const top = p.z - rect.minZ;
    const bottom = rect.maxZ - p.z;
    const m = Math.min(left, right, top, bottom);
    if (m === left) return { x: rect.minX - r, z: p.z };
    if (m === right) return { x: rect.maxX + r, z: p.z };
    if (m === top) return { x: p.x, z: rect.minZ - r };
    return { x: p.x, z: rect.maxZ + r };
  }
  const d = Math.sqrt(d2);
  return { x: cx + (dx / d) * r, z: cz + (dz / d) * r };
};

export class Simulation {
  characters: CharacterState[] = [];
  phase: Phase = 'boarding';
  time = 0;
  crowd: number = BALANCE.crowdStart;
  event: ActiveEvent | null = null;
  boardTimer = BALANCE.boardDuration;
  layout: BusLayout = LAYOUT;

  private stationTimer: number = BALANCE.firstStationDelay;
  /** 已经过了几站，用来算拥挤度目标。 */
  private stationCount = 0;
  private ignitionTimer = 0;
  /** 0~1 车速，驱动窗外街景；到站会掉到 0，发车会重新拉起来。 */
  busSpeed = 0;
  /** 本帧车速变化率 d(busSpeed)/dt，惯性由它产生。 */
  private busAccel = 0;
  /** 当前（或下一次）进站的刹车速率；急刹站点更大。 */
  private brakeRateNow: number = BALANCE.stationBrakeRate;
  /** 急刹站点：先按原速开这么久（预警）再刹。 */
  private brakeDelay = 0;
  /** 本局还剩几次急转弯、什么时刻起可以触发；当前这次转弯的持续时长。 */
  private turnsLeft = 0;
  private turnDur = 1;
  private turnArmAt = Infinity;
  /** 一次性冲击改成的短脉冲（总冲量不变）。 */
  private pulses: { accel: Vec2; remaining: number }[] = [];
  /** 本帧施加给乘客的环境加速度（汇总后），供画面层做点头/侧倾。 */
  private envLong = 0;
  private envLat = 0;
  /** 终点停靠：none → braking（平滑减速）→ stopped（停稳保持）。 */
  private arrivePhase: 'none' | 'braking' | 'stopped' = 'none';
  private arriveT = 0;
  private arriveV0 = 0;
  private stationDoorId: 'front' | 'back' | null = null;
  /** 本次到站车门还要开多久；与事件时长解耦，风险窗口由它单独控制。 */
  private doorTimer = 0;
  private lastEventKind: EventKind | null = null;
  private swayTimer = 0;
  private swaySide = 1;
  private jostleTimer = 3;
  private endDelay = 0;
  /** 终点奖励只发一次。 */
  private scoresFinalized = false;
  private eventsOut: GameEvent[] = [];
  private rnd: () => number;
  private skillFx = new Map<number, SkillFx>();
  private luggage: Luggage[] = [];
  private railOwner = new Map<number, number>();
  /**
   * 座位占用。
   * 绝不能存进 LAYOUT —— 那是模块级单例，跨局不会重置，probe 连跑多局会串数据。
   */
  private seatOwner = new Map<number, number>();
  /** 玩家按键缓冲：按键 → 失效时间。只给玩家用，bot 每帧自己决策不需要。 */
  private inputBuffer = new Map<number, Map<Button, number>>();
  /** 进行中的坐下/起身过渡：角色 id → 过渡。 */
  private seatMoves = new Map<number, SeatMove>();
  /** 刚起身落地、处于"缓冲落地"期的人：角色 id → 截止时间。 */
  private settleUntil = new Map<number, number>();
  /** 车厢静态寻路网格（只依赖 LAYOUT 的固定几何，建一次）。 */
  readonly nav = new NavGrid(LAYOUT, BALANCE.characterRadius);
  /** 流动热区：给没抢到座的人一个持续目标。 */
  hotZone = new HotZone(LAYOUT);
  private botCtx: BotContext;

  constructor(seed = Math.floor(Math.random() * 0xffffffff)) {
    this.rnd = mulberry32(seed);
    this.botCtx = {
      characters: this.characters,
      phase: this.phase,
      event: this.event,
      layout: this.layout,
      time: this.time,
      crowd: this.crowd,
      seatFree: (id: number) => this.seatFree(id),
      railFree: (id: number) => !this.railOwner.has(id),
      canUseSkill: (id: number) => this.canUseSkill(id),
      hotZone: this.hotZone,
      nav: this.nav
    };
  }

  /**
   * 开一局。
   * seed 显式传入时整局完全可复现 —— 策略对照实验靠它保证可比，
   * 后续"同一趟车挑战好友"也靠它。不传就每局随机。
   */
  setup(roster: RosterEntry[], seed?: number) {
    this.rnd = mulberry32(seed ?? Math.floor(Math.random() * 0xffffffff));
    this.characters = [];
    this.botCtx.characters = this.characters;
    this.skillFx.clear();
    this.luggage = [];
    this.railOwner.clear();
    this.seatOwner.clear();
    this.hotZone.reset();
    resetAiMemory(this.rnd);
    this.time = 0;
    this.phase = 'boarding';
    this.boardTimer = BALANCE.boardDuration;
    this.crowd = BALANCE.crowdStart;
    this.event = null;
    this.stationTimer = BALANCE.firstStationDelay;
    this.stationCount = 0;
    this.ignitionTimer = 0;
    this.busSpeed = 0;
    this.busAccel = 0;
    this.brakeRateNow = BALANCE.stationBrakeRate;
    this.brakeDelay = 0;
    this.turnsLeft = 0;
    this.turnArmAt = Infinity;
    this.pulses = [];
    this.envLong = 0;
    this.envLat = 0;
    this.arrivePhase = 'none';
    this.arriveT = 0;
    this.arriveV0 = 0;
    this.stationDoorId = null;
    this.doorTimer = 0;
    this.lastEventKind = null;
    this.swayTimer = 0;
    this.swaySide = 1;
    this.jostleTimer = 3;
    this.endDelay = 0;
    this.scoresFinalized = false;
    this.eventsOut = [];
    this.inputBuffer.clear();
    this.seatMoves.clear();
    this.settleUntil.clear();
    this.nav.reset();
    this.nav.beginStep();
    this.layout.doors[0].open = false; // 前门
    this.layout.doors[1].open = true; // 后门（上车）

    roster.forEach((entry, i) => {
      const spawn = this.layout.spawn[i % this.layout.spawn.length];
      const def = characterById(entry.defId);
      this.characters.push({
        id: i,
        isPlayer: entry.isPlayer,
        defId: entry.defId,
        name: entry.name,
        color: entry.color,
        pos: { ...spawn },
        vel: V2(),
        facing: Math.PI,
        radius: BALANCE.characterRadius,
        status: 'idle',
        alive: true,
        dashCd: 0,
        pushCd: 0,
        skillCd: def.skillCooldown * 0.4,
        skillRemaining: 0,
        hitProtect: 0,
        stunTimer: 0,
        grabHandrail: null,
        seatId: null,
        sitStability: 1,
        sitLockTimer: 0,
        returnProtectionUsed: false,
        respawnTimer: 0,
        emoteTimer: 0,
        eliminatedOrder: 0,
        score: 0,
        scoreParts: { seat: 0, zone: 0, knockout: 0, survive: 0, push: 0 },
        knockouts: 0,
        pushHits: 0,
        seatSeconds: 0,
        lastHitBy: null,
        lastHitAt: -999
      });
    });
  }

  /** 统一的加分入口：写总分、写分项、发事件。 */
  private addScore(c: CharacterState, amount: number, reason: ScoreReason) {
    if (amount === 0) return;
    c.score += amount;
    c.scoreParts[reason] += amount;
    this.eventsOut.push({ type: 'score', charId: c.id, amount, reason });
  }

  private banner(text: string, prio: BannerPrio, charId?: number) {
    this.eventsOut.push(charId === undefined
      ? { type: 'banner', text, prio }
      : { type: 'banner', text, prio, charId });
  }

  /**
   * 终点结算：给还在车上的人发存活奖励。
   * 注意它只是一笔奖励，不再直接决定名次 —— 这正是"打得凶但最后被推下去"
   * 能赢过"全程苟活 0 分"的关键。
   */
  private finalizeScores() {
    if (this.scoresFinalized) return;
    this.scoresFinalized = true;
    for (const c of this.characters) {
      if (c.alive) this.addScore(c, SCORE.surviveBonus, 'survive');
    }
  }

  /** 0~1，拥挤度归一化，用来驱动减速/晃动/推力加成。 */
  private get crowdT(): number {
    return clamp(this.crowd / BALANCE.crowdMax, 0, 1);
  }

  /** 玩家输入（默认 0 号角色）。 */
  applyPlayerInput(frame: InputFrame, playerId = 0) {
    const c = this.characters[playerId];
    // 终点停稳后大家都下车了：输入不再生效（只让残余速度走完）。
    if (c && c.alive) this.stepCharacter(c, this.arrived ? IDLE_FRAME : frame);
  }

  tick(dt: number): GameEvent[] {
    // 这里绝对不能清空 eventsOut。
    // applyPlayerInput() 在 tick() 之前调用，玩家自己按出来的抓住/推挤/冲刺/技能
    // 事件都先落在 eventsOut 里；在这里清一次，等于把玩家所有操作的反馈全丢掉，
    // 只剩机器人的还在 —— 玩家放技能、抓扶手时什么动静都没有就是这么来的。
    // 队列由本函数末尾统一取走并清空。
    this.time += dt;
    this.botCtx.phase = this.phase;
    this.botCtx.event = this.event;
    this.botCtx.time = this.time;
    this.botCtx.crowd = this.crowd;

    this.updatePhase(dt);
    this.updateTurns();
    this.updateEvent(dt);
    this.updateDoors(dt);
    this.updateBusSpeed(dt);
    this.applyEnvironment(dt);

    for (const c of this.characters) {
      if (!c.alive) {
        this.updateRespawn(c, dt);
        continue;
      }
      if (!c.isPlayer) {
        const frame = this.arrived ? IDLE_FRAME : decideBot(c, this.botCtx, this.rnd, dt);
        this.stepCharacter(c, frame);
      }
      this.updateCooldowns(c, dt);
    }

    this.advanceSeatMoves(dt);
    this.resolveAllCollisions();
    this.checkEliminations();
    this.updateLuggage(dt);

    if (this.phase === 'driving' || this.phase === 'finale') {
      this.updateCrowd(dt);
      this.updateJostle(dt);
    }
    this.updateSeats(dt);
    this.updateHotZone(dt);

    if (this.phase !== 'ended' && this.phase !== 'boarding' && this.aliveCount() === 0) {
      this.phase = 'ended';
      this.finalizeScores();
      this.banner('本车全灭！', 3);
    }

    // 玩家出局后不再干等：让淘汰演出播完就直接结算。
    if (this.endDelay > 0) {
      this.endDelay -= dt;
      if (this.endDelay <= 0) {
        this.phase = 'ended';
        this.finalizeScores();
      }
    }

    // 下一步（玩家输入 + bot 决策）的寻路重算预算。
    this.nav.beginStep();

    const out = this.eventsOut;
    this.eventsOut = [];
    return out;
  }

  private updatePhase(dt: number) {
    if (this.phase === 'boarding') {
      this.boardTimer -= dt;
      if (this.boardTimer <= 0) {
        // 先进"启动车辆"过场，而不是直接开跑：关门、点火、窗外街景开始流动。
        this.phase = 'ignition';
        this.ignitionTimer = BALANCE.ignitionDuration;
        this.layout.doors.forEach((d) => (d.open = false));
        this.doorTimer = 0;
        this.stationDoorId = null;
        this.pullStragglersAboard();
        this.banner('车门关闭 · 发动机启动', 2);
      }
      return;
    }
    if (this.phase === 'ignition') {
      this.ignitionTimer -= dt;
      if (this.ignitionTimer <= 0) {
        this.phase = 'driving';
        this.banner('出发！', 2);
        // 急转弯排期：每局 1~2 次，第一次在发车后不久（第一站之前那段满速路）。
        const [lo, hi] = BALANCE.turnsPerMatch;
        this.turnsLeft = lo + Math.floor(this.rnd() * (hi - lo + 1));
        this.turnArmAt = this.time + 0.4 + this.rnd() * 1.4;
      }
      return;
    }
    if (this.phase === 'driving') {
      this.stationTimer -= dt;
      // 离终局不到一次停站时长就不再进站：以前 45 秒多到站，不到一秒终局开始，
      // 车没停稳又加速开走，"到站"横幅立刻被"好挤模式"盖掉。
      const finaleAt = BALANCE.matchDuration - BALANCE.finaleLead;
      if (this.stationTimer <= 0 && finaleAt - this.time > BALANCE.stationStopDuration) {
        this.triggerStation();
        this.stationTimer = lerp(BALANCE.stationInterval[0], BALANCE.stationInterval[1], this.rnd());
      }
      if (this.time >= BALANCE.matchDuration - BALANCE.finaleLead) {
        this.phase = 'finale';
        this.layout.doors.forEach((d) => (d.open = true));
        this.doorTimer = 0;
        // 第一次摆动推迟一个周期：以前 swayTimer 从 0 起，下一帧就摆，
        // "终点前"横幅只活了 16ms 就被"车身左摆"盖掉，玩家根本不知道规则变了。
        this.swayTimer = BALANCE.swayInterval;
        this.banner('终点前：好挤模式！两门全开', 3);
      }
      return;
    }
    if (this.phase === 'finale') {
      this.layout.doors.forEach((d) => (d.open = true));
      this.updateArrival(dt);
      // 进站减速后不再换边（摇摆和侧倾随车速一起减弱，见 finaleFade）。
      if (this.arrivePhase === 'none') {
        this.swayTimer -= dt;
        if (this.swayTimer <= 0) {
          this.swayTimer = BALANCE.swayInterval;
          this.swaySide *= -1;
          // 不写"左/右"：越肩镜头跟着朝向转，屏幕左右和世界 ±x 没有固定对应，
          // 玩家唯一需要知道的是"这一下是不是往车门甩"。
          this.banner(this.swaySide > 0 ? '车身甩向车门！抓稳' : '车身甩回座位一侧', 1);
          this.pulse(V2(this.swaySide * BALANCE.swayImpulse, 0), BALANCE.swayPulse);
        }
      }
      if (this.time >= BALANCE.matchDuration) {
        this.phase = 'ended';
        this.finalizeScores();
      }
    }
  }

  /**
   * 终点停靠：最后 terminalBrake + terminalHold 秒，先平滑减速到 0（"终点站到了"），
   * 停稳那一刻结算"撑到终点"（存活奖励），之后冻结淘汰和操作，保持 terminalHold 秒再结束。
   * 结束时刻仍是 matchDuration，倒计时不会出现负数。
   */
  private updateArrival(dt: number) {
    const brakeAt = BALANCE.matchDuration - BALANCE.terminalHold - BALANCE.terminalBrake;
    if (this.arrivePhase === 'none') {
      if (this.time < brakeAt) return;
      this.arrivePhase = 'braking';
      this.arriveT = 0;
      this.arriveV0 = this.busSpeed;
      this.banner('终点站到了 · 车要停了，抓稳！', 3);
      return;
    }
    if (this.arrivePhase === 'braking') {
      this.arriveT += dt;
      if (this.arriveT >= BALANCE.terminalBrake) {
        this.arrivePhase = 'stopped';
        // "撑到终点"以停稳这一刻为准：此后不再判淘汰，存活名单就定了。
        this.finalizeScores();
      }
    }
  }

  /** 终点停靠已停稳（此后冻结淘汰与操作）。 */
  get arrived(): boolean {
    return this.arrivePhase === 'stopped';
  }

  /** 终局摇摆/侧倾的强度：平时 1，终点减速阶段随车速平滑降到 0。 */
  private get finaleFade(): number {
    if (this.arrivePhase === 'stopped') return 0;
    if (this.arrivePhase === 'braking') return 1 - smoothstep(Math.min(1, this.arriveT / BALANCE.terminalBrake));
    return 1;
  }

  /**
   * 急转弯：只在行驶途中、车速接近满速、没有别的事件、下一站和终局都还远时触发，
   * 保证整个转弯（预警 + 持续）期间车门是关着的。每局 1~2 次。
   */
  private updateTurns() {
    if (this.phase !== 'driving' || this.turnsLeft <= 0 || this.time < this.turnArmAt) return;
    if (this.event || this.doorTimer > 0 || this.busSpeed < BALANCE.turnMinSpeed) return;
    const [dMin, dMax] = BALANCE.turnDuration;
    const dur = lerp(dMin, dMax, this.rnd());
    const total = BALANCE.turnWarn + dur + 0.6;
    const finaleAt = BALANCE.matchDuration - BALANCE.finaleLead;
    if (this.stationTimer < total || finaleAt - this.time < total) return;
    const side = this.rnd() < 0.5 ? 1 : -1;
    this.turnDur = dur;
    this.event = {
      kind: 'turn', label: EVENTS.turn.label, warnRemaining: BALANCE.turnWarn, remaining: dur,
      expandDoor: null, side
    };
    this.turnsLeft--;
    this.turnArmAt = this.time + total + 4;
    this.banner(side > 0 ? '前方急转弯 · 车身要甩向车门！抓稳' : '前方急转弯 · 车身要甩向座位一侧', 2);
    this.eventsOut.push({ type: 'eventStart', kind: 'turn' });
  }

  /**
   * 汇总本帧所有环境加速度，一次性施加给乘客（抓扶手/坐着照常减免），
   * 同时记下 longAccel / latAccel 给画面层。
   * 来源：车速变化的惯性（纵向）、急转弯（横向，正弦包络）、终局侧倾（横向，随终点减速减弱）、
   * 各种短脉冲（终局换边、车厢晃动、上人）。
   */
  private applyEnvironment(dt: number) {
    let ax = 0;
    let az = 0;
    // 1) 惯性：刹车往车头 +z，起步往车尾 -z；站得住的那部分（inertiaFooting）不推人。
    const raw = -BALANCE.inertiaGain * this.busAccel;
    az += Math.sign(raw) * Math.max(0, Math.abs(raw) - BALANCE.inertiaFooting);
    // 2) 急转弯：预警结束后按正弦包络持续施加。
    const e = this.event;
    if (e && e.kind === 'turn' && e.warnRemaining <= 0 && e.remaining > 0) {
      const progress = 1 - e.remaining / Math.max(1e-3, this.turnDur);
      ax += e.side * BALANCE.turnAccel * Math.sin(Math.PI * clamp(progress, 0, 1));
    }
    // 3) 终局持续侧倾（不是一次性冲量）：不抓扶手就会被一路推向敞开的车门。
    if (this.phase === 'finale') ax += this.swaySide * BALANCE.finaleTilt * this.finaleFade;
    // 4) 短脉冲：按剩余时长截断，保证总冲量精确等于原来的一次性冲量。
    let ix = 0;
    let iz = 0;
    for (const p of this.pulses) {
      const step = Math.min(dt, p.remaining);
      ix += p.accel.x * step;
      iz += p.accel.z * step;
      p.remaining -= step;
    }
    this.pulses = this.pulses.filter((p) => p.remaining > 1e-9);
    const impulse = V2(ax * dt + ix, az * dt + iz);
    this.envLat = dt > 0 ? impulse.x / dt : 0;
    this.envLong = dt > 0 ? impulse.z / dt : 0;
    if (impulse.x !== 0 || impulse.z !== 0) this.applyEnvironmentImpulse(impulse);
  }

  /** 把一次性冲击改成 dur 秒的短脉冲（总冲量不变）。 */
  private pulse(impulse: Vec2, dur: number) {
    this.pulses.push({ accel: v2Scale(impulse, 1 / dur), remaining: dur });
  }

  /** 本帧施加给乘客的纵向环境加速度（格/秒²，+ 朝车头 +z）。含惯性与各种脉冲。 */
  get longAccel(): number {
    return this.envLong;
  }

  /** 本帧施加给乘客的横向环境加速度（格/秒²，+ 朝 +x 车门一侧）。含急转弯、终局侧倾与脉冲。 */
  get latAccel(): number {
    return this.envLat;
  }

  /**
   * 当前进站的刹车速率（车速按 e^(-rate·t) 衰减）。
   * 画面层按"满速开始减速的那一刻"推算停车点：剩余距离 = 车速 × 滚动速度 / brakeRate；
   * 急刹站点这个值更大，必须读它，不能写死 2.2。
   */
  get brakeRate(): number {
    return this.brakeRateNow;
  }

  /**
   * 从现在到停稳还要走的路程（单位：车速·秒，乘上街景滚动速度就是世界格）。没在进站就是 0。
   * 画面层靠它把候车亭摆在"刹停时正好在车旁"的位置：
   * - 到站：车速按 e^(-rate·t) 衰减，剩余路程 = v / rate；急刹站点的预警期照原速开，再加 v × 剩余预警；
   * - 终点：车速 = v0 × (1 − smoothstep(u))，u = t / T，剩余路程 = v0·T·(½ − (u − u³ + u⁴/2))。
   */
  get stoppingDistance(): number {
    if (this.phase === 'finale' && this.arrivePhase === 'braking') {
      const T = BALANCE.terminalBrake;
      const u = Math.min(1, this.arriveT / T);
      return Math.max(0, this.arriveV0 * T * (0.5 - (u - u * u * u + (u * u * u * u) / 2)));
    }
    if (this.phase === 'driving' && this.doorTimer > 0 && this.busSpeed > 0.01) {
      return this.busSpeed / Math.max(0.1, this.brakeRateNow) + this.busSpeed * Math.max(0, this.brakeDelay);
    }
    return 0;
  }

  /**
   * 终局车身侧倾的方向（-1 / +1），供镜头做同向倾斜。
   * 终点减速阶段随车速平滑减弱，停稳时为 0（所以值域是 [-1, 1] 的连续值）。
   */
  get tilt(): number {
    return this.phase === 'finale' ? this.swaySide * this.finaleFade : 0;
  }

  /**
   * 关门瞬间把还留在站台上的人塞进车厢。
   * 不做这件事的话，没及时上车的人会在发车那一帧直接被判"掉出车厢"，
   * 玩家什么提示都没有就出局了。
   */
  private pullStragglersAboard() {
    const r = this.layout.interior;
    let slot = 0;
    const names: string[] = [];
    let playerLate = false;
    for (const c of this.characters) {
      if (!c.alive) continue;
      if (c.pos.x >= r.minX && c.pos.x <= r.maxX && c.pos.z >= r.minZ && c.pos.z <= r.maxZ) continue;
      c.pos = { ...STRAGGLER_SLOTS[slot % STRAGGLER_SLOTS.length] };
      c.vel = V2();
      slot++;
      names.push(c.name);
      if (c.isPlayer) playerLate = true;
    }
    // 合并成一条：以前每人一条，同帧连发 N 条互相覆盖，最后只剩一个名字。
    if (names.length === 0) return;
    if (playerLate) this.banner('你卡点挤上了车！', 2);
    else this.banner(names.length === 1 ? names[0] + ' 卡点挤上车！' : `${names.length} 人卡点挤上车！`, 1);
  }

  /**
   * 热区计分。分数按区内人数平分：两个人同占不如一个人独占，
   * 这一条本身就在驱动互推，不需要额外机制去"鼓励对抗"。
   */
  private updateHotZone(dt: number) {
    if (this.phase !== 'driving' && this.phase !== 'finale') return;
    if (this.arrived) return;
    const openDoor = this.layout.doors.find((d) => d.open) ?? null;
    this.hotZone.update(dt, this.rnd, openDoor, this.phase === 'finale');
    const inside = this.characters.filter(
      (c) => c.alive && c.seatId === null && this.hotZone.contains(c.pos)
    );
    if (inside.length === 0) return;
    const each = (SCORE.zonePerSecond / inside.length) * dt;
    for (const c of inside) this.addScore(c, each, 'zone');
  }

  seatById(id: number): Seat | undefined {
    return this.layout.seats.find((s) => s.id === id);
  }

  /** 座位是否空着（可抢）。 */
  private seatFree(id: number): boolean {
    return !this.seatOwner.has(id);
  }

  /**
   * 每帧的座位维护：钉位、计分、稳定度回复、终局强制清座。
   *
   * 终局清座是必须的：不清的话"抢到座就坐到底"会变成新的消极解，
   * 把刚堵上的漏洞原样换个地方开回来。
   */
  private updateSeats(dt: number) {
    if (this.phase === 'finale') {
      // 终局强制清座。不清的话"抢到座就坐到底"会变成新的消极解。
      // 也不给"活着就加分"——那等于直接奖励躲起来，正好是要打压的行为；
      // 终局的收益来自这段时间里暴涨的击落机会（两门全开 + 持续侧倾）。
      for (const c of this.characters) {
        if (c.seatId !== null) this.unseat(c, null, false);
      }
      return;
    }
    const scoring = this.phase === 'driving';
    const mul = 1 + 0.5 * this.crowdT;
    for (const c of this.characters) {
      c.sitLockTimer = Math.max(0, c.sitLockTimer - dt);
      if (c.seatId === null) continue;
      const seat = this.seatById(c.seatId);
      if (!seat) {
        c.seatId = null;
        continue;
      }
      // 钉在座位上：坐着的人不该被站着的人挤走。落座过渡期间位置由 advanceSeatMoves 插值。
      if (this.seatMoves.get(c.id)?.kind !== 'in') {
        c.pos = V2(seat.x, seat.z);
        c.facing = seat.facing;
      }
      c.vel = V2();
      c.status = 'sitting';
      // 被推中后一段时间不回复，"三下拽起来"才成立（见 SEAT.regenPauseAfterHit）。
      if (this.time - c.lastHitAt >= SEAT.regenPauseAfterHit) {
        c.sitStability = Math.min(1, c.sitStability + SEAT.regen * dt);
      }
      c.seatSeconds += dt;
      if (scoring) {
        const rate = SCORE.seatPerSecond * mul * (seat.kind === 'priority' ? SCORE.prioritySeatMul : 1);
        this.addScore(c, rate * dt, 'seat');
      }
    }
  }

  /** 坐下。 */
  private sitDown(c: CharacterState, seat: Seat) {
    this.releaseGrab(c);
    c.seatId = seat.id;
    c.sitStability = 1;
    c.status = 'sitting';
    c.stunTimer = Math.max(c.stunTimer, SEAT.sitDelay);
    c.vel = V2();
    // 不再瞬间钉过去：在落座硬直期间从当前位置平滑移到座位点。
    this.seatMoves.set(c.id, {
      from: { ...c.pos }, to: V2(seat.x, seat.z), t: 0, dur: SEAT.sitDelay, seatId: seat.id, kind: 'in', hold: 0
    });
    this.seatOwner.set(seat.id, c.id);
    this.eventsOut.push({ type: 'seatTaken', charId: c.id, seatId: seat.id });
  }

  /** 起身。byId 非空表示是被人拽起来的。 */
  private unseat(c: CharacterState, byId: number | null, forced: boolean) {
    if (c.seatId === null) return;
    // 被推到快坐不稳、自己先起身的（bot 稳定度 < 0.36 就会让座）也算推的人拽起来的。
    if (byId === null && !forced && this.phase === 'driving' && c.sitStability < 0.5
      && c.lastHitBy !== null && this.time - c.lastHitAt < SCORE.attributionWindow) {
      const by = this.characters[c.lastHitBy];
      if (by && by.alive && by.id !== c.id) this.addScore(by, SCORE.seatSteal, 'push');
    }
    const seat = this.seatById(c.seatId);
    this.seatOwner.delete(c.seatId);
    const seatId = c.seatId;
    c.seatId = null;
    c.sitStability = 1;
    c.status = 'idle';
    const delay = forced ? SEAT.forcedStandDelay : SEAT.standDelay;
    c.stunTimer = Math.max(c.stunTimer, delay);
    c.vel = V2();
    // 起身/被拽起：在起身硬直期间平滑移到座垫前沿外。人不在场（出局）时不做。
    if (seat && c.alive) {
      this.seatMoves.set(c.id, {
        from: { ...c.pos }, to: this.pickExitPoint(c, seat), t: 0, dur: delay, seatId, kind: 'out', hold: 0
      });
    } else {
      this.seatMoves.delete(c.id);
    }
    if (forced) c.sitLockTimer = SEAT.lockAfterUnseat;
    this.eventsOut.push({ type: 'unseat', charId: c.id, byId });
  }

  /**
   * 推进坐下/起身过渡。
   * 过渡中的人位置完全由插值决定（速度清零、不吃冲量），所以单帧位移有上界：
   * 最远约 1.3 格 / 0.35 秒，smoothstep 峰值斜率 1.5 → 每帧 ≤ 0.1。
   */
  private advanceSeatMoves(dt: number) {
    for (const [id, mv] of this.seatMoves) {
      const c = this.characters[id];
      if (!c || !c.alive) {
        this.seatMoves.delete(id);
        continue;
      }
      mv.t = Math.min(mv.dur, mv.t + dt);
      const k = smoothstep(mv.dur > 0 ? mv.t / mv.dur : 1);
      c.pos = V2(mv.from.x + (mv.to.x - mv.from.x) * k, mv.from.z + (mv.to.z - mv.from.z) * k);
      c.vel = V2();
      if (mv.kind === 'in') {
        const seat = this.seatById(mv.seatId);
        if (seat) c.facing = angleLerp(c.facing, seat.facing, 0.25);
      }
      if (mv.t < mv.dur) continue;
      // 起身走完了但落脚点还压着别人：原地再当一会儿"推不动的"，让对方先被挤开，
      // 否则一转回普通碰撞，重叠会在一帧里被分摊弹开（实测 0.18）。
      // 落脚点被行李压着就一直等（行李最多存在几秒），被人挡着最多等 SEAT_EXIT_HOLD_MAX。
      if (mv.kind === 'out'
        && (this.underLuggage(c) || (mv.hold < SEAT_EXIT_HOLD_MAX && this.overlapsSomeone(c)))) {
        mv.hold += dt;
        continue;
      }
      this.seatMoves.delete(id);
      if (mv.kind === 'out') this.settleUntil.set(id, this.time + SETTLE_TIME);
    }
  }

  /**
   * 起身落脚点：座垫前沿外的中点，或沿座垫前沿左右各偏 0.5，挑离别人最远的。
   * 同一个座位可能前后两个人几乎同时起身（刚被拽起的 + 刚坐下就赶上终局清座的），
   * 都落到中点就会叠在一起；±0.5 两点正好隔一个身位。偏移点离立杆 ≥ 0.89、
   * 在座垫前沿外（按 LAYOUT 核过），另外再用导航网格兜底检查一次。
   */
  private pickExitPoint(c: CharacterState, seat: Seat): Vec2 {
    const base = seatFrontPoint(seat, c.radius);
    let best = base;
    let bestGap = -Infinity;
    for (const dz of [0, 0.5, -0.5]) {
      const p = V2(base.x, base.z + dz);
      // 导航网格含临时行李：被行李压着的候选点不要（三个都被压着就还用中点，靠等待兜底）。
      if (!this.nav.isFree(p)) continue;
      let gap = Infinity;
      for (const o of this.characters) {
        if (o === c || !o.alive || o.seatId !== null) continue;
        const mv = this.seatMoves.get(o.id);
        gap = Math.min(gap, v2Dist(mv && mv.kind === 'out' ? mv.to : o.pos, p));
      }
      // 中点优先，偏移点只有明显更空才换过去。
      if (dz !== 0) gap -= 0.2;
      if (gap > bestGap) { bestGap = gap; best = p; }
    }
    return best;  // 全都不可用时 best 仍是中点
  }

  private underLuggage(c: CharacterState): boolean {
    return this.luggage.some((l) => !l.slow && distToRect(c.pos, l.rect) < c.radius);
  }

  private overlapsSomeone(c: CharacterState): boolean {
    return this.characters.some(
      (o) => o !== c && o.alive && o.seatId === null && v2Dist(o.pos, c.pos) < o.radius + c.radius - 0.01
    );
  }

  /**
   * 车速：上车静止 → 点火渐进加速 → 行驶满速 → 到站减速停车 → 终局略快 → 终点平滑停下。
   * 同时算出本帧车速变化率 busAccel，惯性由它产生（见 applyEnvironment）。
   */
  private updateBusSpeed(dt: number) {
    const before = this.busSpeed;
    if (this.phase === 'finale' && this.arrivePhase !== 'none') {
      // 终点：从进站时的车速平滑降到 0（不是指数衰减，能在 terminalBrake 秒内真正停住）。
      const k = this.arrivePhase === 'stopped' ? 1 : smoothstep(Math.min(1, this.arriveT / BALANCE.terminalBrake));
      this.busSpeed = this.arriveV0 * (1 - k);
    } else {
      let want = 0;
      let rate: number = BALANCE.busAccelRate;
      if (this.phase === 'ignition') {
        // 前一半原地发动（车身抖、街景不动），后一半像出站一样起步 —— 以前是 t² 缓慢爬升，
        // 加速度始终低于"站得住"阈值，发车那一下车里人毫无反应。
        const elapsed = BALANCE.ignitionDuration - Math.max(0, this.ignitionTimer);
        want = elapsed < BALANCE.ignitionDuration * 0.5 ? 0 : 1;
      } else if (this.phase === 'driving') {
        want = this.doorTimer > 0 ? 0 : 1;
        // 急刹站点：预警期间照原速开，预警一结束猛刹。
        if (want === 0 && this.brakeDelay > 0) {
          this.brakeDelay -= dt;
          want = this.busSpeed;
        }
      } else if (this.phase === 'finale') {
        want = 1.15;
      }
      if (want < this.busSpeed) rate = this.brakeRateNow;
      this.busSpeed += (want - this.busSpeed) * (1 - Math.exp(-rate * dt));
    }
    this.busAccel = dt > 0 ? (this.busSpeed - before) / dt : 0;
  }

  /** 到站：开门 + 拥挤度跳变 + 一个随机事件。开门时长独立于事件时长。 */
  private triggerStation() {
    this.stationCount++;
    const kind = this.pickEventKind();
    const def = EVENTS[kind];
    this.lastEventKind = kind;

    const door = this.layout.doors[this.rnd() < 0.5 ? 0 : 1];
    door.open = true;
    this.stationDoorId = door.id;
    this.doorTimer = BALANCE.stationStopDuration;
    // 急刹：这一站刹得更猛，而且先预警再刹（横幅出现在刹车之前）；
    // 普通站点横幅和刹车同时开始。推人的是刹车本身的惯性，不再补一次性冲量。
    if (kind === 'brake') {
      this.brakeRateNow = BALANCE.emergencyBrakeRate;
      this.brakeDelay = BALANCE.eventWarn;
    } else {
      this.brakeRateNow = BALANCE.stationBrakeRate;
      this.brakeDelay = 0;
    }

    this.event = {
      kind,
      label: def.label,
      warnRemaining: BALANCE.eventWarn,
      remaining: def.duration,
      // 故障的一定是另一扇门：以前独立随机，一半概率"扩大"的就是本来开着的那扇，
      // 横幅喊"危险区扩大"但什么都没变（实测 236 次里 120 次无效）。
      expandDoor: kind === 'doorfault' ? (door.id === 'front' ? 'back' : 'front') : null,
      side: 0
    };
    this.banner('到站 · ' + def.warnText, 2);
    this.eventsOut.push({ type: 'eventStart', kind });
  }

  private updateDoors(dt: number) {
    if (this.phase !== 'driving' || this.doorTimer <= 0) return;
    this.doorTimer -= dt;
    if (this.doorTimer > 0) return;
    if (this.stationDoorId) {
      const d = this.layout.doors.find((x) => x.id === this.stationDoorId);
      if (d) d.open = false;
      this.stationDoorId = null;
    }
    this.banner('车门关闭', 1);
  }

  /**
   * 拥挤度 = 车上人数的函数。
   * 玩家推一个人下车，拥挤度立刻降 5，自己移速回升 —— 这是它唯一能被玩家
   * 影响的路径。但人少了座位分也少（座位分随拥挤度加成），所以"把人全推下去"
   * 不总是最优，形成真取舍。
   */
  private updateCrowd(dt: number) {
    const target = clamp(
      BALANCE.crowdBase + this.aliveCount() * BALANCE.crowdPerPerson
        + this.stationCount * BALANCE.crowdPerStation,
      0, BALANCE.crowdMax
    );
    this.crowd += (target - this.crowd) * (1 - Math.exp(-BALANCE.crowdApproach * dt / 10));
  }

  /** 车厢持续的小幅摇晃：拥挤度越高越频繁、越猛，站在门边永远不安全。 */
  private updateJostle(dt: number) {
    this.jostleTimer -= dt;
    if (this.jostleTimer > 0) return;
    const t = this.crowdT;
    this.jostleTimer = lerp(BALANCE.jostleIntervalLow, BALANCE.jostleIntervalHigh, t);
    const a = this.rnd() * Math.PI * 2;
    const mag = BALANCE.jostleImpulse * (0.5 + t);
    this.pulse(V2(Math.cos(a) * mag, Math.sin(a) * mag), BALANCE.jostlePulse);
  }

  private pickEventKind(): EventKind {
    // 急转弯不在到站池里：到站时车是停着的，"在停着的车里往侧面推"没有意义；
    // 它改由 updateTurns 在行驶途中满速时触发。
    const kinds: EventKind[] = ['brake', 'boarding', 'luggage', 'doorfault'];
    const filtered = kinds.filter((k) => k !== this.lastEventKind);
    return filtered[Math.floor(this.rnd() * filtered.length)];
  }

  private updateEvent(dt: number) {
    if (!this.event) return;
    if (this.event.warnRemaining > 0) {
      this.event.warnRemaining -= dt;
      if (this.event.warnRemaining <= 0) this.applyEventStart(this.event);
      return;
    }
    this.event.remaining -= dt;
    if (this.event.remaining <= 0) {
      this.applyEventEnd(this.event);
      this.event = null;
    }
  }

  private applyEventStart(e: ActiveEvent) {
    switch (e.kind) {
      case 'brake':
      case 'turn':
        // 急刹/急转弯的力都是持续施加的（刹车惯性、转弯横向加速度），见 applyEnvironment。
        break;
      case 'luggage':
        this.spawnLuggage();
        break;
      case 'doorfault':
        if (e.expandDoor) {
          const d = this.layout.doors.find((x) => x.id === e.expandDoor);
          if (d) d.open = true;
        }
        break;
      case 'boarding':
        // 上人：把所有人往车厢内侧挤一把（短脉冲，总冲量同以前的一次性冲量）。
        this.pulse(V2(-BALANCE.jostleImpulse * 1.4, 0), BALANCE.jostlePulse);
        break;
    }
  }

  private applyEventEnd(e: ActiveEvent) {
    if (this.phase !== 'driving') return;
    if (e.kind === 'doorfault' && e.expandDoor && e.expandDoor !== this.stationDoorId) {
      const d = this.layout.doors.find((x) => x.id === e.expandDoor);
      if (d) d.open = false;
    }
  }

  private applyEnvironmentImpulse(impulse: Vec2) {
    for (const c of this.characters) {
      if (!c.alive) continue;
      let reduce = c.seatId !== null
        ? 1 - SEAT.impulseReduction
        : c.grabHandrail !== null ? 1 - BALANCE.handrailDamageReduction : 1;
      const fx = this.skillFx.get(c.id);
      if (fx) {
        if (fx.kind === 'xiaoli') reduce *= 0.3;
        if (fx.kind === 'laozhou') reduce *= 0.4;
      }
      c.vel = v2Add(c.vel, v2Scale(impulse, reduce));
    }
  }

  /**
   * 行李（实心）能不能放在这里：不压座垫/靠背/障碍物/填充体/立杆/别的行李，
   * 不压在人身上（ignore 里的人除外，比如施法者自己）。
   * 以前随机点位会直接刷在立杆、座垫前沿、甚至正在起身的人身上：
   * 人被行李框一帧弹开，最远弹进座垫里 —— 这是"起身瞬移"的真正来源。
   */
  /**
   * @param standingOk 站着的人不算阻挡（放行李箱、滑动中的箱子：碰撞会把站着的人平滑顶开）。
   *   坐着/正在起坐的人永远算阻挡 —— 他们被钉在座位上、推不开。
   */
  private luggageFits(
    pos: Vec2, ignore: CharacterState | null = null, self: Luggage | null = null, standingOk = self !== null
  ): boolean {
    const rect = lugRect(pos);
    const r = this.layout.interior;
    if (rect.minX < r.minX || rect.maxX > r.maxX || rect.minZ < r.minZ || rect.maxZ > r.maxZ) return false;
    const overlap = (a: Rect, b: Rect, m: number) =>
      a.minX < b.maxX + m && a.maxX > b.minX - m && a.minZ < b.maxZ + m && a.maxZ > b.minZ - m;
    for (const st of this.layout.seats) if (overlap(rect, st.cushion, 0.05) || overlap(rect, st.backRect, 0.05)) return false;
    for (const o of this.layout.obstacles) if (overlap(rect, o.rect, 0.05)) return false;
    for (const f of this.layout.fillers) if (overlap(rect, f, 0.05)) return false;
    for (const h of this.layout.handrails) if (distToRect(h, rect) < POLE_RADIUS + 0.05) return false;
    for (const l of this.luggage) if (l !== self && overlap(rect, l.rect, 0.05)) return false;
    for (const c of this.characters) {
      if (!c.alive || c === ignore) continue;
      // 坐着/正在起坐的人：连他起身后的落脚点（座垫前沿外）也要空出来，
      // 不然起身一落地就被行李框弹开。
      const sitting = c.seatId !== null || this.seatMoves.has(c.id);
      // 随机刷行李时还要空出坐着的人起身后的落脚点；放箱子/滑动时不用 ——
      // 行李顶人已限速（BAG_PUSH_STEP），起身落地压到行李也会原地等（underLuggage）。
      if (sitting && !standingOk) {
        const sid = c.seatId ?? this.seatMoves.get(c.id)!.seatId;
        const seat = this.seatById(sid);
        if (seat && distToRect(seatFrontPoint(seat, c.radius), rect) < c.radius + 0.05) return false;
      }
      // 站着的人可以被行李顶开（见 BAG_PUSH_STEP），坐着/正在起坐的人不行。
      if (standingOk && !sitting) continue;
      if (distToRect(c.pos, rect) < c.radius + 0.05) return false;
    }
    return true;
  }

  private spawnLuggage() {
    const r = this.layout.interior;
    const count = 1 + Math.floor(this.rnd() * 2);
    for (let i = 0; i < count; i++) {
      // 找一块空地放；实在挤满了就少放一件，而不是硬塞进人堆。
      for (let tries = 0; tries < 16; tries++) {
        const pos = V2(
          r.minX + 1.5 + this.rnd() * (r.maxX - r.minX - 3),
          r.minZ + 2 + this.rnd() * (r.maxZ - r.minZ - 4)
        );
        if (!this.luggageFits(pos)) continue;
        this.luggage.push({ pos, vel: V2(), rect: lugRect(pos), remaining: 3, slow: false, drag: 4, owner: null });
        break;
      }
    }
  }

  /**
   * 滑动的行李箱撞上站着的人：把一部分速度传给他（被撞开），箱子自己减速。
   * 人是被速度推走的，不是被碰撞框弹开的 —— 不会瞬移，还能被一路顶向车门。
   * 撞人记在放箱子的人头上，被撞下车算他的击落。
   */
  private suitcaseKnock(l: Luggage) {
    const speed = v2Len(l.vel);
    if (speed < 0.5) return;
    const dir = v2Scale(l.vel, 1 / speed);
    for (const c of this.characters) {
      if (!c.alive || c.seatId !== null || this.seatMoves.has(c.id) || c.id === l.owner) continue;
      if (distToRect(c.pos, l.rect) >= c.radius) continue;
      // 已经在往外走、而且比箱子快的就不用再推。
      if (c.vel.x * dir.x + c.vel.z * dir.z >= speed * 0.9) continue;
      c.vel = v2Add(c.vel, v2Scale(dir, speed * 0.8));
      c.stunTimer = Math.max(c.stunTimer, BALANCE.stunDuration * 0.5);
      if (l.owner !== null) {
        c.lastHitBy = l.owner;
        c.lastHitAt = this.time;
      }
      this.eventsOut.push({ type: 'hit', charId: c.id });
      l.vel = v2Scale(l.vel, 0.7);
    }
  }

  private updateLuggage(dt: number) {
    for (const l of this.luggage) {
      l.remaining -= dt;
      if (v2Len(l.vel) > 1e-3) {
        // 滑动的行李撞上墙、座垫、立杆、障碍物或坐着的人就停住：
        // 穿过去的话会把人夹在行李和座垫之间，求解器只能二选一。
        const next = v2Add(l.pos, v2Scale(l.vel, dt));
        if (l.slow || this.luggageFits(next, null, l)) {
          l.pos = next;
          if (!l.slow) this.suitcaseKnock(l);
        } else {
          l.vel = V2();
        }
      }
      l.vel = v2Scale(l.vel, Math.max(0, 1 - l.drag * dt));
      l.rect = lugRect(l.pos);
    }
    this.luggage = this.luggage.filter((l) => l.remaining > 0);
  }

  // ---------- 单个角色行动 ----------
  private stepCharacter(c: CharacterState, frame: InputFrame) {
    const fx = this.skillFx.get(c.id);
    const slowFromSkill = fx && fx.kind === 'xiaoli' ? 0.5 : 1;
    const slowFromGrab = c.grabHandrail !== null ? 0.8 : 1;
    const slowFromLuggage = this.luggage.some(
      (l) => l.slow && this.circleHitsRect(c.pos, c.radius, l.rect)
    ) ? 0.7 : 1;
    // 拥挤度真正生效：人越多越挪不动。原来这条进度条纯装饰。
    const slowFromCrowd = 1 - BALANCE.crowdSlowMax * this.crowdT;
    // 硬直：被推中后短时间几乎动不了。
    const stunned = c.stunTimer > 0;
    const slowFromStun = stunned ? 0.15 : 1;
    const moveSpeed =
      BALANCE.walkSpeed * slowFromSkill * slowFromGrab * slowFromLuggage * slowFromCrowd * slowFromStun;
    const btns = c.isPlayer ? this.bufferButtons(c, frame.buttons) : frame.buttons;

    // 起身过渡中：位置由插值接管，不走、不吃速度（按键照样进缓冲）。
    if (c.seatId === null && this.seatMoves.has(c.id)) return;

    if (c.seatId !== null) {
      // 坐着的人位置由 updateSeats 钉住，这里只处理按键。
      if (!stunned) {
        if (btns.has('interact')) {
          this.consumeButton(c, 'interact');
          this.toggleInteract(c);
        }
        if (btns.has('skill')) this.trySkill(c);
      }
      return;
    }

    const mag = v2Len(frame.move);
    if (mag > 0.02) {
      const dir = this.slideAroundPoles(c.pos, v2Norm(frame.move), c.radius);
      c.pos = v2Add(c.pos, v2Scale(dir, moveSpeed * (1 / BALANCE.tickRate)));
      c.facing = angleLerp(c.facing, Math.atan2(dir.x, dir.z), 0.35);
      if (!stunned) c.status = c.status === 'dashing' ? 'dashing' : 'walking';
    } else if (c.status === 'walking' || c.status === 'dashing' || c.status === 'pushing') {
      c.status = 'idle';
    }

    // 硬直期间按键不执行；玩家的按键进缓冲，硬直/冷却在缓冲窗口内结束就补发。
    if (!stunned) {
      // 坐着不能推挤、不能冲刺 —— 抢到座不等于赢，坐着的人是活靶子。
      const seated = c.seatId !== null;
      if (!seated && btns.has('dash') && c.dashCd <= 0) {
        this.consumeButton(c, 'dash');
        c.dashCd = BALANCE.dashCooldown;
        const dir = v2Norm(V2(Math.sin(c.facing), Math.cos(c.facing)));
        c.vel = v2Add(c.vel, v2Scale(dir, BALANCE.dashSpeed));
        c.status = 'dashing';
        this.eventsOut.push({ type: 'dash', charId: c.id });
      }

      if (!seated && btns.has('push') && c.pushCd <= 0) {
        this.consumeButton(c, 'push');
        c.pushCd = BALANCE.pushCooldown;
        this.applyPush(c);
        this.eventsOut.push({ type: 'push', charId: c.id });
      }

      if (btns.has('interact')) {
        this.consumeButton(c, 'interact');
        this.toggleInteract(c);
      }

      if (btns.has('skill')) this.trySkill(c);

      if (btns.has('emote')) {
        this.consumeButton(c, 'emote');
        c.emoteTimer = 1.5;
      }
    }

    c.pos = v2Add(c.pos, v2Scale(c.vel, 1 / BALANCE.tickRate));
    c.vel = v2Scale(c.vel, Math.max(0, 1 - 3.2 * (1 / BALANCE.tickRate)));

    if (c.grabHandrail !== null) {
      const rail = this.layout.handrails.find((h) => h.id === c.grabHandrail);
      if (!rail || v2Dist(c.pos, rail) > BALANCE.handrailGrabRange * 1.8) this.releaseGrab(c);
    }
  }

  /**
   * 玩家按键缓冲：把本帧按下的键记上失效时间，返回仍在窗口内的全部按键。
   * 执行了的键由 consumeButton() 取走；没执行的（硬直中、冷却只差一点）留到窗口结束。
   */
  private bufferButtons(c: CharacterState, pressed: Set<Button>): Set<Button> {
    let buf = this.inputBuffer.get(c.id);
    if (!buf) {
      buf = new Map();
      this.inputBuffer.set(c.id, buf);
    }
    for (const b of pressed) buf.set(b, this.time + INPUT_BUFFER);
    const out = new Set<Button>();
    for (const [b, until] of buf) {
      if (until < this.time) buf.delete(b);
      else out.add(b);
    }
    return out;
  }

  private consumeButton(c: CharacterState, b: Button) {
    this.inputBuffer.get(c.id)?.delete(b);
  }

  /** 技能键：可放就放；冷却只差一点（玩家、缓冲窗口内）就先等着；否则明确报"冷却中"。 */
  private trySkill(c: CharacterState) {
    if (c.skillCd <= 0) {
      this.consumeButton(c, 'skill');
      this.activateSkill(c);
      return;
    }
    if (c.isPlayer && c.skillCd <= INPUT_BUFFER) return;
    this.consumeButton(c, 'skill');
    this.eventsOut.push({ type: 'skillFail', charId: c.id, reason: 'cooldown' });
  }

  /**
   * 有效推挤计分（只在行驶/终局，上车阶段推人不算）。
   * - 推中坐着的人：seatHit（拽座是攻防，三下拽起另有 seatSteal）；
   * - 推中站着的人：pushHit 基础分，外加"逼门"分 —— 对方离开着的门越近越多，
   *   门口 doorPressureRange 以外为 0。只奖励"把人往危险里推"，平时乱推只有零头。
   */
  private scorePushHit(c: CharacterState, t: CharacterState) {
    if (this.phase !== 'driving' && this.phase !== 'finale') return;
    if (t.seatId !== null) {
      this.addScore(c, SCORE.seatHit, 'push');
      return;
    }
    let pts: number = SCORE.pushHit;
    let near = Infinity;
    for (const d of this.layout.doors) {
      if (!d.open) continue;
      near = Math.min(near, v2Dist(t.pos, V2(this.layout.interior.maxX, (d.zMin + d.zMax) / 2)));
    }
    if (near < SCORE.doorPressureRange) pts += SCORE.doorPressure * (1 - near / SCORE.doorPressureRange);
    this.addScore(c, pts, 'push');
  }

  private applyPush(c: CharacterState) {
    const dir = v2Norm(V2(Math.sin(c.facing), Math.cos(c.facing)));
    c.status = 'pushing';
    const bonus = 1 + BALANCE.crowdPushBonus * this.crowdT;
    for (const t of this.characters) {
      if (t.id === c.id || !t.alive) continue;
      const to = v2Sub(t.pos, c.pos);
      const dist = v2Len(to);
      if (dist > BALANCE.pushRange) continue;
      if (v2DotNormalized(to, dir) < 0.25) continue;
      let knock: number = BALANCE.pushImpulse * bonus;
      if (t.grabHandrail !== null) knock *= 1 - BALANCE.handrailDamageReduction;
      if (t.hitProtect > 0) knock *= 0.4;
      const tfx = this.skillFx.get(t.id);
      if (tfx && tfx.kind === 'aqiang') knock = 0;
      if (tfx && tfx.kind === 'xiaoli') knock *= 0.3;
      if (knock > 0) {
        t.vel = v2Add(t.vel, v2Scale(dir, knock));
        t.hitProtect = BALANCE.hitProtection;
        t.stunTimer = BALANCE.stunDuration;
        t.status = 'stunned';
        // 记归属：没有这一条就写不出"我把兰姐挤下了车"，击落也无法计分。
        t.lastHitBy = c.id;
        t.lastHitAt = this.time;
        this.eventsOut.push({ type: 'hit', charId: t.id });
        if (this.phase === 'driving' || this.phase === 'finale') c.pushHits++;
        this.scorePushHit(c, t);
        // 推坐着的人：扣稳定度，三下把他拽起来，座位空出来给人抢。
        if (t.seatId !== null) {
          t.sitStability -= SEAT.hitCost;
          if (t.sitStability <= 0) {
            this.unseat(t, c.id, true);
            if (this.phase === 'driving') this.addScore(c, SCORE.seatSteal, 'push');
          }
        }
      }
      if (tfx && tfx.kind === 'aqiang') this.skillFx.delete(t.id);
    }
    c.vel = v2Add(c.vel, v2Scale(dir, -1.2));
  }

  /**
   * 交互键做四件事：坐下 / 起身 / 抓扶手 / 松手。
   * 横屏 4 个按钮已经很挤，不再加第 5 个；具体这一下按的是什么，
   * 由 snapshot.interactHint 驱动按钮文案，玩家不会按瞎。
   */
  private toggleInteract(c: CharacterState) {
    if (c.seatId !== null) {
      this.unseat(c, null, false);
      return;
    }
    if (this.phase !== 'finale' && c.sitLockTimer <= 0) {
      const seat = this.nearestFreeSeat(c);
      if (seat) {
        this.sitDown(c, seat);
        return;
      }
    }
    this.toggleGrab(c);
  }

  /** 够得着的空座：角色中心到座垫边缘 ≤ SEAT.reachEdge（贴着座垫就能坐）。 */
  private nearestFreeSeat(c: CharacterState): Seat | null {
    let best: Seat | null = null;
    let bestD: number = SEAT.reachEdge;
    for (const s of this.layout.seats) {
      if (!this.seatFree(s.id)) continue;
      const d = distToRect(c.pos, s.cushion);
      if (d <= bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  /** 供 probe/测试用：玩家现在按交互键能不能坐下。 */
  canSit(id = 0): boolean {
    const c = this.characters[id];
    return !!c && c.alive && c.seatId === null && this.phase !== 'finale'
      && c.sitLockTimer <= 0 && !this.seatMoves.has(c.id) && this.nearestFreeSeat(c) !== null;
  }

  /**
   * 最近的空座，给 HUD 和地面标记做导航。
   *
   * 之所以要把它放进 snapshot：bot 直接调 nearestFreeSeat() 就知道该往哪走，
   * 玩家却只能从按钮上两个字的变化里推断，且只有贴到 0.85m 内才变 ——
   * 结果就是"AI 都会坐，我不知道怎么坐"。信息不对称必须在这里抹平。
   */
  private seatGuideFor(c: CharacterState): SeatGuide | null {
    if (c.seatId !== null || this.phase === 'finale') return null;
    // 选座按"到座垫边缘"的距离，和能不能坐的判定口径一致；dist 仍报到座位点的距离。
    let best: Seat | null = null;
    let bestEdge = Infinity;
    for (const s of this.layout.seats) {
      if (!this.seatFree(s.id)) continue;
      const e = distToRect(c.pos, s.cushion);
      if (e < bestEdge) {
        bestEdge = e;
        best = s;
      }
    }
    if (!best) return null;
    const bestD = v2Dist(c.pos, best);
    const lockLeft = Math.max(0, c.sitLockTimer);
    return {
      id: best.id, x: best.x, z: best.z, dist: bestD,
      inReach: distToRect(c.pos, best.cushion) <= SEAT.reachEdge && lockLeft <= 0,
      lockLeft
    };
  }

  /** 交互键这一下会做什么，用来驱动按钮文案。 */
  private interactHintFor(c: CharacterState): Snapshot['interactHint'] {
    if (c.seatId !== null) return 'stand';
    if (this.phase !== 'finale' && c.sitLockTimer <= 0 && this.nearestFreeSeat(c)) return 'sit';
    if (c.grabHandrail !== null) return 'release';
    for (const h of this.layout.handrails) {
      if (!this.railOwner.has(h.id) && v2Dist(c.pos, h) < BALANCE.handrailGrabRange) return 'grab';
    }
    return 'none';
  }

  private toggleGrab(c: CharacterState) {
    if (c.grabHandrail !== null) {
      this.releaseGrab(c);
      this.eventsOut.push({ type: 'release', charId: c.id });
      return;
    }
    let best: Handrail | null = null;
    let bestD: number = BALANCE.handrailGrabRange;
    for (const h of this.layout.handrails) {
      if (this.railOwner.has(h.id)) continue;
      const d = v2Dist(c.pos, h);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    if (best) {
      c.grabHandrail = best.id;
      c.status = 'grabbing';
      this.railOwner.set(best.id, c.id);
      this.eventsOut.push({ type: 'grab', charId: c.id, railId: best.id });
    } else {
      // 抓空也要给反馈：以前按下去毫无动静，玩家根本不知道发生了什么。
      this.eventsOut.push({ type: 'grabFail', charId: c.id });
    }
  }

  private releaseGrab(c: CharacterState) {
    if (c.grabHandrail !== null) {
      this.railOwner.delete(c.grabHandrail);
      c.grabHandrail = null;
      if (c.status === 'grabbing') c.status = 'idle';
    }
  }

  /**
   * 阿远行李箱的放置点与滑出方向：先试正前方一个箱子的距离，再沿身体两侧各偏 0.3 / 0.6、
   * 稍微贴近一点，最后斜 25° / 50° 方向（箱子就朝那个方向滑）。都不行返回 null。
   * 站着的人不阻挡（见 luggageFits 的 standingOk）。
   */
  private placeSuitcase(c: CharacterState): { pos: Vec2; dir: Vec2 } | null {
    const ahead = c.radius + LUG_HX + 0.05;
    const tries: [number, number, number][] = [
      [0, ahead, 0], [0, ahead, 0.3], [0, ahead, -0.3], [0, ahead, 0.6], [0, ahead, -0.6], [0, ahead - 0.15, 0],
      [0.45, ahead, 0], [-0.45, ahead, 0], [0.9, ahead, 0], [-0.9, ahead, 0]
    ];
    for (const [turn, fwd, lat] of tries) {
      const a = c.facing + turn;
      const f = V2(Math.sin(a), Math.cos(a));
      const side = V2(f.z, -f.x);
      const p = V2(c.pos.x + f.x * fwd + side.x * lat, c.pos.z + f.z * fwd + side.z * lat);
      if (this.luggageFits(p, c, null, true)) return { pos: p, dir: f };
    }
    return null;
  }

  /** 这个角色现在按技能能不能放出来（冷却好了、阿远身前放得下）。供 bot 决策用。 */
  canUseSkill(id: number): boolean {
    const c = this.characters[id];
    if (!c || !c.alive || c.skillCd > 0) return false;
    return c.defId !== 'ayuan' || this.placeSuitcase(c) !== null;
  }

  private activateSkill(c: CharacterState) {
    const def = characterById(c.defId);
    // 阿远的行李箱要有地方放。以前身前 0.5 米内站着人就判"放不下"（机器人成功率 10%，
    // 玩家对着人群几乎按不出来），可行李箱本来就是用来撞人的：现在站着的人不算阻挡，
    // 只有墙/座垫/靠背/立杆/障碍物/填充体/别的行李/坐着或正在起坐的人才算；
    // 正前方放不下就往两侧偏一点再试。真放不下：不进冷却，提示"放不下"，换个方向再按。
    let ayuan: { pos: Vec2; dir: Vec2 } | null = null;
    if (def.id === 'ayuan') {
      ayuan = this.placeSuitcase(c);
      if (!ayuan) {
        this.eventsOut.push({ type: 'skillFail', charId: c.id, reason: 'blocked' });
        return;
      }
    }
    c.skillCd = def.skillCooldown;
    const fx: SkillFx = { kind: def.id, remaining: def.skillDuration, data: {} };
    const dir = v2Norm(V2(Math.sin(c.facing), Math.cos(c.facing)));
    this.eventsOut.push({ type: 'skill', charId: c.id });

    switch (def.id) {
      case 'xiaoxia':
        c.vel = v2Add(c.vel, v2Scale(dir, 10));
        fx.remaining = 0;
        break;
      case 'lanjie': {
        // 软障碍：不参与碰撞，踩上去减速 30%（描述写的就是这个）。
        const pos = v2Add(c.pos, v2Scale(dir, 1.2));
        this.luggage.push({ pos, vel: V2(), rect: lugRect(pos), remaining: 4, slow: true, drag: 4, owner: c.id });
        fx.remaining = 0;
        break;
      }
      case 'ayuan': {
        // 以前碰撞框按施法者自己的位置算，施放那一帧把施法者弹开约 1m；
        // 初速 5、阻尼 4 也只滑 1.2 格。现在：框按行李位置算、放在身前不压到自己，
        // 初速 6.6、阻尼 2，1.2 秒内滑行 ≈ 6.6/2·(1-e^-2.4) ≈ 3 格，与描述一致。
        const pos = ayuan ? ayuan.pos : v2Add(c.pos, v2Scale(dir, c.radius + LUG_HX + 0.05));
        const slide = ayuan ? ayuan.dir : dir;
        this.luggage.push({
          pos, vel: v2Scale(slide, 6.6), rect: lugRect(pos), remaining: 1.2, slow: false, drag: 2, owner: c.id
        });
        fx.remaining = 0;
        break;
      }
      case 'xiaomai':
        fx.data.delay = 0.8;
        break;
      case 'amo':
        fx.data.radiusScale = 0.8;
        break;
      default:
        break;
    }
    if (fx.remaining > 0 || fx.data.delay) this.skillFx.set(c.id, fx);
    c.skillRemaining = Math.max(0, fx.remaining);
  }

  private updateSkillFx(c: CharacterState, dt: number) {
    const fx = this.skillFx.get(c.id);
    if (!fx) {
      c.skillRemaining = 0;
      return;
    }
    if (fx.data.delay !== undefined) {
      fx.data.delay -= dt;
      if (fx.data.delay <= 0) {
        delete fx.data.delay;
        for (const t of this.characters) {
          if (t.id === c.id || !t.alive) continue;
          const d = v2Dist(t.pos, c.pos);
          if (d < 2.2 && d > 1e-3) {
            t.vel = v2Add(t.vel, v2Scale(v2Norm(v2Sub(t.pos, c.pos)), 6.5));
            t.hitProtect = BALANCE.hitProtection;
            t.stunTimer = BALANCE.stunDuration;
            t.lastHitBy = c.id;
            t.lastHitAt = this.time;
            this.eventsOut.push({ type: 'hit', charId: t.id });
          }
        }
      }
    }
    fx.remaining -= dt;
    // 视图靠这个值决定要不要挂持续技能的状态环，以前它从来没被写过。
    c.skillRemaining = Math.max(0, fx.remaining);
    if (fx.data.radiusScale) c.radius = BALANCE.characterRadius * fx.data.radiusScale;
    if (fx.remaining <= 0 && fx.data.delay === undefined) {
      c.radius = BALANCE.characterRadius;
      c.skillRemaining = 0;
      this.skillFx.delete(c.id);
    }
  }

  private updateCooldowns(c: CharacterState, dt: number) {
    c.dashCd = Math.max(0, c.dashCd - dt);
    c.pushCd = Math.max(0, c.pushCd - dt);
    c.skillCd = Math.max(0, c.skillCd - dt);
    c.hitProtect = Math.max(0, c.hitProtect - dt);
    c.stunTimer = Math.max(0, c.stunTimer - dt);
    c.emoteTimer = Math.max(0, c.emoteTimer - dt);
    this.updateSkillFx(c, dt);
    if (c.status === 'stunned' && c.stunTimer <= 0) c.status = 'idle';
  }

  // ---------- 碰撞 ----------
  /**
   * 碰撞求解。
   *
   * 静态约束：墙（含关着的门、站台围栏）、靠背、座垫、固定障碍物、填充体、实心行李、立杆。
   * 站着的人全部参与；坐着的人被钉在座位点、不参与；起身过渡中的人位置由插值决定，
   * 对别人是"推不动的"（别人让开，他自己不被推），这样落脚点有人时会被平滑挤开。
   *
   * 人和人的分离每轮有上限（MAX_SEP_STEP），一次性叠进去的人几帧内散开而不是一帧弹开。
   * 最后再补两轮纯静态求解：人推人可能把某人顶进立杆/座垫，最终位置必须满足静态约束。
   */
  private resolveAllCollisions() {
    const rects: Rect[] = baseWalls();
    for (const d of this.layout.doors) {
      if (!d.open) rects.push({ minX: 2.7, maxX: 3.0, minZ: d.zMin, maxZ: d.zMax });
    }
    rects.push(PLATFORM_FENCE);
    // 上车阶段站台四周围栏：8 个机器人一起冲后门，没有围栏会互相把人挤下站台，
    // 开局就有人被判淘汰。
    if (this.phase === 'boarding' || this.phase === 'ignition') rects.push(...boardingFence());
    for (const st of this.layout.seats) rects.push(st.backRect, st.cushion);
    for (const o of this.layout.obstacles) rects.push(o.rect);
    rects.push(...this.layout.fillers);
    // 行李先解、固定几何后解：两者冲突时（人被夹在中间）让墙/座垫/立杆说了算，
    // 人可以和行李略微穿插，但绝不能被挤进座垫或立杆。
    const bags: Rect[] = [];
    for (const l of this.luggage) if (!l.slow) bags.push(l.rect);
    this.nav.setDynamic(bags);

    const standing = this.characters.filter(
      (c) => c.alive && c.seatId === null && !this.seatMoves.has(c.id)
    );
    // 行李顶人：每人每帧最多被顶开 BAG_PUSH_STEP（行李刷在人身上时平滑挤开，不瞬移）。
    const bagBudget = new Map<number, number>();
    const resolveStatic = (c: CharacterState) => {
      for (const b of bags) {
        const to = resolveCircleRect(c.pos, c.radius, b);
        const dx = to.x - c.pos.x;
        const dz = to.z - c.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 1e-9) continue;
        const left = bagBudget.get(c.id) ?? BAG_PUSH_STEP;
        const k = Math.min(1, left / d);
        bagBudget.set(c.id, left - d * k);
        c.pos = V2(c.pos.x + dx * k, c.pos.z + dz * k);
      }
      for (const w of rects) c.pos = resolveCircleRect(c.pos, c.radius, w);
      for (const h of this.layout.handrails) c.pos = resolveCirclePole(c.pos, c.radius, h);
    };
    // 人推人：坐着的不参与；起身过渡中的是"推不动的"一方。
    const inPairs = this.characters.filter((c) => c.alive && c.seatId === null);
    const kinematic = (c: CharacterState) => this.seatMoves.has(c.id);
    // 缓冲落地期的人：本帧还能被人推开多少。
    const budget = new Map<number, number>();
    for (const [id, until] of this.settleUntil) {
      if (until <= this.time) this.settleUntil.delete(id);
      else budget.set(id, SETTLE_STEP);
    }
    /** 沿 n 挪 amount（可正可负）；缓冲落地期的人按位移大小扣预算。 */
    const shove = (c: CharacterState, n: Vec2, amount: number) => {
      const left = budget.get(c.id);
      let mag = Math.abs(amount);
      if (left !== undefined) {
        mag = Math.min(mag, Math.max(0, left));
        budget.set(c.id, left - mag);
      }
      c.pos = v2Add(c.pos, v2Scale(n, Math.sign(amount) * mag));
    };

    for (let iter = 0; iter < 3; iter++) {
      for (const c of standing) resolveStatic(c);
      for (let i = 0; i < inPairs.length; i++) {
        const a = inPairs[i];
        for (let j = i + 1; j < inPairs.length; j++) {
          const b = inPairs[j];
          const ka = kinematic(a);
          const kb = kinematic(b);
          if (ka && kb) continue;
          const d = v2Dist(a.pos, b.pos);
          const min = a.radius + b.radius;
          if (d >= min) continue;
          const n = d > 1e-6 ? v2Norm(v2Sub(a.pos, b.pos)) : V2(1, 0);
          const overlap = min - d;
          if (ka) {
            shove(b, n, -Math.min(overlap, MAX_SEP_STEP));
          } else if (kb) {
            shove(a, n, Math.min(overlap, MAX_SEP_STEP));
          } else {
            const half = Math.min(overlap / 2, MAX_SEP_STEP);
            shove(a, n, half);
            shove(b, n, -half);
          }
        }
      }
    }
    for (let k = 0; k < 2; k++) for (const c of standing) resolveStatic(c);
  }

  /**
   * 正对立杆移动时的切向滑移。
   * 碰撞只沿法线把人推回去，正对杆心走的人切向分量为 0，会永远顶在杆上。
   * 这里在"快贴上杆"时去掉朝杆的分量，只保留切向；几乎正对时挑一侧绕：
   * 优先原方向已经偏过去的那一侧，完全正对就挑导航网格上是空地的那一侧。
   */
  private slideAroundPoles(p: Vec2, dir: Vec2, r: number): Vec2 {
    let d = dir;
    for (const h of this.layout.handrails) {
      const tx = h.x - p.x;
      const tz = h.z - p.z;
      const dist = Math.hypot(tx, tz);
      if (dist < 1e-6 || dist > r + POLE_RADIUS + 0.15) continue;
      const nx = tx / dist;
      const nz = tz / dist;
      const into = d.x * nx + d.z * nz;
      if (into <= 0) continue;
      const sx = d.x - nx * into;
      const sz = d.z - nz * into;
      const sl = Math.hypot(sx, sz);
      if (sl > 0.35) {
        d = V2(sx / sl, sz / sl);
        continue;
      }
      // 两个切向：左 (-nz, nx)、右 (nz, -nx)。
      const left = V2(-nz, nx);
      const right = V2(nz, -nx);
      let pick: Vec2;
      if (sl > 1e-3) {
        pick = sx * left.x + sz * left.z > 0 ? left : right;
      } else {
        const probe = (t: Vec2) => this.nav.isFree(V2(p.x + t.x * 0.6 + d.x * 0.3, p.z + t.z * 0.6 + d.z * 0.3));
        pick = probe(left) || !probe(right) ? left : right;
      }
      d = pick;
    }
    return d;
  }

  private circleHitsRect(p: Vec2, r: number, rect: Rect): boolean {
    const cx = clamp(p.x, rect.minX, rect.maxX);
    const cz = clamp(p.z, rect.minZ, rect.maxZ);
    const dx = p.x - cx;
    const dz = p.z - cz;
    return dx * dx + dz * dz < r * r;
  }

  // ---------- 淘汰 ----------
  private checkEliminations() {
    // 上车/点火阶段有围栏兜着，不判淘汰：开局就被同伴挤下站台太劝退。
    // 终点停稳后也不判：存活名单在停稳那一刻已经定了。
    if (this.phase === 'boarding' || this.phase === 'ignition' || this.arrived) return;
    const r = this.layout.interior;
    for (const c of this.characters) {
      if (!c.alive) continue;
      const out =
        c.pos.x < r.minX - FALL_GRACE || c.pos.x > r.maxX + FALL_GRACE ||
        c.pos.z < r.minZ - FALL_GRACE || c.pos.z > r.maxZ + FALL_GRACE;
      if (out) this.eliminate(c);
    }
  }

  private eliminate(c: CharacterState) {
    this.seatMoves.delete(c.id);
    this.settleUntil.delete(c.id);
    if (this.time < BALANCE.returnProtectionUntil && !c.returnProtectionUsed) {
      c.returnProtectionUsed = true;
      c.alive = false;
      c.status = 'returning';
      c.respawnTimer = BALANCE.respawnDelay;
      c.skillCd = Math.min(c.skillCd + c.skillCd * BALANCE.returnSkillLoss, 12);
      this.releaseGrab(c);
      this.unseat(c, null, false);
      this.eventsOut.push({ type: 'eliminate', charId: c.id });
      // 返场是固定 3 秒，不是"下一站"。
      this.banner(
        c.isPlayer
          ? `你被挤下车 · ${BALANCE.respawnDelay} 秒后返场（仅一次）`
          : `${c.name} 被挤下车 · ${BALANCE.respawnDelay} 秒后返场`,
        c.isPlayer ? 3 : 2, c.id
      );
      return;
    }
    c.alive = false;
    c.status = 'eliminated';
    c.eliminatedOrder = this.characters.filter((x) => x.eliminatedOrder > 0).length + 1;
    // 被淘汰不清零，只打折：否则前期辛苦挣的分毫无意义，玩家会更倾向于苟。
    const kept = Math.round(c.score * SCORE.eliminatedKeepRatio);
    const lost = c.score - kept;
    if (lost > 0) {
      c.score = kept;
      c.scoreParts.seat = Math.max(0, c.scoreParts.seat - lost);
    }
    this.releaseGrab(c);
    this.unseat(c, null, false);
    this.awardKnockout(c);
    this.eventsOut.push({ type: 'eliminate', charId: c.id });
    this.banner(c.isPlayer ? '你被挤下车了！' : c.name + ' 被挤下车！', c.isPlayer ? 3 : 2, c.id);
    if (c.isPlayer && this.endDelay <= 0) this.endDelay = 1.6;
  }

  /**
   * 把这次淘汰算到最后推中他的人头上。
   * 环境（急刹、侧倾、晃动）导致的掉落不归任何人 —— 奖励旁观是错的。
   */
  private awardKnockout(victim: CharacterState) {
    if (victim.lastHitBy === null) return;
    if (this.time - victim.lastHitAt > SCORE.attributionWindow) return;
    const killer = this.characters[victim.lastHitBy];
    if (!killer || killer.id === victim.id) return;
    killer.knockouts++;
    const bonus = SCORE.knockout + (killer.knockouts - 1) * SCORE.knockoutStreakStep;
    this.addScore(killer, bonus, 'knockout');
    // 即时功能奖励：光给分只是记账，让进攻在"当下"变强才真正改变行为。
    killer.pushCd = 0;
    killer.skillCd = Math.max(0, killer.skillCd - 3);
    this.eventsOut.push({
      type: 'knockout', byId: killer.id, victimId: victim.id, streak: killer.knockouts
    });
  }

  private updateRespawn(c: CharacterState, dt: number) {
    if (c.status !== 'returning') return;
    c.respawnTimer -= dt;
    if (c.respawnTimer <= 0) {
      c.alive = true;
      c.status = 'idle';
      c.pos = V2(0, -5.0);
      c.vel = V2();
      c.radius = BALANCE.characterRadius;
      c.hitProtect = 1.5;
      c.stunTimer = 0;
      this.eventsOut.push({ type: 'respawn', charId: c.id });
    }
  }

  // ---------- 结果 ----------
  aliveCount(): number {
    return this.characters.filter((c) => c.alive).length;
  }

  /**
   * 名次 = 分数。
   *
   * 旧版按"离门距离 + 有没有抓扶手"排，等于明码奖励消极打法。
   * 现在存活只通过 surviveBonus 间接影响名次，同分才比是否存活、谁死得晚。
   */
  winnerRanking(): CharacterState[] {
    return this.characters.slice().sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (a.eliminatedOrder !== b.eliminatedOrder) return b.eliminatedOrder - a.eliminatedOrder;
      return b.knockouts - a.knockouts;
    });
  }

  /** 当前场上的行李/路障，供视图渲染（以前完全没画，放了路障看不见）。 */
  get activeLuggage(): readonly Luggage[] {
    return this.luggage;
  }

  snapshot(): Snapshot {
    const player = this.characters[0];
    return {
      time: this.time,
      phase: this.phase,
      crowd: Math.round(this.crowd),
      aliveCount: this.aliveCount(),
      boardTimer: this.phase === 'ignition'
        ? Math.max(0, this.ignitionTimer)
        : Math.max(0, this.boardTimer),
      stationLabel:
        this.phase === 'boarding' ? '快上车'
          : this.phase === 'ignition' ? '发车中'
            : this.phase === 'driving' ? '行驶中'
              : this.phase === 'finale' ? '终点摇摆' : '结算',
      busSpeed: this.busSpeed,
      playerRail: player ? player.grabHandrail : null,
      playerSkillActive: player ? (this.skillFx.get(player.id)?.remaining ?? 0) : 0,
      playerSeat: player ? player.seatId : null,
      playerSitStability: player ? player.sitStability : 1,
      interactHint: player && player.alive ? this.interactHintFor(player) : 'none',
      seats: this.layout.seats.map((s) => ({
        id: s.id,
        x: s.x,
        z: s.z,
        free: this.seatFree(s.id) && this.phase !== 'finale',
        mine: !!player && this.seatOwner.get(s.id) === player.id
      })),
      seatGuide: player && player.alive ? this.seatGuideFor(player) : null,
      hotZone: { x: this.hotZone.pos.x, z: this.hotZone.pos.z, r: this.hotZone.radius },
      playerInZone: !!player && player.alive && player.seatId === null
        && this.hotZone.contains(player.pos),
      playerAlive: !!player && player.alive,
      doorsOpen: (this.phase === 'driving' || this.phase === 'finale')
        && this.layout.doors.some((d) => d.open),
      playerScore: player ? Math.round(player.score) : 0,
      playerRank: player
        ? this.characters.filter((c) => c.score > player.score).length + 1
        : 1
    };
  }
}

function v2DotNormalized(a: Vec2, b: Vec2): number {
  const la = v2Len(a);
  const lb = v2Len(b);
  if (la < 1e-6 || lb < 1e-6) return 0;
  return (a.x * b.x + a.z * b.z) / (la * lb);
}
