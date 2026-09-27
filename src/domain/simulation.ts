import {
  V2, v2Add, v2Sub, v2Scale, v2Norm, v2Dist, v2Len, clamp, lerp, angleLerp, type Vec2
} from '../core/math';
import { BALANCE, SEAT, NPC, INPUT_BUFFER } from '../config/balance';
import { EVENTS, STATION_TEXT, STATION_NAMES, TERMINAL_NAME, type EventKind } from '../config/events';
import {
  LAYOUT, NPC_SPOTS, baseWalls, boardingFence, PLATFORM_FENCE, POLE_RADIUS, distToRect,
  seatApproachPoint, standable, doorCenterZ,
  type BusLayout, type Rect, type Handrail, type Seat, type Door
} from './layout';
import { NavGrid } from './nav';
import type {
  CharacterState, NpcState, Phase, ActiveEvent, GameEvent, Snapshot, SeatGuide, SeatInfo, BannerPrio,
  RoundResult, StationKind
} from './types';
import type { InputFrame, Button } from '../core/input';
import { BotBrain, type BotView, type GrabPreview } from './ai';

/**
 * 规则层（docs/08-派对玩法重构.md 第 6 节）。
 *
 * 一回合：上车 → 点火 → 途经 4 站（上客潮 / 下客潮 / 普通轮换，站间 1~2 个机关）→ 好挤模式 → 终点。
 * 核心循环："推晕 → 拖走 → 扔下车"：推、冲、机关都扣平衡值，掉光摔倒；抓住摔倒的人拖到开着的门口，
 * 按"扔"甩出去就淘汰。只剩 1 人提前结束；到终点时还在车上的都算赢。
 *
 * 规则层是纯 TypeScript，不引用画面层；画面、界面、会话层只通过 types.ts 的约定读它。
 */

export interface RosterEntry {
  defId: string;
  name: string;
  color: string;
  isPlayer: boolean;
}

/** 坐下 / 起身的平滑过渡（位置由插值接管，不瞬移）。 */
interface SeatMove {
  from: Vec2;
  to: Vec2;
  t: number;
  dur: number;
  seatId: number;
  kind: 'in' | 'out';
  /** 起身走完了但落脚点还压着别人时，原地多等的时间。 */
  hold: number;
}

/** 每个角色不对外公开的规则状态。 */
interface Internal {
  /** 本帧的移动输入（探针据此判断"想走"）。 */
  move: Vec2;
  /** 本帧开始时的位置（单帧位移上限用）。 */
  prevPos: Vec2;
  /** 最后一次掉平衡的时刻（回复计时）。 */
  lastHurtAt: number;
  /** 爬起保护：这之前平衡值不低于 getUpFloor。 */
  guardUntil: number;
  /** 被扯住（站着）多久了；到 holdAutoBreak 自动挣脱。 */
  heldFor: number;
  /** 拽坐着的人拽了多久。 */
  yankFor: number;
  /** 被拖着时爬起来后的挣脱倒计时；< 0 表示还没爬起来。 */
  breakFree: number;
  grabImmuneUntil: number;
  grabCdUntil: number;
  /** "抓"是按住生效：按下时没抓到东西，按着不放就自动抓第一个够得着的。坐下/起身那一按不算。 */
  grabArmed: boolean;
  sitLockUntil: number;
  dashLeft: number;
  dashHit: boolean;
  /** 被扔飞行中已经撞过的人。 */
  airHits: Set<number>;
  /** 飞行轨迹已经穿过开着的车门（此后不再碰撞，继续飞完给画面演出）。 */
  outThroughDoor: boolean;
  /** 被拖时相对拖人者的方向（平滑转向，避免瞬移）。 */
  carryDir: Vec2;
  /** 刚落地 / 刚起身 / 刚被放下：这之前单帧位移受限。 */
  settleUntil: number;
  seatMove: SeatMove | null;
  /** 玩家按键缓冲：按键 → 失效时间。 */
  buffer: Map<Button, number>;
}

interface NpcInternal {
  goalSeat: number | null;
  spot: number | null;
  door: Door | null;
  seatMove: SeatMove | null;
}

type SeatOwner = { kind: 'char' | 'npc'; id: number };

type GrabChoice =
  | { kind: 'seat'; seat: Seat }
  | { kind: 'char'; target: CharacterState }
  | { kind: 'rail'; rail: Handrail }
  | null;

/** 掉出车厢的判定留一点余量，免得刚踩到门口那一瞬间就被判死。 */
const FALL_GRACE = 0.3;
/** 两人重叠时每轮迭代最多各挪这么多（3 轮合计每帧约 0.11），重叠几帧内平滑散开而不是一帧弹开。 */
const MAX_SEP_STEP = 0.038;
/** 过渡状态（坐下/起身/被拖/落地）的单帧位移上限。 */
const KINEMATIC_STEP = 0.115;
/** 落地、起身落脚后的缓冲期。 */
const SETTLE_TIME = 0.3;
/** 被拖的人每帧最多挪这么多。 */
const CARRY_STEP = 0.1;
/** 击落归属时间窗：被推中/被扔后这么久内掉下车都算出手的人。 */
const ATTRIBUTION_WINDOW = 3;

const smoothstep = (t: number) => t * t * (3 - 2 * t);
const facingVec = (a: number): Vec2 => ({ x: Math.sin(a), z: Math.cos(a) });
const angleOf = (v: Vec2) => Math.atan2(v.x, v.z);
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.z * b.z;

/** 不动、不按键的输入帧。只读，别往里加按键。 */
const IDLE_FRAME: InputFrame = { move: { x: 0, z: 0 }, pressed: new Set<Button>(), held: new Set<Button>() };

/**
 * 卡点上车的落点：后门内侧 3×3 排开。到所有立杆 ≥ 0.66、到座垫 ≥ 0.5，落下就是合法站位。
 */
const STRAGGLER_SLOTS: Vec2[] = [
  { x: 1.35, z: -4.3 }, { x: 0.65, z: -3.4 }, { x: -0.65, z: -4.0 },
  { x: 1.35, z: -3.3 }, { x: -1.4, z: -3.3 }, { x: 0.8, z: -2.5 },
  { x: 1.5, z: -1.6 }, { x: -1.0, z: -2.4 }, { x: -0.8, z: -1.2 }
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

/** 参与人与人碰撞的一个身体（角色或路人）。 */
interface Body {
  obj: { pos: Vec2; vel: Vec2 };
  r: number;
  /** 碰撞时让出的权重：角色 1、路人 NPC.pushShare / (1 - NPC.pushShare)。 */
  w: number;
  /** 运动学：位置由插值/跟随决定，别人让开，他自己不被推。 */
  kin: boolean;
  charId: number;
  npcId: number;
}

export class Simulation implements BotView {
  characters: CharacterState[] = [];
  npcs: NpcState[] = [];
  phase: Phase = 'boarding';
  time = 0;
  /** 当前（或正在预警的）机关。 */
  event: ActiveEvent | null = null;
  boardTimer: number = BALANCE.boardDuration;
  layout: BusLayout = LAYOUT;
  /** 0~1.15 车速，驱动窗外街景；到站会掉到 0，发车会重新拉起来。 */
  busSpeed = 0;
  /** 车厢静态寻路网格（只依赖 LAYOUT 的固定几何，建一次）。 */
  readonly nav = new NavGrid(LAYOUT, BALANCE.characterRadius);

  private rnd: () => number;
  private ix: Internal[] = [];
  private npcX = new Map<number, NpcInternal>();
  private nextNpcId = 0;
  /**
   * 座位 / 扶手占用。绝不能存进 LAYOUT —— 那是模块级单例，跨回合不会重置。
   */
  private seatOwner = new Map<number, SeatOwner>();
  private railOwner = new Map<number, number>();
  private approach: Vec2[] = LAYOUT.seats.map((s) => seatApproachPoint(s, BALANCE.characterRadius));
  private pending = new Map<number, InputFrame>();
  private brain: BotBrain;
  private eventsOut: GameEvent[] = [];

  // ---- 时间线 ----
  private ignitionTimer = 0;
  private driveStart: number = BALANCE.boardDuration + BALANCE.ignitionDuration;
  /** 各站到站（开始进站刹车）的时刻。 */
  private arrivals: number[] = [];
  private finaleAt = 0;
  private stationIdx = 0;
  private stationKinds: StationKind[] = [];
  private stationNames: string[] = [];
  /** 进站：none → braking（刹车，门还关着）→ open（开门 doorOpenDuration 秒）→ none（关门发车）。 */
  private stop: 'none' | 'braking' | 'open' = 'none';
  private stopKind: StationKind = 'normal';
  private stopDoor: Door | null = null;
  private doorTimer = 0;
  private boardQueue = 0;
  private boardCooldown = 0;
  private boardSlot = 0;

  // ---- 机关 ----
  private legHazards = 0;
  private nextHazardAt = Infinity;
  private lastHazard: EventKind | null = null;
  private turnDur = 1;
  private bumpSecond = false;

  // ---- 车速与惯性 ----
  private busAccel = 0;
  private pulses: { accel: Vec2; balanceRate: number; remaining: number }[] = [];
  private envLong = 0;
  private envLat = 0;
  /** 颠簸给画面层的纵向信号（不推人），逐帧衰减。 */
  private bumpLong = 0;
  private arrivePhase: 'none' | 'braking' | 'stopped' = 'none';
  private arriveT = 0;
  private arriveV0 = 0;
  private swayTimer = 0;
  private swaySide = 1;

  // ---- 回合结束 ----
  private endDelay = -1;
  private endedEarly = false;
  private elimCount = 0;
  private result: RoundResult | null = null;

  constructor(seed = Math.floor(Math.random() * 0xffffffff)) {
    this.rnd = mulberry32(seed);
    this.brain = new BotBrain(this.rnd);
  }

  /**
   * 开一回合。seed 显式传入时整回合完全可复现（打法对照实验靠它保证可比）。
   */
  setup(roster: RosterEntry[], seed?: number) {
    this.rnd = mulberry32(seed ?? Math.floor(Math.random() * 0xffffffff));
    this.brain = new BotBrain(this.rnd);
    this.characters = [];
    this.npcs = [];
    this.ix = [];
    this.npcX.clear();
    this.nextNpcId = 0;
    this.seatOwner.clear();
    this.railOwner.clear();
    this.pending.clear();
    this.eventsOut = [];
    this.time = 0;
    this.phase = 'boarding';
    this.boardTimer = BALANCE.boardDuration;
    this.ignitionTimer = 0;
    this.event = null;
    this.busSpeed = 0;
    this.busAccel = 0;
    this.pulses = [];
    this.envLong = 0;
    this.envLat = 0;
    this.bumpLong = 0;
    this.arrivePhase = 'none';
    this.arriveT = 0;
    this.arriveV0 = 0;
    this.swayTimer = 0;
    this.swaySide = 1;
    this.stop = 'none';
    this.stopDoor = null;
    this.doorTimer = 0;
    this.boardQueue = 0;
    this.boardCooldown = 0;
    this.boardSlot = 0;
    this.legHazards = 0;
    this.nextHazardAt = Infinity;
    this.lastHazard = null;
    this.bumpSecond = false;
    this.endDelay = -1;
    this.endedEarly = false;
    this.elimCount = 0;
    this.result = null;
    this.nav.reset();
    this.nav.beginStep();
    this.layout.doors[0].open = false; // 前门
    this.layout.doors[1].open = true; // 后门（上车）

    // 站点排期：5 段站间（发车 → 1 → 2 → 3 → 4 → 好挤模式），每段 legDuration。
    this.driveStart = BALANCE.boardDuration + BALANCE.ignitionDuration;
    let t = this.driveStart;
    this.arrivals = [];
    for (let i = 0; i <= BALANCE.stationCount; i++) {
      t += lerp(BALANCE.legDuration[0], BALANCE.legDuration[1], this.rnd());
      if (i < BALANCE.stationCount) this.arrivals.push(t);
    }
    this.finaleAt = t;
    this.stationIdx = 0;
    // 站型轮换：上客 → 下客/普通（随机先后）→ 上客 → …… 车越开越挤。
    const mid: StationKind[] = this.rnd() < 0.5 ? ['alight', 'normal'] : ['normal', 'alight'];
    const cycle: StationKind[] = ['board', ...mid];
    this.stationKinds = Array.from({ length: BALANCE.stationCount }, (_, i) => cycle[i % cycle.length]);
    const names = STATION_NAMES.slice();
    this.stationNames = [];
    for (let i = 0; i < BALANCE.stationCount; i++) {
      const k = Math.floor(this.rnd() * names.length);
      this.stationNames.push(names.splice(k, 1)[0]);
    }

    roster.forEach((entry, i) => {
      const spawn = this.layout.spawn[i % this.layout.spawn.length];
      this.characters.push({
        id: i,
        isPlayer: entry.isPlayer,
        defId: entry.defId,
        name: entry.name,
        color: entry.color,
        pos: { ...spawn },
        vel: V2(),
        facing: -Math.PI / 2,
        radius: BALANCE.characterRadius,
        status: 'idle',
        alive: true,
        balance: 1,
        downTimer: 0,
        airT: 0,
        airDur: 0,
        hold: null,
        heldBy: null,
        seatId: null,
        dashCd: 0,
        pushCd: 0,
        stunTimer: 0,
        eliminatedOrder: 0,
        lastHitBy: null,
        lastHitAt: -999,
        throwOuts: 0
      });
      this.ix.push(this.freshInternal(spawn));
    });
  }

  private freshInternal(pos: Vec2): Internal {
    return {
      move: V2(), prevPos: { ...pos }, lastHurtAt: -999, guardUntil: -999, heldFor: 0, yankFor: 0,
      breakFree: -1, grabImmuneUntil: -999, grabCdUntil: -999, grabArmed: false, sitLockUntil: -999,
      dashLeft: 0, dashHit: false, airHits: new Set(), outThroughDoor: false, carryDir: V2(0, 1),
      settleUntil: -999, seatMove: null, buffer: new Map()
    };
  }

  private banner(text: string, prio: BannerPrio, charId?: number) {
    this.eventsOut.push(charId === undefined ? { type: 'banner', text, prio } : { type: 'banner', text, prio, charId });
  }

  /** 玩家输入（默认 0 号角色）。在 tick() 里和机器人同一时刻生效。 */
  applyPlayerInput(frame: InputFrame, playerId = 0) {
    const prev = this.pending.get(playerId);
    if (!prev) {
      this.pending.set(playerId, { move: frame.move, pressed: new Set(frame.pressed), held: new Set(frame.held) });
      return;
    }
    // 同一步里调了两次：按下边沿合并，移动和按住以最后一次为准。
    for (const b of frame.pressed) prev.pressed.add(b);
    prev.move = frame.move;
    prev.held = new Set(frame.held);
  }

  tick(dt: number): GameEvent[] {
    this.time += dt;
    for (const c of this.characters) this.ix[c.id].prevPos = { ...c.pos };

    this.updatePhase(dt);
    this.updateStation(dt);
    this.updateHazards(dt);
    this.updateBusSpeed(dt);
    this.applyEnvironment(dt);

    const frozen = this.arrived || this.phase === 'ended';
    for (const c of this.characters) {
      if (!c.alive) continue;
      let frame: InputFrame = IDLE_FRAME;
      if (!frozen) {
        if (c.isPlayer) frame = this.pending.get(c.id) ?? IDLE_FRAME;
        else frame = this.brain.decide(c, this, dt);
      }
      this.stepCharacter(c, frame, dt);
    }
    this.pending.clear();

    this.updateNpcs(dt);
    this.updateHolds(dt);
    this.advanceSeatMoves(dt);
    this.updateFlights(dt);
    this.resolveAllCollisions();
    this.applyRailLeash();
    this.pinSeated();
    this.capKinematicSteps();
    this.checkEliminations();
    this.updateRoundEnd(dt);

    // 下一步（玩家输入 + 机器人决策 + 路人）的寻路重算预算。
    this.nav.beginStep(2);

    const out = this.eventsOut;
    this.eventsOut = [];
    return out;
  }

  // =====================================================================
  // 时间线
  // =====================================================================

  private updatePhase(dt: number) {
    if (this.phase === 'boarding') {
      this.boardTimer -= dt;
      if (this.boardTimer <= 0) {
        this.phase = 'ignition';
        this.ignitionTimer = BALANCE.ignitionDuration;
        this.layout.doors.forEach((d) => (d.open = false));
        this.pullStragglersAboard();
        this.banner('车门关闭 · 发动机启动', 2);
      }
      return;
    }
    if (this.phase === 'ignition') {
      this.ignitionTimer -= dt;
      if (this.ignitionTimer <= 0) {
        this.phase = 'driving';
        this.banner('出发！把别人挤下车，最后留在车上的人赢', 2);
        this.startLeg();
      }
      return;
    }
    if (this.phase === 'driving') {
      if (this.stationIdx < this.arrivals.length && this.time >= this.arrivals[this.stationIdx]
        && this.stop === 'none') {
        this.arriveStation();
      }
      if (this.time >= this.finaleAt && this.stop === 'none') {
        this.phase = 'finale';
        this.event = null;
        this.layout.doors.forEach((d) => (d.open = true));
        // 第一次摆动推迟一个周期，让"好挤模式"横幅先站住。
        this.swayTimer = BALANCE.swayInterval;
        this.banner('好挤模式！两门全开，抓稳了', 3);
      }
      return;
    }
    if (this.phase === 'finale') {
      this.layout.doors.forEach((d) => (d.open = true));
      this.updateArrival(dt);
      if (this.arrivePhase === 'none') {
        this.swayTimer -= dt;
        if (this.swayTimer <= 0) {
          this.swayTimer = BALANCE.swayInterval;
          this.swaySide *= -1;
          this.banner(this.swaySide > 0 ? '车身甩向车门！抓稳' : '车身甩回座位一侧', 1);
          this.pulse(V2(this.swaySide * BALANCE.swayImpulse, 0), BALANCE.swayPulse, BALANCE.swayBalance);
        }
      }
    }
  }

  /** 终点停靠：好挤模式最后 terminalBrake 秒平滑减速，停稳那一刻定下赢家，之后冻结淘汰和操作。 */
  private updateArrival(dt: number) {
    const brakeAt = this.finaleAt + BALANCE.finaleDuration - BALANCE.terminalBrake;
    if (this.arrivePhase === 'none') {
      if (this.time < brakeAt) return;
      this.arrivePhase = 'braking';
      this.arriveT = 0;
      this.arriveV0 = this.busSpeed;
      this.banner(`终点站${TERMINAL_NAME}到了 · 车要停了，抓稳！`, 3);
      return;
    }
    if (this.arrivePhase === 'braking') {
      this.arriveT += dt;
      if (this.arriveT >= BALANCE.terminalBrake) {
        this.arrivePhase = 'stopped';
        if (this.endDelay < 0) this.endDelay = BALANCE.terminalHold;
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

  /** 发车（或关门离站）：给这一段站间排 1~2 个机关。 */
  private startLeg() {
    const [lo, hi] = BALANCE.hazardsPerLeg;
    this.legHazards = lo + Math.floor(this.rnd() * (hi - lo + 1));
    this.nextHazardAt = this.time + 0.5 + this.rnd() * 0.8;
  }

  /** 到站：开始进站刹车；车速降下来才开门（见 updateStation）。 */
  private arriveStation() {
    this.stop = 'braking';
    this.stopKind = this.stationKinds[this.stationIdx];
    this.stopDoor = this.layout.doors[this.rnd() < 0.5 ? 0 : 1];
    this.event = null;
    this.legHazards = 0;
    this.banner(`${this.stationNames[this.stationIdx]}站到了 · ${STATION_TEXT[this.stopKind].label}`, 1);
  }

  private updateStation(dt: number) {
    if (this.phase !== 'driving') return;
    if (this.stop === 'braking' && this.busSpeed <= BALANCE.doorOpenSpeed && this.stopDoor) {
      this.stop = 'open';
      this.stopDoor.open = true;
      this.doorTimer = BALANCE.doorOpenDuration;
      this.eventsOut.push({ type: 'station', kind: this.stopKind });
      this.banner(STATION_TEXT[this.stopKind].banner, 2);
      if (this.stopKind === 'board') {
        this.boardQueue = Math.min(
          NPC.board[0] + Math.floor(this.rnd() * (NPC.board[1] - NPC.board[0] + 1)),
          NPC.max - this.npcs.length
        );
        this.boardCooldown = 0.3;
        this.boardSlot = 0;
        if (this.boardQueue > 0) this.eventsOut.push({ type: 'npcBoard', count: this.boardQueue });
      } else if (this.stopKind === 'alight') {
        this.startAlight(this.stopDoor);
      }
      return;
    }
    if (this.stop !== 'open') return;
    this.doorTimer -= dt;
    if (this.boardQueue > 0) {
      this.boardCooldown -= dt;
      // 开门后前 2 秒内陆续上来；堵着就晚一点，太晚就不上了。
      if (this.boardCooldown <= 0 && this.doorTimer > BALANCE.doorOpenDuration - 2.2) {
        if (this.spawnBoarder(this.stopDoor!)) {
          this.boardQueue--;
          this.boardCooldown = NPC.boardGap;
        } else {
          this.boardCooldown = 0.1;
        }
      }
    }
    if (this.doorTimer <= 0) {
      this.boardQueue = 0;
      if (this.stopDoor) this.stopDoor.open = false;
      this.closeDoorOnNpcs(this.stopDoor);
      this.stop = 'none';
      this.stopDoor = null;
      this.stationIdx++;
      this.banner('车门关闭', 1);
      this.startLeg();
    }
  }

  /**
   * 关门瞬间把还留在站台上的人塞进车厢（上车阶段没挤上来的人）。
   * 这是规则层唯一允许的"传送"：关门那一刻画面本来就在切换。
   */
  private pullStragglersAboard() {
    const r = this.layout.interior;
    let slot = 0;
    const names: string[] = [];
    let playerLate = false;
    for (const c of this.characters) {
      if (!c.alive) continue;
      if (c.pos.x >= r.minX && c.pos.x <= r.maxX && c.pos.z >= r.minZ && c.pos.z <= r.maxZ) continue;
      this.dropHolds(c);
      c.pos = { ...STRAGGLER_SLOTS[slot % STRAGGLER_SLOTS.length] };
      c.vel = V2();
      this.ix[c.id].prevPos = { ...c.pos };
      slot++;
      names.push(c.name);
      if (c.isPlayer) playerLate = true;
    }
    if (names.length === 0) return;
    if (playerLate) this.banner('你卡点挤上了车！', 2);
    else this.banner(names.length === 1 ? names[0] + ' 卡点挤上车！' : `${names.length} 人卡点挤上车！`, 1);
  }

  // =====================================================================
  // 机关
  // =====================================================================

  private updateHazards(dt: number) {
    const e = this.event;
    if (e) {
      if (e.warnRemaining > 0) {
        e.warnRemaining -= dt;
        if (e.warnRemaining <= 0) this.startHazardEffect(e);
        return;
      }
      e.remaining -= dt;
      if (e.kind === 'bump' && !this.bumpSecond && e.remaining <= EVENTS.bump.duration - 0.3) {
        this.bumpSecond = true;
        this.bumpJolt(0.55);
      }
      if (e.remaining <= 0) {
        this.event = null;
        this.legHazards--;
        this.nextHazardAt = this.time + 0.5 + this.rnd() * 1.0;
      }
      return;
    }
    if (this.phase !== 'driving' || this.stop !== 'none' || this.legHazards <= 0) return;
    if (this.time < this.nextHazardAt) return;
    const nextStop = this.stationIdx < this.arrivals.length ? this.arrivals[this.stationIdx] : this.finaleAt;
    const kinds: EventKind[] = (['brake', 'turn', 'bump'] as EventKind[]).filter((k) => k !== this.lastHazard);
    const kind = kinds[Math.floor(this.rnd() * kinds.length)];
    const dur = kind === 'turn'
      ? lerp(BALANCE.turnDuration[0], BALANCE.turnDuration[1], this.rnd())
      : EVENTS[kind].duration;
    // 整个机关（预警 + 生效）必须在下一次进站前结束：机关期间车门一定是关着的。
    if (nextStop - this.time < BALANCE.hazardWarn + dur + 0.3) {
      this.legHazards = 0;
      return;
    }
    const side = kind === 'turn' ? (this.rnd() < 0.5 ? 1 : -1) : 0;
    this.turnDur = dur;
    this.event = { kind, label: EVENTS[kind].label, warnRemaining: BALANCE.hazardWarn, remaining: dur, side };
    this.lastHazard = kind;
    this.bumpSecond = false;
    const text = kind === 'turn'
      ? (side > 0 ? '前方急转弯 · 车身要甩向车门！抓稳' : '前方急转弯 · 车身要甩向座位一侧')
      : EVENTS[kind].warnText;
    this.banner(text, 2);
    this.eventsOut.push({ type: 'eventStart', kind });
  }

  private startHazardEffect(e: ActiveEvent) {
    // 急刹、急转弯的力都是持续施加的（刹车惯性、转弯横向加速度），见 updateBusSpeed / applyEnvironment。
    if (e.kind === 'bump') this.bumpJolt(1);
  }

  /** 颠簸：全车一起踉跄。站着的人直接扣平衡、随机方向踢一下；坐着的不受影响。 */
  private bumpJolt(scale: number) {
    for (const c of this.characters) {
      if (!c.alive || c.seatId !== null || this.ix[c.id].seatMove) continue;
      if (c.status === 'carried' || c.status === 'thrown') continue;
      const mul = c.hold?.kind === 'rail' ? BALANCE.railEnvMul : 1;
      const a = this.rnd() * Math.PI * 2;
      c.vel = v2Add(c.vel, V2(Math.cos(a) * BALANCE.bumpKick * mul * scale, Math.sin(a) * BALANCE.bumpKick * mul * scale));
      if (c.status !== 'down') this.loseBalance(c, BALANCE.bumpBalance * mul * scale, null);
    }
    // 给画面层一个上下颠的信号（纵向短脉冲，不推人）。
    this.bumpLong = (this.rnd() < 0.5 ? -1 : 1) * 25 * scale;
  }

  // =====================================================================
  // 车速与环境
  // =====================================================================

  private updateBusSpeed(dt: number) {
    const before = this.busSpeed;
    if (this.phase === 'finale' && this.arrivePhase !== 'none') {
      const k = this.arrivePhase === 'stopped' ? 1 : smoothstep(Math.min(1, this.arriveT / BALANCE.terminalBrake));
      this.busSpeed = this.arriveV0 * (1 - k);
    } else {
      let want = 0;
      let rate: number = BALANCE.busAccelRate;
      if (this.phase === 'ignition') {
        // 前一半原地发动，后一半像出站一样起步。
        const elapsed = BALANCE.ignitionDuration - Math.max(0, this.ignitionTimer);
        want = elapsed < BALANCE.ignitionDuration * 0.5 ? 0 : 1;
      } else if (this.phase === 'driving') {
        want = this.stop !== 'none' ? 0 : 1;
        if (this.stop !== 'none') rate = BALANCE.stationBrakeRate;
        const e = this.event;
        if (e && e.kind === 'brake' && e.warnRemaining <= 0 && e.remaining > 0) {
          want = BALANCE.brakeHazardFloor;
          rate = BALANCE.brakeHazardRate;
        }
      } else if (this.phase === 'finale') {
        want = BALANCE.finaleSpeed;
      } else if (this.phase === 'ended') {
        want = this.busSpeed;
      }
      if (want < this.busSpeed && rate === BALANCE.busAccelRate) rate = BALANCE.stationBrakeRate;
      this.busSpeed += (want - this.busSpeed) * (1 - Math.exp(-rate * dt));
    }
    this.busAccel = dt > 0 ? (this.busSpeed - before) / dt : 0;
  }

  /**
   * 汇总本帧所有环境加速度，施加给乘客：
   * 1) 惯性（纵向）+ 急转弯（横向）：超过"站得住"阈值的部分推人，并按冲量扣平衡；
   * 2) 好挤模式的持续侧倾：只推人、不扣平衡；
   * 3) 短脉冲（好挤模式换边）：推人，并按自带的速率扣平衡。
   * 抓扶手的人打 railEnvMul 折扣；坐着的、正在坐下/起身的、被拖着的、在空中的不受影响；
   * 摔倒的人照样被甩着滑（不扣平衡）。
   */
  private applyEnvironment(dt: number) {
    if (dt <= 0) return;
    let ax = 0;
    const az = -BALANCE.inertiaGain * this.busAccel;
    const e = this.event;
    if (e && e.kind === 'turn' && e.warnRemaining <= 0 && e.remaining > 0) {
      const progress = 1 - e.remaining / Math.max(1e-3, this.turnDur);
      ax = e.side * BALANCE.turnAccel * Math.sin(Math.PI * clamp(progress, 0, 1));
    }
    let ix = 0;
    let iz = 0;
    let bal = 0;
    const mag = Math.hypot(ax, az);
    if (mag > BALANCE.envFooting) {
      const k = (mag - BALANCE.envFooting) / mag;
      ix += ax * k * dt;
      iz += az * k * dt;
      bal += (mag - BALANCE.envFooting) * dt * BALANCE.envBalancePerImpulse;
    }
    if (this.phase === 'finale') ix += this.swaySide * BALANCE.finaleTilt * this.finaleFade * dt;
    for (const p of this.pulses) {
      const step = Math.min(dt, p.remaining);
      ix += p.accel.x * step;
      iz += p.accel.z * step;
      bal += p.balanceRate * step;
      p.remaining -= step;
    }
    this.pulses = this.pulses.filter((p) => p.remaining > 1e-9);
    this.envLat = ix / dt;
    this.envLong = iz / dt + this.bumpLong;
    this.bumpLong *= 0.6;
    if (ix === 0 && iz === 0 && bal === 0) return;
    const imp = V2(ix, iz);
    for (const c of this.characters) {
      if (!c.alive || c.seatId !== null || this.ix[c.id].seatMove) continue;
      if (c.status === 'carried' || c.status === 'thrown') continue;
      if (c.status === 'down') {
        c.vel = v2Add(c.vel, imp);
        continue;
      }
      const mul = c.hold?.kind === 'rail' ? BALANCE.railEnvMul : 1;
      c.vel = v2Add(c.vel, v2Scale(imp, mul));
      if (bal > 0) this.loseBalance(c, bal * mul, null);
    }
    for (const n of this.npcs) {
      if (n.status === 'sitting' || this.npcX.get(n.id)?.seatMove) continue;
      n.vel = v2Add(n.vel, v2Scale(imp, NPC.envMul));
    }
  }

  /** 把一次性冲击改成 dur 秒的短脉冲（总冲量不变），同时按 balance 总量扣平衡。 */
  private pulse(impulse: Vec2, dur: number, balance: number) {
    this.pulses.push({ accel: v2Scale(impulse, 1 / dur), balanceRate: balance / dur, remaining: dur });
  }

  /** 本帧施加给乘客的纵向环境加速度（格/秒²，+ 朝车头 +z）。含惯性与颠簸。 */
  get longAccel(): number {
    return this.envLong;
  }

  /** 本帧施加给乘客的横向环境加速度（格/秒²，+ 朝 +x 车门一侧）。含急转弯、好挤模式侧倾与换边。 */
  get latAccel(): number {
    return this.envLat;
  }

  /**
   * 进站的刹车速率（车速按 e^(-rate·t) 衰减）。画面层按它推算停车点。
   * 机关里的急刹不停车，不影响这个值。
   */
  get brakeRate(): number {
    return BALANCE.stationBrakeRate;
  }

  /**
   * 从现在到停稳还要走的路程（车速·秒，乘上街景滚动速度就是世界格）。没在进站就是 0。
   * - 到站：车速按 e^(-rate·t) 衰减，剩余路程 = v / rate；
   * - 终点：车速 = v0 × (1 − smoothstep(u))，u = t / T，剩余路程 = v0·T·(½ − (u − u³ + u⁴/2))。
   */
  get stoppingDistance(): number {
    if (this.phase === 'finale' && this.arrivePhase === 'braking') {
      const T = BALANCE.terminalBrake;
      const u = Math.min(1, this.arriveT / T);
      return Math.max(0, this.arriveV0 * T * (0.5 - (u - u * u * u + (u * u * u * u) / 2)));
    }
    if (this.phase === 'driving' && this.stop !== 'none' && this.busSpeed > 0.01) {
      return this.busSpeed / BALANCE.stationBrakeRate;
    }
    return 0;
  }

  /** 好挤模式车身侧倾的方向（-1~1 连续值），供镜头做同向倾斜。 */
  get tilt(): number {
    return this.phase === 'finale' ? this.swaySide * this.finaleFade : 0;
  }

  // =====================================================================
  // 平衡值
  // =====================================================================

  /** 扣平衡（环境、路人带人）。掉光摔倒；爬起保护期内不低于 getUpFloor。 */
  private loseBalance(c: CharacterState, amount: number, byId: number | null) {
    if (amount <= 0 || c.status === 'down' || c.status === 'carried' || c.status === 'thrown') return;
    const x = this.ix[c.id];
    c.balance -= amount;
    if (this.time < x.guardUntil) c.balance = Math.max(c.balance, BALANCE.getUpFloor);
    if (amount > 0.004) x.lastHurtAt = this.time;
    if (c.balance <= 0) this.knockDown(c, byId);
  }

  /**
   * 被人打中（推、冲撞、强推、被扔出的人撞到）。
   * 坐着、正在坐下/起身、被拖着、在空中的人免疫；摔倒的人只被推着滑。
   */
  private hurt(t: CharacterState, by: CharacterState | null, amount: number, knock: number, dir: Vec2, stun: number) {
    if (!t.alive || t.seatId !== null || this.ix[t.id].seatMove) return;
    if (t.status === 'carried' || t.status === 'thrown') return;
    if (by) {
      t.lastHitBy = by.id;
      t.lastHitAt = this.time;
    }
    if (t.status === 'down') {
      t.vel = v2Add(t.vel, v2Scale(dir, knock * 0.6));
      return;
    }
    const mul = t.hold?.kind === 'rail' ? BALANCE.railPushMul : 1;
    t.vel = v2Add(t.vel, v2Scale(dir, knock * mul));
    t.stunTimer = Math.max(t.stunTimer, stun);
    this.eventsOut.push({ type: 'hit', charId: t.id, byId: by ? by.id : -1 });
    this.loseBalance(t, amount * mul, by ? by.id : null);
  }

  private knockDown(c: CharacterState, byId: number | null) {
    const x = this.ix[c.id];
    c.balance = 0;
    c.downTimer = BALANCE.downDuration;
    c.stunTimer = 0;
    x.dashLeft = 0;
    // 手里的东西全松开。
    this.dropHold(c, false);
    if (c.heldBy !== null) {
      // 被扯住时摔倒：直接变成被拖着。
      c.status = 'carried';
      const h = this.characters[c.heldBy];
      x.carryDir = v2Len(v2Sub(c.pos, h.pos)) > 1e-3 ? v2Norm(v2Sub(c.pos, h.pos)) : facingVec(h.facing);
      x.breakFree = -1;
      c.lastHitBy = h.id;
      c.lastHitAt = this.time;
    } else {
      c.status = 'down';
    }
    this.eventsOut.push({ type: 'knockdown', charId: c.id, byId });
    if (c.isPlayer) this.banner('你摔倒了！快被拖走了', 3, c.id);
  }

  private getUp(c: CharacterState) {
    const x = this.ix[c.id];
    c.status = 'idle';
    c.downTimer = 0;
    c.balance = Math.max(c.balance, BALANCE.getUpBalance);
    x.guardUntil = this.time + BALANCE.getUpGuard;
    x.lastHurtAt = this.time;
  }

  // =====================================================================
  // 单个角色
  // =====================================================================

  private stepCharacter(c: CharacterState, frame: InputFrame, dt: number) {
    const x = this.ix[c.id];
    x.move = frame.move;
    c.pushCd = Math.max(0, c.pushCd - dt);
    c.dashCd = Math.max(0, c.dashCd - dt);
    c.stunTimer = Math.max(0, c.stunTimer - dt);
    x.dashLeft = Math.max(0, x.dashLeft - dt);

    if (c.status === 'thrown') return;
    if (c.status === 'carried') {
      this.tickCarried(c, dt);
      return;
    }
    if (c.status === 'down') {
      c.downTimer -= dt;
      if (c.downTimer <= 0) this.getUp(c);
      this.integrate(c, dt);
      return;
    }
    if (x.seatMove) return; // 坐下/起身过渡：位置由插值接管
    const pressed = c.isPlayer ? this.bufferButtons(c, frame.pressed) : frame.pressed;
    const held = frame.held;

    // 平衡回复：一段时间没掉平衡才回。
    if (this.time - x.lastHurtAt >= BALANCE.balanceRegenDelay) {
      c.balance = Math.min(1, c.balance + BALANCE.balanceRegen * dt);
    }

    if (c.seatId !== null) {
      // 坐着：不能推、冲、抓；点一下"抓"起身。被人拽着时起不来。
      if (pressed.has('grab')) {
        this.consume(c, 'grab');
        if (c.heldBy === null && this.canAct()) this.standUp(c, null);
      }
      this.consume(c, 'push');
      this.consume(c, 'dash');
      return;
    }

    // "抓"是按住生效：松手就放开。
    if (!held.has('grab')) {
      x.grabArmed = false;
      if (c.hold) this.release(c);
    }

    const stunned = c.stunTimer > 0;
    // 被人扯住：按"推"是挣脱（硬直中也能挣）。
    if (pressed.has('push') && c.heldBy !== null) {
      this.consume(c, 'push');
      this.breakFree(c);
    }
    if (!stunned && this.canAct()) {
      if (pressed.has('grab')) {
        this.consume(c, 'grab');
        this.onGrabPress(c);
      } else if (held.has('grab') && x.grabArmed && !c.hold && this.time >= x.grabCdUntil) {
        const ch = this.grabChoice(c, false);
        if (ch && ch.kind !== 'seat') this.applyGrab(c, ch);
      }
      if (pressed.has('push') && c.pushCd <= 0) {
        this.consume(c, 'push');
        this.onPush(c);
      }
      if (pressed.has('dash') && c.dashCd <= 0) {
        this.consume(c, 'dash');
        this.onDash(c);
      }
    }

    // 移动
    let mul = 1;
    if (stunned) mul *= BALANCE.stunSlow;
    if (c.hold?.kind === 'rail') mul *= BALANCE.railSlow;
    if (c.hold?.kind === 'char') {
      const t = this.characters[c.hold.id];
      if (t.status === 'carried') mul *= BALANCE.carrySlow;
      else if (t.seatId !== null || this.ix[t.id].seatMove) mul *= BALANCE.yankSlow;
      else mul *= BALANCE.holdSlow;
    }
    if (c.heldBy !== null) mul *= BALANCE.holdSlow;
    const mag = Math.min(1, v2Len(frame.move));
    if (mag > 0.02) {
      const dir = this.slideAroundPoles(c.pos, v2Norm(frame.move), c.radius);
      c.pos = v2Add(c.pos, v2Scale(dir, BALANCE.walkSpeed * mul * mag * dt));
      const carrying = c.hold?.kind === 'char' && this.characters[c.hold.id].status === 'carried';
      c.facing = angleLerp(c.facing, angleOf(dir), carrying ? 0.2 : 0.35);
      if (c.status !== 'dashing') c.status = 'walking';
    } else if (c.status === 'walking') {
      c.status = 'idle';
    }
    this.integrate(c, dt);
    if (c.status === 'dashing') {
      this.checkDashHit(c);
      if (x.dashLeft <= 0) c.status = mag > 0.02 ? 'walking' : 'idle';
    }
  }

  /** 能不能出手：终点停稳、回合结束后不行。 */
  private canAct(): boolean {
    return !this.arrived && this.phase !== 'ended';
  }

  private integrate(c: { pos: Vec2; vel: Vec2 }, dt: number) {
    c.pos = v2Add(c.pos, v2Scale(c.vel, dt));
    c.vel = v2Scale(c.vel, Math.max(0, 1 - BALANCE.velDamping * dt));
  }

  /** 玩家按键缓冲：把本帧按下的键记上失效时间，返回仍在窗口内的全部按键。执行了的由 consume() 取走。 */
  private bufferButtons(c: CharacterState, pressed: Set<Button>): Set<Button> {
    const buf = this.ix[c.id].buffer;
    for (const b of pressed) buf.set(b, this.time + INPUT_BUFFER);
    const out = new Set<Button>();
    for (const [b, until] of buf) {
      if (until < this.time) buf.delete(b);
      else out.add(b);
    }
    return out;
  }

  private consume(c: CharacterState, b: Button) {
    this.ix[c.id].buffer.delete(b);
  }

  // ---------- 抓 ----------

  /**
   * "抓"这一按会做什么。优先级：
   * 1. 前方扇形里摔倒的人（杀招，最优先）；
   * 2. 够得着的空座（坐下）；
   * 3. 前方扇形里站着或坐着的人（扯住 / 拽座）；
   * 4. 够得着的空扶手。
   */
  private grabChoice(c: CharacterState, withSeat: boolean): GrabChoice {
    const f = facingVec(c.facing);
    let down: CharacterState | null = null;
    let dd = Infinity;
    let other: CharacterState | null = null;
    let od = Infinity;
    for (const o of this.characters) {
      if (o === c || !o.alive || o.heldBy !== null || o.id === c.heldBy) continue;
      if (o.status === 'thrown' || o.status === 'carried') continue;
      const ox = this.ix[o.id];
      if (ox.seatMove || this.time < ox.grabImmuneUntil) continue;
      const to = v2Sub(o.pos, c.pos);
      const d = v2Len(to);
      if (d > c.radius + o.radius + BALANCE.grabReach) continue;
      if (d > 1e-6 && dot(to, f) / d < BALANCE.grabConeCos) continue;
      if (o.status === 'down') {
        if (d < dd) { dd = d; down = o; }
      } else if (d < od) {
        od = d;
        other = o;
      }
    }
    if (down) return { kind: 'char', target: down };
    if (withSeat && c.heldBy === null) {
      const seat = this.nearestFreeSeat(c);
      if (seat) return { kind: 'seat', seat };
    }
    if (other) return { kind: 'char', target: other };
    let rail: Handrail | null = null;
    let rd: number = BALANCE.railReach;
    for (const h of this.layout.handrails) {
      if (this.railOwner.has(h.id)) continue;
      const d = v2Dist(c.pos, h);
      if (d < rd) { rd = d; rail = h; }
    }
    return rail ? { kind: 'rail', rail } : null;
  }

  private onGrabPress(c: CharacterState) {
    const x = this.ix[c.id];
    if (c.hold) return;
    if (this.time < x.grabCdUntil) {
      this.eventsOut.push({ type: 'grabFail', charId: c.id });
      return;
    }
    const ch = this.grabChoice(c, true);
    if (ch && ch.kind === 'seat') {
      this.sitDown(c, ch.seat);
      return;
    }
    x.grabArmed = true;
    if (!ch) {
      this.eventsOut.push({ type: 'grabFail', charId: c.id });
      return;
    }
    this.applyGrab(c, ch);
  }

  private applyGrab(c: CharacterState, ch: Exclude<GrabChoice, null>) {
    if (ch.kind === 'rail') {
      c.hold = { kind: 'rail', id: ch.rail.id };
      this.railOwner.set(ch.rail.id, c.id);
      this.eventsOut.push({ type: 'grab', charId: c.id, target: c.hold });
      return;
    }
    if (ch.kind !== 'char') return;
    const t = ch.target;
    const tx = this.ix[t.id];
    c.hold = { kind: 'char', id: t.id };
    t.heldBy = c.id;
    if (t.status === 'down') {
      t.status = 'carried';
      tx.carryDir = v2Len(v2Sub(t.pos, c.pos)) > 1e-3 ? v2Norm(v2Sub(t.pos, c.pos)) : facingVec(c.facing);
      tx.breakFree = -1;
      t.lastHitBy = c.id;
      t.lastHitAt = this.time;
    } else if (t.seatId !== null) {
      this.ix[c.id].yankFor = 0;
    } else {
      // 被扯住的人手里的扶手不松：抓着扶手的人拽不走，只能强推（扶手减半）。
      tx.heldFor = 0;
    }
    this.eventsOut.push({ type: 'grab', charId: c.id, target: c.hold });
  }

  /** 主动松手（或被迫松手）：抓着的人落地/站稳，扶手空出来。 */
  private release(c: CharacterState) {
    if (!c.hold) return;
    this.dropHold(c, true);
  }

  private dropHold(c: CharacterState, emit: boolean) {
    const h = c.hold;
    if (!h) return;
    c.hold = null;
    this.ix[c.id].yankFor = 0;
    if (h.kind === 'rail') {
      if (this.railOwner.get(h.id) === c.id) this.railOwner.delete(h.id);
    } else {
      const t = this.characters[h.id];
      if (t && t.heldBy === c.id) {
        t.heldBy = null;
        if (t.status === 'carried') {
          const tx = this.ix[t.id];
          tx.settleUntil = this.time + SETTLE_TIME;
          if (t.downTimer > 0) {
            t.status = 'down';
          } else {
            this.getUp(t);
            tx.grabImmuneUntil = this.time + BALANCE.breakFreeImmune;
          }
        }
      }
    }
    if (emit) this.eventsOut.push({ type: 'release', charId: c.id });
  }

  /** 两个方向的抓握全部解除（淘汰、传送时用）。 */
  private dropHolds(c: CharacterState) {
    this.dropHold(c, false);
    if (c.heldBy !== null) {
      const h = this.characters[c.heldBy];
      if (h && h.hold?.kind === 'char' && h.hold.id === c.id) {
        h.hold = null;
        this.ix[h.id].yankFor = 0;
        this.eventsOut.push({ type: 'release', charId: h.id });
      }
      c.heldBy = null;
    }
  }

  /** 被扯住（站着）的人挣脱：按"推"或 holdAutoBreak 秒后自动。 */
  private breakFree(victim: CharacterState) {
    if (victim.heldBy === null) return;
    const h = this.characters[victim.heldBy];
    if (victim.status === 'carried') return;
    this.dropHold(h, true);
    this.ix[victim.id].grabImmuneUntil = this.time + BALANCE.breakFreeImmune;
    this.ix[h.id].grabCdUntil = this.time + BALANCE.regrabCooldown;
  }

  /** 被拖着：摔倒计时走完后再过 carryBreakAfterUp 秒挣脱。 */
  private tickCarried(c: CharacterState, dt: number) {
    const x = this.ix[c.id];
    if (c.downTimer > 0) {
      c.downTimer -= dt;
      if (c.downTimer <= 0) {
        c.downTimer = 0;
        x.breakFree = BALANCE.carryBreakAfterUp;
      }
      return;
    }
    if (x.breakFree < 0) x.breakFree = BALANCE.carryBreakAfterUp;
    x.breakFree -= dt;
    if (x.breakFree <= 0 && c.heldBy !== null) {
      const h = this.characters[c.heldBy];
      this.dropHold(h, true); // 放下：downTimer 已到 0，dropHold 里会让他站起来并给抓取保护
      x.grabImmuneUntil = this.time + BALANCE.breakFreeImmune + 0.2;
      this.ix[h.id].grabCdUntil = this.time + BALANCE.regrabCooldown;
    }
  }

  /**
   * 每帧维护抓握关系：
   * - 拖着摔倒的人：被拖的人平滑贴到拖人者前方 carryOffset；
   * - 抓着坐着的人：不放 yankTime 秒就把他拽起来（直接变成扯住）；
   * - 扯住站着的人：两人之间有一根"绳"，超出就互相拉近；holdAutoBreak 秒后自动挣脱。
   */
  private updateHolds(dt: number) {
    for (const c of this.characters) {
      if (!c.alive || c.hold?.kind !== 'char') continue;
      const t = this.characters[c.hold.id];
      if (!t || !t.alive || t.heldBy !== c.id) {
        c.hold = null;
        continue;
      }
      if (c.status === 'down' || c.status === 'carried' || c.status === 'thrown' || c.seatId !== null) {
        this.dropHold(c, true);
        continue;
      }
      const tx = this.ix[t.id];
      if (t.status === 'carried') {
        this.followCarry(c, t);
        continue;
      }
      if (t.seatId !== null && !tx.seatMove) {
        const reach = c.radius + t.radius + BALANCE.grabReach + 0.25;
        if (v2Dist(c.pos, t.pos) > reach || !this.canAct()) {
          this.dropHold(c, true);
          continue;
        }
        const x = this.ix[c.id];
        x.yankFor += dt;
        if (x.yankFor >= BALANCE.yankTime) {
          x.yankFor = 0;
          this.standUp(t, c);
        }
        continue;
      }
      if (tx.seatMove) continue; // 正被拽起来：过渡走完再算
      tx.heldFor += dt;
      if (tx.heldFor >= BALANCE.holdAutoBreak) {
        this.breakFree(t);
        continue;
      }
      this.tether(c, t);
    }
  }

  private followCarry(c: CharacterState, t: CharacterState) {
    const tx = this.ix[t.id];
    const want = facingVec(c.facing);
    // 方向平滑转到拖人者正前方（每帧最多 0.15 弧度），被拖的人绕着拖人者甩过去，不会穿身而过。
    const cur = angleOf(tx.carryDir);
    const tgt = angleOf(want);
    let d = tgt - cur;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    const a = cur + clamp(d, -0.15, 0.15);
    tx.carryDir = facingVec(a);
    const target = v2Add(c.pos, v2Scale(tx.carryDir, BALANCE.carryOffset));
    const step = v2Sub(target, t.pos);
    const len = v2Len(step);
    t.pos = len > CARRY_STEP ? v2Add(t.pos, v2Scale(step, CARRY_STEP / len)) : target;
    t.vel = V2();
    t.facing = a;
  }

  private tether(c: CharacterState, t: CharacterState) {
    const d = v2Dist(c.pos, t.pos);
    if (d > BALANCE.holdTether + 0.9) {
      this.dropHold(c, true);
      return;
    }
    if (d <= BALANCE.holdTether) return;
    const excess = d - BALANCE.holdTether;
    const n = v2Norm(v2Sub(t.pos, c.pos));
    const anchored = t.hold?.kind === 'rail';
    const tShare = anchored ? 0 : 0.7;
    const tMove = Math.min(0.1, excess * tShare);
    const cMove = Math.min(0.1, excess - tMove);
    t.pos = v2Sub(t.pos, v2Scale(n, tMove));
    c.pos = v2Add(c.pos, v2Scale(n, cMove));
  }

  // ---------- 推 / 冲 / 扔 ----------

  private pushTarget(c: CharacterState, reach: number, cone: number): CharacterState | null {
    const f = facingVec(c.facing);
    let best: CharacterState | null = null;
    let bd = Infinity;
    for (const o of this.characters) {
      if (o === c || !o.alive || o.seatId !== null) continue;
      if (o.status === 'thrown' || o.status === 'carried' || this.ix[o.id].seatMove) continue;
      if (o.heldBy === c.id) continue;
      const to = v2Sub(o.pos, c.pos);
      const d = v2Len(to);
      if (d > c.radius + o.radius + reach) continue;
      if (d > 1e-6 && dot(to, f) / d < cone) continue;
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  private onPush(c: CharacterState) {
    c.pushCd = BALANCE.pushCooldown;
    this.eventsOut.push({ type: 'push', charId: c.id });
    if (c.hold?.kind === 'char') {
      const t = this.characters[c.hold.id];
      if (t.status === 'carried') {
        this.throwChar(c, t);
        return;
      }
      if (t.seatId !== null || this.ix[t.id].seatMove) return; // 拽座时推不动
      this.strongPush(c, t);
      return;
    }
    const t = this.pushTarget(c, BALANCE.pushReach, BALANCE.pushConeCos);
    if (!t) return;
    const dir = this.hitDir(c, t);
    this.hurt(t, c, BALANCE.pushBalance, BALANCE.pushKnock, dir, BALANCE.pushStun);
    c.vel = v2Add(c.vel, v2Scale(dir, -BALANCE.pushRecoil));
  }

  /** 击退方向：从出手者指向对方，略带出手者朝向。 */
  private hitDir(c: CharacterState, t: CharacterState): Vec2 {
    const to = v2Norm(v2Sub(t.pos, c.pos));
    const f = facingVec(c.facing);
    const d = v2Norm(V2(to.x * 0.7 + f.x * 0.3, to.z * 0.7 + f.z * 0.3));
    return v2Len(d) > 0 ? d : f;
  }

  /**
   * 扯住人时按"推"：强推一下（扣平衡、击退都乘 strongPushMul），松开手。
   * 这一下把他推倒的话手不松 —— 他直接软在你手里，变成被拖着（"推晕 → 拖走"一气呵成）。
   */
  private strongPush(c: CharacterState, t: CharacterState) {
    const mul = t.hold?.kind === 'rail' ? BALANCE.railPushMul : 1;
    const amount = BALANCE.pushBalance * BALANCE.strongPushMul * mul;
    let after = t.balance - amount;
    if (this.time < this.ix[t.id].guardUntil) after = Math.max(after, BALANCE.getUpFloor);
    t.lastHitBy = c.id;
    t.lastHitAt = this.time;
    if (after <= 0) {
      this.eventsOut.push({ type: 'hit', charId: t.id, byId: c.id });
      this.ix[t.id].lastHurtAt = this.time;
      this.knockDown(t, c.id); // heldBy 仍是 c：knockDown 会把他变成被拖着
      return;
    }
    this.dropHold(c, false);
    this.ix[c.id].grabArmed = false;
    const dir = this.hitDir(c, t);
    this.hurt(t, c, amount / mul, BALANCE.pushKnock * BALANCE.strongPushMul, dir, BALANCE.pushStun * 1.5);
  }

  private throwChar(c: CharacterState, t: CharacterState) {
    const f = facingVec(c.facing);
    const tx = this.ix[t.id];
    c.hold = null;
    this.ix[c.id].grabArmed = false;
    t.heldBy = null;
    t.status = 'thrown';
    t.airT = 0;
    t.airDur = BALANCE.throwAir;
    t.downTimer = 0;
    t.vel = v2Scale(f, BALANCE.throwSpeed);
    t.facing = angleOf(f);
    t.lastHitBy = c.id;
    t.lastHitAt = this.time;
    tx.airHits = new Set([c.id]);
    tx.outThroughDoor = false;
    this.eventsOut.push({ type: 'throw', byId: c.id, victimId: t.id });
  }

  private onDash(c: CharacterState) {
    const x = this.ix[c.id];
    c.dashCd = BALANCE.dashCooldown;
    x.dashLeft = BALANCE.dashDuration;
    x.dashHit = false;
    const carrying = c.hold?.kind === 'char';
    const f = facingVec(c.facing);
    c.vel = v2Add(c.vel, v2Scale(f, BALANCE.dashSpeed * (carrying ? BALANCE.carrySlow : 1)));
    c.status = 'dashing';
    this.eventsOut.push({ type: 'dash', charId: c.id });
  }

  /** 冲刺中撞到前方的人：一次冲刺只撞一个，撞到就停。 */
  private checkDashHit(c: CharacterState) {
    const x = this.ix[c.id];
    if (x.dashHit) return;
    const t = this.pushTarget(c, 0.12, 0.3);
    if (!t) return;
    x.dashHit = true;
    this.hurt(t, c, BALANCE.dashBalance, BALANCE.dashKnock, this.hitDir(c, t), BALANCE.dashStun);
    c.vel = v2Scale(c.vel, 0.3);
  }

  /**
   * 被扔出去的人：直线飞 airDur 秒，落地再瘫 throwLandDown 秒。
   * - 轨迹穿过开着的车门（中心越过车厢边线时 z 在门洞里）→ 淘汰，之后不再碰撞、继续飞完给画面演出；
   * - 撞墙、座位、立杆 → 弹回来摔倒；
   * - 撞到站着的人 → 对方失衡，自己减速继续飞；撞到路人 → 弹回摔倒。
   */
  private updateFlights(dt: number) {
    const I = this.layout.interior;
    for (const t of this.characters) {
      const x = this.ix[t.id];
      if (t.status !== 'thrown' && !(t.status === 'eliminated' && x.outThroughDoor && t.airT < t.airDur)) {
        if (!t.alive) this.integrate(t, dt); // 掉下车的人继续滑一会儿（画面演出）
        continue;
      }
      const prev = t.pos;
      t.pos = v2Add(t.pos, v2Scale(t.vel, dt));
      t.airT += dt;
      if (t.alive && !x.outThroughDoor) {
        if (prev.x <= I.maxX && t.pos.x > I.maxX) {
          const k = (I.maxX - prev.x) / Math.max(1e-6, t.pos.x - prev.x);
          const zc = prev.z + (t.pos.z - prev.z) * k;
          if (this.layout.doors.some((d) => d.open && zc >= d.zMin && zc <= d.zMax)) x.outThroughDoor = true;
        }
        if (x.outThroughDoor) {
          this.eliminate(t);
        } else {
          const before = t.pos;
          const after = this.resolveStaticFlight(before, BALANCE.throwBodyRadius);
          if (v2Dist(before, after) > 1e-6) {
            const n = v2Norm(v2Sub(after, before));
            const vn = dot(t.vel, n);
            t.pos = after;
            t.vel = v2Scale(v2Sub(t.vel, v2Scale(n, 2 * Math.min(0, vn))), 0.35);
            this.land(t);
            continue;
          }
          const dir = v2Norm(t.vel);
          for (const o of this.characters) {
            if (o === t || !o.alive || x.airHits.has(o.id)) continue;
            if (o.seatId !== null || o.status === 'thrown' || o.status === 'carried' || this.ix[o.id].seatMove) continue;
            if (v2Dist(o.pos, t.pos) > t.radius + o.radius - 0.1) continue;
            x.airHits.add(o.id);
            const thrower = t.lastHitBy !== null ? this.characters[t.lastHitBy] : null;
            this.hurt(o, thrower ?? null, BALANCE.thrownHitBalance, BALANCE.throwHitKnock, dir, BALANCE.throwHitStun);
            t.vel = v2Scale(t.vel, 0.6);
          }
          let bounced = false;
          for (const n of this.npcs) {
            if (v2Dist(n.pos, t.pos) > t.radius + n.radius - 0.1) continue;
            t.vel = v2Scale(t.vel, -0.2);
            if (n.status !== 'sitting') n.vel = v2Add(n.vel, v2Scale(dir, 1.2));
            bounced = true;
            break;
          }
          if (bounced) {
            this.land(t);
            continue;
          }
        }
      }
      if (t.airT >= t.airDur) {
        if (t.alive) this.land(t);
        else t.vel = v2Scale(t.vel, 0.35);
      }
    }
  }

  /** 飞行中的静态碰撞：飞向开着的门洞时，门两侧的车墙不挡（门洞宽 1.8，人宽 1.0，擦边也算飞出去）。 */
  private resolveStaticFlight(p: Vec2, r: number): Vec2 {
    const inDoor = this.layout.doors.some((d) => d.open && p.z >= d.zMin && p.z <= d.zMax);
    let q = p;
    for (const w of this.staticRects(inDoor)) q = resolveCircleRect(q, r, w);
    for (const h of this.layout.handrails) q = resolveCirclePole(q, r, h);
    return q;
  }

  private land(t: CharacterState) {
    const x = this.ix[t.id];
    t.status = 'down';
    t.downTimer = BALANCE.throwLandDown;
    t.airT = t.airDur;
    t.vel = v2Scale(t.vel, 0.35);
    x.settleUntil = this.time + SETTLE_TIME;
    // 刚落地的人不能马上又被抓起来扔：防止关着门时被连环"抓-扔-抓"锁死。
    x.grabImmuneUntil = this.time + BALANCE.throwLandDown + 0.4;
  }

  // ---------- 座位 ----------

  seatById(id: number): Seat | undefined {
    return this.layout.seats.find((s) => s.id === id);
  }

  /** 座位是否空着（可抢）。 */
  seatFree(id: number): boolean {
    return !this.seatOwner.has(id);
  }

  /** 扶手是否空着（forId 自己抓着的也算空）。 */
  railFree(id: number, forId = -1): boolean {
    const o = this.railOwner.get(id);
    return o === undefined || o === forId;
  }

  /** 座位的接近点（坐下前站的位置）。 */
  seatApproach(id: number): Vec2 {
    return this.approach[id];
  }

  /** 够得着的空座：角色中心到座垫边缘 ≤ SEAT.reachEdge。 */
  private nearestFreeSeat(c: CharacterState): Seat | null {
    if (this.time < this.ix[c.id].sitLockUntil || !this.canAct()) return null;
    let best: Seat | null = null;
    let bestD: number = SEAT.reachEdge;
    for (const s of this.layout.seats) {
      if (!this.seatFree(s.id)) continue;
      const d = distToRect(c.pos, s.cushion);
      if (d <= bestD) { bestD = d; best = s; }
    }
    return best;
  }

  /** 这个角色现在按"抓"能不能坐下。 */
  canSit(id = 0): boolean {
    const c = this.characters[id];
    return !!c && c.alive && c.seatId === null && !c.hold && c.heldBy === null && !this.ix[id].seatMove
      && (c.status === 'idle' || c.status === 'walking') && c.stunTimer <= 0 && this.nearestFreeSeat(c) !== null;
  }

  private sitDown(c: CharacterState, seat: Seat) {
    this.dropHolds(c);
    c.seatId = seat.id;
    c.status = 'sitting';
    c.vel = V2();
    this.seatOwner.set(seat.id, { kind: 'char', id: c.id });
    this.ix[c.id].seatMove = {
      from: { ...c.pos }, to: V2(seat.x, seat.z), t: 0, dur: SEAT.sitDelay, seatId: seat.id, kind: 'in', hold: 0
    };
    this.eventsOut.push({ type: 'sit', charId: c.id, seatId: seat.id });
  }

  /**
   * 起身。by 非空表示被他拽起来：平衡值只剩 yankBalance，直接变成被他扯住。
   * 座位在起身过渡走完之前仍算占着（避免两个人叠在同一张座垫上）。
   */
  private standUp(c: CharacterState, by: CharacterState | null) {
    if (c.seatId === null) return;
    const seat = this.seatById(c.seatId)!;
    const x = this.ix[c.id];
    const dur = by ? SEAT.yankStandDelay : SEAT.standDelay;
    c.seatId = null;
    c.status = 'idle';
    c.vel = V2();
    x.seatMove = {
      from: { ...c.pos }, to: this.pickExitPoint(c, seat, this.characters.filter((o) => o !== c)),
      t: 0, dur, seatId: seat.id, kind: 'out', hold: 0
    };
    this.eventsOut.push({ type: 'stand', charId: c.id });
    if (by) {
      c.balance = BALANCE.yankBalance;
      x.lastHurtAt = this.time;
      x.sitLockUntil = this.time + SEAT.lockAfterYank;
      x.heldFor = 0; // 过渡期间不计时：落地后 holdAutoBreak 秒自动挣脱
      c.lastHitBy = by.id;
      c.lastHitAt = this.time;
      this.eventsOut.push({ type: 'yank', byId: by.id, victimId: c.id });
      if (c.isPlayer) this.banner('你被拽起来了！快按"推"挣脱', 3, c.id);
    }
  }

  /**
   * 起身落脚点：接近点，或在它左右/前后各偏 0.45，挑离别人最远的（接近点优先）。
   */
  private pickExitPoint(c: { radius: number }, seat: Seat, others: { pos: Vec2 }[]): Vec2 {
    const base = this.approach[seat.id];
    let best = base;
    let bestGap = -Infinity;
    const offs: [number, number][] = [[0, 0], [0, 0.45], [0, -0.45], [0.45, 0], [-0.45, 0]];
    for (const [dx, dz] of offs) {
      const p = V2(base.x + dx, base.z + dz);
      if (!(dx === 0 && dz === 0) && (!standable(p, c.radius, -0.01) || !this.nav.isFree(p))) continue;
      let gap = Infinity;
      for (const o of others) gap = Math.min(gap, v2Dist(o.pos, p));
      for (const n of this.npcs) gap = Math.min(gap, v2Dist(n.pos, p));
      if (dx !== 0 || dz !== 0) gap -= 0.25;
      if (gap > bestGap) { bestGap = gap; best = p; }
    }
    return best;
  }

  /**
   * 推进坐下/起身过渡（角色和路人）。
   * 过渡中位置完全由插值决定：最远约 1.1 格 / 0.35 秒，smoothstep 峰值斜率 1.5 → 每帧 ≤ 0.08。
   */
  private advanceSeatMoves(dt: number) {
    for (const c of this.characters) {
      const x = this.ix[c.id];
      const mv = x.seatMove;
      if (!mv) continue;
      if (!c.alive) {
        x.seatMove = null;
        continue;
      }
      if (this.stepSeatMove(c, mv, dt, this.characters.filter((o) => o !== c && o.alive && o.seatId === null))) {
        x.seatMove = null;
        if (mv.kind === 'out') {
          const own = this.seatOwner.get(mv.seatId);
          if (own && own.kind === 'char' && own.id === c.id) this.seatOwner.delete(mv.seatId);
          x.settleUntil = this.time + SETTLE_TIME;
        }
      }
    }
    for (const n of this.npcs) {
      const nx = this.npcX.get(n.id)!;
      const mv = nx.seatMove;
      if (!mv) continue;
      if (this.stepSeatMove(n, mv, dt, [])) {
        nx.seatMove = null;
        if (mv.kind === 'out') {
          const own = this.seatOwner.get(mv.seatId);
          if (own && own.kind === 'npc' && own.id === n.id) this.seatOwner.delete(mv.seatId);
        }
      }
    }
  }

  /** 推进一段过渡，走完返回 true。 */
  private stepSeatMove(o: { pos: Vec2; vel: Vec2; facing: number; radius: number }, mv: SeatMove, dt: number,
    others: { pos: Vec2; radius: number }[]): boolean {
    mv.t = Math.min(mv.dur, mv.t + dt);
    const k = smoothstep(mv.dur > 0 ? mv.t / mv.dur : 1);
    o.pos = V2(mv.from.x + (mv.to.x - mv.from.x) * k, mv.from.z + (mv.to.z - mv.from.z) * k);
    o.vel = V2();
    const seat = this.seatById(mv.seatId);
    if (seat) {
      o.facing = mv.kind === 'in'
        ? angleLerp(o.facing, seat.facing, 0.25)
        : angleLerp(o.facing, angleOf(v2Sub(mv.to, mv.from)), 0.25);
    }
    if (mv.t < mv.dur) return false;
    // 起身走完了但落脚点还压着别人：原地再当一会儿"推不动的"，让对方先被挤开。
    if (mv.kind === 'out' && mv.hold < SEAT.exitHoldMax
      && others.some((p) => v2Dist(p.pos, o.pos) < p.radius + o.radius - 0.02)) {
      mv.hold += dt;
      return false;
    }
    return true;
  }

  /** 坐着的人钉在座位点上。 */
  private pinSeated() {
    for (const c of this.characters) {
      if (!c.alive || c.seatId === null || this.ix[c.id].seatMove) continue;
      const seat = this.seatById(c.seatId);
      if (!seat) continue;
      c.pos = V2(seat.x, seat.z);
      c.facing = seat.facing;
      c.vel = V2();
      c.status = 'sitting';
    }
  }

  // =====================================================================
  // 路人乘客
  // =====================================================================

  private doorInner(d: Door): Vec2 {
    return V2(this.layout.interior.maxX - 0.75, doorCenterZ(d));
  }

  /** 上客：在门外生成一个路人，往里走。门口被人堵着就晚一点再上。 */
  private spawnBoarder(d: Door): boolean {
    if (this.npcs.length >= NPC.max) return true; // 满员就当上完了
    const offs = [0, -0.4, 0.4];
    const p = V2(this.layout.interior.maxX + 0.7, doorCenterZ(d) + offs[this.boardSlot % offs.length]);
    const blocked = this.npcs.some((n) => v2Dist(n.pos, p) < 0.95)
      || this.characters.some((c) => c.alive && v2Dist(c.pos, p) < 0.9);
    if (blocked) return false;
    this.boardSlot++;
    const id = this.nextNpcId++;
    this.npcs.push({
      id, pos: p, vel: V2(), facing: -Math.PI / 2, radius: NPC.radius, status: 'boarding', seatId: null,
      look: Math.floor(this.rnd() * 1000)
    });
    this.npcX.set(id, { goalSeat: null, spot: null, door: d, seatMove: null });
    return true;
  }

  /** 下客：离开着的门最近的 1~3 个路人起身往门外走。 */
  private startAlight(d: Door) {
    const want = NPC.alight[0] + Math.floor(this.rnd() * (NPC.alight[1] - NPC.alight[0] + 1));
    const door = this.doorInner(d);
    const cands = this.npcs.filter((n) => n.status === 'riding' || n.status === 'sitting' || n.status === 'boarding')
      .sort((a, b) => v2Dist(a.pos, door) - v2Dist(b.pos, door))
      .slice(0, want);
    for (const n of cands) {
      const nx = this.npcX.get(n.id)!;
      if (n.status === 'sitting' && n.seatId !== null) {
        const seat = this.seatById(n.seatId)!;
        nx.seatMove = {
          from: { ...n.pos }, to: this.pickExitPoint(n, seat, this.characters.filter((c) => c.alive && c.seatId === null)),
          t: 0, dur: SEAT.standDelay, seatId: seat.id, kind: 'out', hold: 0
        };
        n.seatId = null;
      }
      n.status = 'leaving';
      nx.door = d;
      nx.goalSeat = null;
      nx.spot = null;
    }
    if (cands.length) this.eventsOut.push({ type: 'npcAlight', count: cands.length });
  }

  /** 关门时：还没出门的下车路人回到车厢里站着；还在门外的上车路人没赶上车。 */
  private closeDoorOnNpcs(d: Door | null) {
    const maxX = this.layout.interior.maxX;
    const keep = (n: NpcState): boolean => {
      if (n.status === 'leaving') {
        if (n.pos.x > maxX + 0.05) return false;
        n.status = 'riding';
        const nx = this.npcX.get(n.id)!;
        nx.spot = this.pickSpot(n);
        nx.door = null;
      }
      return !(n.status === 'boarding' && n.pos.x > maxX - 0.2 && d);
    };
    this.npcs = this.npcs.filter((n) => {
      if (keep(n)) return true;
      this.npcX.delete(n.id);
      return false;
    });
  }

  private pickSpot(n: NpcState): number | null {
    const used = new Set<number>();
    for (const o of this.npcs) {
      const s = this.npcX.get(o.id)?.spot;
      if (o !== n && s !== null && s !== undefined) used.add(s);
    }
    let best: number | null = null;
    let bd = Infinity;
    NPC_SPOTS.forEach((p, i) => {
      if (used.has(i)) return;
      const d = v2Dist(p, n.pos);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  private pickNpcSeat(n: NpcState): number | null {
    const targeted = new Set<number>();
    for (const o of this.npcs) {
      const g = this.npcX.get(o.id)?.goalSeat;
      if (o !== n && g !== null && g !== undefined) targeted.add(g);
    }
    let best: number | null = null;
    let bd = Infinity;
    for (const s of this.layout.seats) {
      if (!this.seatFree(s.id) || targeted.has(s.id)) continue;
      const d = v2Dist(this.approach[s.id], n.pos);
      if (d < bd) { bd = d; best = s.id; }
    }
    return best;
  }

  private updateNpcs(dt: number) {
    const I = this.layout.interior;
    const gone = new Set<number>();
    for (const n of this.npcs) {
      const nx = this.npcX.get(n.id)!;
      if (nx.seatMove || n.status === 'sitting') continue;
      let move = V2();
      let speed: number = NPC.walkSpeed;
      if (n.status === 'boarding') {
        if (n.pos.x > I.maxX - 0.7) {
          move = V2(-1, 0);
        } else {
          if (nx.goalSeat !== null && !this.seatFree(nx.goalSeat)) nx.goalSeat = null;
          if (nx.goalSeat === null && nx.spot === null) {
            nx.goalSeat = this.pickNpcSeat(n);
            if (nx.goalSeat === null) nx.spot = this.pickSpot(n);
          }
          if (nx.goalSeat !== null) {
            const seat = this.seatById(nx.goalSeat)!;
            if (distToRect(n.pos, seat.cushion) <= SEAT.reachEdge) {
              this.seatOwner.set(seat.id, { kind: 'npc', id: n.id });
              n.status = 'sitting';
              n.seatId = seat.id;
              nx.goalSeat = null;
              nx.seatMove = {
                from: { ...n.pos }, to: V2(seat.x, seat.z), t: 0, dur: SEAT.sitDelay, seatId: seat.id, kind: 'in', hold: 0
              };
              continue;
            }
            move = this.nav.steer(1000 + n.id, n.pos, this.approach[seat.id], this.time).dir;
          } else if (nx.spot !== null) {
            const spot = NPC_SPOTS[nx.spot];
            if (v2Dist(n.pos, spot) < 0.15) n.status = 'riding';
            else move = this.nav.steer(1000 + n.id, n.pos, spot, this.time).dir;
          } else {
            n.status = 'riding';
          }
        }
      } else if (n.status === 'riding') {
        if (nx.spot === null) nx.spot = this.pickSpot(n);
        if (nx.spot !== null) {
          const spot = NPC_SPOTS[nx.spot];
          if (v2Dist(n.pos, spot) > 0.4) {
            move = this.nav.steer(1000 + n.id, n.pos, spot, this.time).dir;
            speed = NPC.walkSpeed * 0.6;
          }
        }
      } else if (n.status === 'leaving' && nx.door) {
        const d = nx.door;
        const zc = doorCenterZ(d);
        if (n.pos.x > I.maxX - 1.0 && Math.abs(n.pos.z - zc) < 0.55) {
          move = V2(1, (zc - n.pos.z) * 0.5);
        } else {
          move = this.nav.steer(1000 + n.id, n.pos, this.doorInner(d), this.time).dir;
        }
        this.npcCarry(n, v2Norm(move), dt);
        if (n.pos.x > I.maxX + 1.0) gone.add(n.id);
      }
      if (v2Len(move) > 0.02) {
        const dir = v2Norm(move);
        n.pos = v2Add(n.pos, v2Scale(dir, speed * dt));
        n.facing = angleLerp(n.facing, angleOf(dir), 0.25);
      }
      this.integrate(n, dt);
    }
    if (gone.size) {
      this.npcs = this.npcs.filter((n) => !gone.has(n.id));
      for (const id of gone) this.npcX.delete(id);
    }
    // 站定的路人登记为寻路的临时障碍：机器人会绕开，而不是顶着路人原地踩。
    const rects: Rect[] = [];
    for (const n of this.npcs) {
      if (n.status !== 'riding') continue;
      const h = n.radius * 0.6;
      rects.push({ minX: n.pos.x - h, maxX: n.pos.x + h, minZ: n.pos.z - h, maxZ: n.pos.z + h });
    }
    this.nav.setDynamic(rects);
  }

  /**
   * 下车的路人快到门口时，把挡在前面的人往门外带（对方沿路人前进方向被带着走、慢慢失衡）。
   * 抓着扶手的人打折扣；坐着、被拖、在空中的不受影响。
   */
  private npcCarry(n: NpcState, dir: Vec2, dt: number) {
    if (!this.canAct() || v2Len(dir) < 0.5) return;
    const nx = this.npcX.get(n.id)!;
    if (!nx.door || v2Dist(n.pos, this.doorInner(nx.door)) > NPC.carryRange) return;
    for (const c of this.characters) {
      if (!c.alive || c.seatId !== null || this.ix[c.id].seatMove) continue;
      if (c.status === 'carried' || c.status === 'thrown') continue;
      const to = v2Sub(c.pos, n.pos);
      const d = v2Len(to);
      if (d > n.radius + c.radius + 0.08 || d < 1e-6 || dot(to, dir) / d < 0.3) continue;
      const mul = c.hold?.kind === 'rail' ? BALANCE.railEnvMul : 1;
      const along = dot(c.vel, dir);
      if (along < NPC.carrySpeed) c.vel = v2Add(c.vel, v2Scale(dir, (NPC.carrySpeed - along) * mul));
      if (c.status !== 'down') this.loseBalance(c, NPC.carryBalance * dt * mul, null);
    }
  }

  // =====================================================================
  // 碰撞
  // =====================================================================

  /** 静态碰撞矩形：墙（含关着的门）、站台围栏、座位、障碍物、填充体。openDoorGap=true 时不含门那一侧的车墙。 */
  private staticRects(skipNearWall = false): Rect[] {
    const rects: Rect[] = [];
    for (const w of baseWalls()) {
      if (skipNearWall && w.minX >= this.layout.interior.maxX - 1e-6) continue;
      rects.push(w);
    }
    for (const d of this.layout.doors) {
      if (!d.open) rects.push({ minX: 2.7, maxX: 3.0, minZ: d.zMin, maxZ: d.zMax });
    }
    rects.push(PLATFORM_FENCE);
    if (this.phase === 'boarding' || this.phase === 'ignition') rects.push(...boardingFence());
    for (const st of this.layout.seats) rects.push(st.backRect, st.cushion);
    for (const o of this.layout.obstacles) rects.push(o.rect);
    rects.push(...this.layout.fillers);
    return rects;
  }

  /**
   * 碰撞求解。
   *
   * 静态约束：墙、关着的门、站台围栏、靠背、座垫、障碍物、立杆。
   * 人与人（含路人）：路人比玩家重，重叠时路人只让出 NPC.pushShare；
   * 坐着的不参与；坐下/起身过渡中、被拖着的是"推不动的"一方；被扔在空中的另算（updateFlights）。
   * 每轮分离有上限（MAX_SEP_STEP），一次性叠进去的人几帧内散开而不是一帧弹开。
   * 最后再补两轮纯静态求解：人推人可能把某人顶进立杆/座垫，最终位置必须满足静态约束。
   */
  private resolveAllCollisions() {
    const rects = this.staticRects();
    const bodies: Body[] = [];
    const npcW = NPC.pushShare / (1 - NPC.pushShare);
    for (const c of this.characters) {
      if (!c.alive || c.seatId !== null || c.status === 'thrown') continue;
      const x = this.ix[c.id];
      bodies.push({ obj: c, r: c.radius, w: 1, kin: !!x.seatMove || c.status === 'carried', charId: c.id, npcId: -1 });
    }
    for (const n of this.npcs) {
      if (n.status === 'sitting' && !this.npcX.get(n.id)!.seatMove) continue;
      bodies.push({ obj: n, r: n.radius, w: npcW, kin: !!this.npcX.get(n.id)!.seatMove, charId: -1, npcId: n.id });
    }
    const resolveStatic = (b: Body) => {
      if (b.charId >= 0 && this.ix[b.charId].seatMove) return;
      if (b.npcId >= 0 && this.npcX.get(b.npcId)!.seatMove) return;
      const before = b.obj.pos;
      let p = before;
      for (const w of rects) p = resolveCircleRect(p, b.r, w);
      for (const h of this.layout.handrails) p = resolveCirclePole(p, b.r, h);
      b.obj.pos = p;
      // 撞上墙/座位/立杆：去掉速度里朝障碍物的分量（非弹性接触）。
      // 不去掉的话，惯性、好挤模式的侧倾会一直把人"按"在立杆上，自己怎么走都走不开。
      const dx = p.x - before.x;
      const dz = p.z - before.z;
      const d = Math.hypot(dx, dz);
      if (d > 1e-6) {
        const vn = (b.obj.vel.x * dx + b.obj.vel.z * dz) / d;
        if (vn < 0) b.obj.vel = V2(b.obj.vel.x - (dx / d) * vn, b.obj.vel.z - (dz / d) * vn);
      }
    };
    // 刚落地/刚起身的人：本帧最多被人推开 SETTLE_STEP。
    const budget = new Map<number, number>();
    for (const c of this.characters) {
      if (this.time < this.ix[c.id].settleUntil) budget.set(c.id, 0.06);
    }
    const shove = (b: Body, n: Vec2, amount: number) => {
      let mag = Math.abs(amount);
      if (b.charId >= 0) {
        const left = budget.get(b.charId);
        if (left !== undefined) {
          mag = Math.min(mag, Math.max(0, left));
          budget.set(b.charId, left - mag);
        }
      }
      b.obj.pos = v2Add(b.obj.pos, v2Scale(n, Math.sign(amount) * mag));
    };
    for (let iter = 0; iter < 3; iter++) {
      for (const b of bodies) resolveStatic(b);
      for (let i = 0; i < bodies.length; i++) {
        const a = bodies[i];
        for (let j = i + 1; j < bodies.length; j++) {
          const b = bodies[j];
          if (a.kin && b.kin) continue;
          // 拖人者和被拖的人不互相挤。
          if (a.charId >= 0 && b.charId >= 0) {
            const ca = this.characters[a.charId];
            const cb = this.characters[b.charId];
            if (ca.heldBy === cb.id || cb.heldBy === ca.id) {
              if (ca.status === 'carried' || cb.status === 'carried') continue;
            }
          }
          const d = v2Dist(a.obj.pos, b.obj.pos);
          const min = a.r + b.r;
          if (d >= min) continue;
          const n = d > 1e-6 ? v2Norm(v2Sub(a.obj.pos, b.obj.pos)) : V2(1, 0);
          const overlap = min - d;
          if (a.kin) {
            shove(b, n, -Math.min(overlap, MAX_SEP_STEP));
          } else if (b.kin) {
            shove(a, n, Math.min(overlap, MAX_SEP_STEP));
          } else {
            const sa = a.w / (a.w + b.w);
            shove(a, n, Math.min(overlap * sa, MAX_SEP_STEP));
            shove(b, n, -Math.min(overlap * (1 - sa), MAX_SEP_STEP));
          }
        }
      }
    }
    for (let k = 0; k < 2; k++) for (const b of bodies) resolveStatic(b);
  }

  /** 抓着扶手的人被推、被晃也甩不出 railLeash 这个圈。 */
  private applyRailLeash() {
    for (const c of this.characters) {
      if (!c.alive || c.hold?.kind !== 'rail') continue;
      const rail = this.layout.handrails[c.hold.id];
      const d = v2Dist(c.pos, rail);
      if (d <= BALANCE.railLeash) continue;
      const n = v2Norm(v2Sub(c.pos, rail));
      c.pos = v2Add(V2(rail.x, rail.z), v2Scale(n, BALANCE.railLeash));
      const out = dot(c.vel, n);
      if (out > 0) c.vel = v2Sub(c.vel, v2Scale(n, out));
    }
  }

  /** 过渡状态（坐下/起身/被拖/刚落地）的单帧位移不超过 KINEMATIC_STEP：多出来的留到下一帧。 */
  private capKinematicSteps() {
    for (const c of this.characters) {
      if (!c.alive) continue;
      const x = this.ix[c.id];
      const tagged = c.status === 'carried' || !!x.seatMove || (this.time < x.settleUntil && c.lastHitAt !== this.time);
      if (!tagged) continue;
      const step = v2Sub(c.pos, x.prevPos);
      const len = v2Len(step);
      if (len > KINEMATIC_STEP) c.pos = v2Add(x.prevPos, v2Scale(step, KINEMATIC_STEP / len));
    }
  }

  /**
   * 正对立杆移动时的切向滑移：碰撞只沿法线把人推回去，正对杆心走的人会永远顶在杆上。
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

  // =====================================================================
  // 淘汰与回合结束
  // =====================================================================

  private checkEliminations() {
    if (this.phase === 'boarding' || this.phase === 'ignition' || this.phase === 'ended' || this.arrived) return;
    const r = this.layout.interior;
    for (const c of this.characters) {
      if (!c.alive) continue;
      const out = c.pos.x < r.minX - FALL_GRACE || c.pos.x > r.maxX + FALL_GRACE
        || c.pos.z < r.minZ - FALL_GRACE || c.pos.z > r.maxZ + FALL_GRACE;
      if (out) this.eliminate(c);
    }
  }

  private eliminate(c: CharacterState) {
    if (!c.alive) return;
    const x = this.ix[c.id];
    let by: number | null = null;
    if (c.lastHitBy !== null && c.lastHitBy !== c.id && this.time - c.lastHitAt <= ATTRIBUTION_WINDOW) by = c.lastHitBy;
    const flying = c.status === 'thrown';
    this.dropHolds(c);
    if (x.seatMove) {
      const own = this.seatOwner.get(x.seatMove.seatId);
      if (own && own.kind === 'char' && own.id === c.id) this.seatOwner.delete(x.seatMove.seatId);
      x.seatMove = null;
    }
    if (c.seatId !== null) {
      this.seatOwner.delete(c.seatId);
      c.seatId = null;
    }
    c.alive = false;
    c.status = 'eliminated';
    c.balance = 0;
    if (!flying) {
      c.airT = 0;
      c.airDur = 0;
    }
    c.eliminatedOrder = ++this.elimCount;
    if (by !== null) this.characters[by].throwOuts++;
    this.eventsOut.push({ type: 'eliminate', charId: c.id, byId: by });
    const byName = by !== null ? this.characters[by].name : null;
    const how = flying ? '扔下了车' : '挤下了车';
    if (c.isPlayer) this.banner(byName ? `你被 ${byName} ${how}！` : '你掉下车了！', 3, c.id);
    else if (by !== null && this.characters[by].isPlayer) this.banner(`你把 ${c.name} ${how}！`, 3, by);
    else this.banner(byName ? `${c.name} 被 ${byName} ${how}！` : `${c.name} 掉下车了！`, 2, c.id);
    // 人一少机器人就会杀红眼（见 ai.ts 的 WILD_ALIVE），提前告诉玩家局势变了。
    const left = this.aliveCount();
    if (left === 3 || left === 2) this.banner(`车上只剩 ${left} 人了！`, 2);
  }

  aliveCount(): number {
    let n = 0;
    for (const c of this.characters) if (c.alive) n++;
    return n;
  }

  private updateRoundEnd(dt: number) {
    if (this.phase === 'ended') return;
    if ((this.phase === 'driving' || this.phase === 'finale') && !this.arrived && this.endDelay < 0
      && this.aliveCount() <= 1) {
      this.endDelay = BALANCE.earlyEndDelay;
      this.endedEarly = true;
    }
    if (this.endDelay >= 0) {
      this.endDelay -= dt;
      if (this.endDelay <= 0) this.finishRound();
    }
  }

  private finishRound() {
    this.phase = 'ended';
    this.endDelay = -1;
    let winners = this.characters.filter((c) => c.alive).map((c) => c.id);
    if (winners.length === 0) {
      // 全灭：最后下车的人赢。
      const last = Math.max(0, ...this.characters.map((c) => c.eliminatedOrder));
      winners = this.characters.filter((c) => c.eliminatedOrder === last && last > 0).map((c) => c.id);
    }
    const eliminated = this.characters.filter((c) => c.eliminatedOrder > 0)
      .sort((a, b) => a.eliminatedOrder - b.eliminatedOrder).map((c) => c.id);
    this.result = { winners, eliminated };
    this.eventsOut.push({ type: 'roundEnd', winners: winners.slice() });
    const names = winners.map((id) => (this.characters[id].isPlayer ? '你' : this.characters[id].name));
    if (this.endedEarly) this.banner(winners.length === 1 ? `${names[0]} 笑到了最后！` : '本车全灭！', 3);
    else this.banner(`到站！${names.length} 人撑到了终点`, 3);
  }

  /** 回合结果；回合没结束为 null。 */
  roundResult(): RoundResult | null {
    return this.result;
  }

  /** 本回合是否因为只剩 1 人（或全灭）提前结束。 */
  get endedByKnockout(): boolean {
    return this.endedEarly;
  }

  // =====================================================================
  // 供机器人 / 探针 / 界面查询
  // =====================================================================

  /** 当前开着的车门（到站开门或好挤模式）。 */
  openDoors(): Door[] {
    if (this.phase !== 'driving' && this.phase !== 'finale') return [];
    return this.layout.doors.filter((d) => d.open);
  }

  /** 正在进站刹车、马上要开的那扇门；没有为 null。 */
  get pendingDoor(): Door | null {
    return this.stop === 'braking' ? this.stopDoor : null;
  }

  /** 离下一次开门还有多久（进站刹车中为 0，已经开着为 0，终点前的最后一段按好挤模式算）。 */
  get timeToDoors(): number {
    if (this.stop !== 'none' || this.phase === 'finale') return 0;
    if (this.phase !== 'driving') return Infinity;
    const next = this.stationIdx < this.arrivals.length ? this.arrivals[this.stationIdx] : this.finaleAt;
    return Math.max(0, next - this.time);
  }

  /** 这个角色是否正在坐下/起身过渡。 */
  isSeatMoving(id: number): boolean {
    return !!this.ix[id]?.seatMove;
  }

  /** 这个角色现在抓不起来（刚挣脱、刚落地）。 */
  grabImmune(id: number): boolean {
    return this.time < (this.ix[id]?.grabImmuneUntil ?? 0);
  }

  /** "抓"这一按会做什么（不改状态）。 */
  grabPreview(id: number): GrabPreview {
    const c = this.characters[id];
    if (!c || !c.alive) return { kind: 'none', id: -1 };
    if (c.seatId !== null) return { kind: 'stand', id: c.seatId };
    if (c.hold) return { kind: 'release', id: c.hold.id };
    const ch = this.grabChoice(c, true);
    if (!ch) return { kind: 'none', id: -1 };
    if (ch.kind === 'seat') return { kind: 'seat', id: ch.seat.id };
    if (ch.kind === 'rail') return { kind: 'rail', id: ch.rail.id };
    return { kind: 'char', id: ch.target.id };
  }

  /**
   * 从 from 沿单位向量 dir 直线飞，会不会从开着的车门飞出去（飞行距离 throwSpeed × throwAir，
   * 中途不能撞到墙角、座位、立杆，和飞行碰撞同一口径）。
   */
  private throwPathExits(from: Vec2, dir: Vec2): boolean {
    if (dir.x < 0.2) return false;
    const I = this.layout.interior;
    const reach = BALANCE.throwSpeed * BALANCE.throwAir - 0.3;
    const s = (I.maxX - from.x) / dir.x;
    if (s < 0 || s > reach) return false;
    const zc = from.z + dir.z * s;
    const door = this.openDoors().find((d) => zc >= d.zMin + 0.1 && zc <= d.zMax - 0.1);
    if (!door) return false;
    const inDoorRects = this.staticRects(true);
    const outRects = this.staticRects(false);
    const steps = Math.ceil(s / 0.15);
    for (let k = 1; k <= steps; k++) {
      const p = V2(from.x + dir.x * s * (k / steps), from.z + dir.z * s * (k / steps));
      const rects = p.z >= door.zMin && p.z <= door.zMax ? inDoorRects : outRects;
      for (const w of rects) if (distToRect(p, w) < BALANCE.throwBodyRadius - 1e-6) return false;
      for (const h of this.layout.handrails) if (v2Dist(p, h) < BALANCE.throwBodyRadius + POLE_RADIUS) return false;
    }
    return true;
  }

  /** 现在按"扔"，手里拖着的人会不会从开着的车门飞出去。机器人和探针用它决定出手时机。 */
  throwWouldExit(id: number): boolean {
    const c = this.characters[id];
    if (!c || c.hold?.kind !== 'char') return false;
    const t = this.characters[c.hold.id];
    if (t.status !== 'carried') return false;
    return this.throwPathExits(t.pos, facingVec(c.facing));
  }

  /**
   * 拖着人时，朝哪个方向扔能从开着的门飞出去（瞄门洞中线和两侧各一点，挑第一条畅通的）；
   * 够不着或被挡住返回 null。机器人据此转身对准，不用非走到门正对面。
   */
  throwAim(id: number): Vec2 | null {
    const c = this.characters[id];
    if (!c || c.hold?.kind !== 'char') return null;
    const t = this.characters[c.hold.id];
    if (t.status !== 'carried') return null;
    const I = this.layout.interior;
    for (const d of this.openDoors()) {
      const zc = doorCenterZ(d);
      for (const dz of [0, -0.45, 0.45]) {
        const dir = v2Norm(V2(I.maxX + 0.3 - t.pos.x, zc + dz - t.pos.z));
        if (this.throwPathExits(t.pos, dir)) return dir;
      }
    }
    return null;
  }

  /** 探针用：本帧的移动输入。 */
  moveIntent(id: number): Vec2 {
    return this.ix[id]?.move ?? V2();
  }

  /**
   * 探针用：这个角色本帧的位移是否属于"过渡状态"（坐下/起身/被拖/刚落地），需要 ≤ 0.12。
   * 被人打中的那一帧除外（"被撞开的速度"）。
   */
  kinematicTag(id: number): 'seat' | 'carried' | 'settle' | null {
    const c = this.characters[id];
    const x = this.ix[id];
    if (!c || !x || !c.alive) return null;
    if (c.status === 'carried') return 'carried';
    if (x.seatMove) return 'seat';
    if (this.time < x.settleUntil && c.lastHitAt !== this.time) return 'settle';
    return null;
  }

  // =====================================================================
  // 快照
  // =====================================================================

  /**
   * 离玩家最近的空座。
   * 够不够得着和"抓"键坐下是同一个判定（到座垫边缘 ≤ SEAT.reachEdge）；
   * 够不着时按"接近点"（seatFrontPoint，被挡住时退到过道一侧，见 layout.seatApproachPoint）挑最近的，
   * 因为 0、1、5 号座的入口在过道一侧，按座垫中心挑会把人引到坐不上去的地方。
   */
  private seatGuideFor(c: CharacterState): SeatGuide | null {
    if (c.seatId !== null || this.ix[c.id].seatMove || !this.canAct()) return null;
    const reachable = this.canSit(c.id) ? this.nearestFreeSeat(c) : null;
    if (reachable) {
      return { id: reachable.id, x: reachable.x, z: reachable.z, dist: v2Dist(c.pos, reachable), inReach: true };
    }
    let best: Seat | null = null;
    let bestD = Infinity;
    for (const s of this.layout.seats) {
      if (!this.seatFree(s.id)) continue;
      const d = v2Dist(c.pos, this.approach[s.id]);
      if (d < bestD) { bestD = d; best = s; }
    }
    if (!best) return null;
    return { id: best.id, x: best.x, z: best.z, dist: v2Dist(c.pos, best), inReach: false };
  }

  private interactHintFor(c: CharacterState): Snapshot['interactHint'] {
    if (!c.alive || !this.canAct()) return 'none';
    const p = this.grabPreview(c.id);
    switch (p.kind) {
      case 'stand': return c.heldBy === null ? 'stand' : 'none';
      case 'release': return 'release';
      case 'seat': return 'sit';
      case 'char':
      case 'rail': return 'grab';
      default: return 'none';
    }
  }

  private stationLabel(): string {
    switch (this.phase) {
      case 'boarding': return '快上车';
      case 'ignition': return '发车中';
      case 'driving': {
        if (this.stop !== 'none') {
          return `${this.stationNames[this.stationIdx]} · ${STATION_TEXT[this.stopKind].label}`;
        }
        const next = this.stationIdx < this.stationNames.length ? this.stationNames[this.stationIdx] : TERMINAL_NAME;
        return '开往 ' + next;
      }
      case 'finale': return this.arrivePhase === 'none' ? `好挤模式 · 开往${TERMINAL_NAME}` : `终点站 · ${TERMINAL_NAME}`;
      default: return `终点站 · ${TERMINAL_NAME}`;
    }
  }

  snapshot(): Snapshot {
    const player = this.characters.find((c) => c.isPlayer) ?? this.characters[0];
    const seats: SeatInfo[] = this.layout.seats.map((s) => {
      const own = this.seatOwner.get(s.id);
      let occupant: SeatInfo['occupant'] = 'none';
      if (own) occupant = own.kind === 'npc' ? 'npc' : this.characters[own.id]?.isPlayer ? 'player' : 'bot';
      return { id: s.id, x: s.x, z: s.z, facing: s.facing, occupant };
    });
    let playerHold: Snapshot['playerHold'] = 'none';
    let playerHoldingDown = false;
    if (player?.hold) {
      playerHold = player.hold.kind;
      if (player.hold.kind === 'char') {
        const t = this.characters[player.hold.id];
        playerHoldingDown = !!t && (t.status === 'carried' || t.status === 'down');
      }
    }
    return {
      time: this.time,
      phase: this.phase,
      busSpeed: this.busSpeed,
      stationLabel: this.stationLabel(),
      boardTimer: this.phase === 'ignition' ? Math.max(0, this.ignitionTimer) : Math.max(0, this.boardTimer),
      roundTimeLeft: this.phase === 'ended' ? 0 : Math.max(0, this.finaleAt + BALANCE.finaleDuration - this.time),
      aliveCount: this.aliveCount(),
      playerAlive: !!player && player.alive,
      playerHold,
      playerHoldingDown,
      playerSeated: !!player && player.seatId !== null,
      playerBalance: player ? player.balance : 0,
      interactHint: player ? this.interactHintFor(player) : 'none',
      seats,
      seatGuide: player && player.alive ? this.seatGuideFor(player) : null,
      doorsOpen: this.openDoors().length > 0
    };
  }
}
