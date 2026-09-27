import { V2, v2Sub, v2Norm, v2Dist, v2Len, v2Add, v2Scale, type Vec2 } from '../core/math';
import { BALANCE } from '../config/balance';
import type { InputFrame, Button } from '../core/input';
import type { CharacterState, NpcState, Phase, ActiveEvent } from './types';
import { doorCenterZ, type BusLayout, type Door } from './layout';
import type { NavGrid } from './nav';

/** "抓"这一按会做什么（Simulation.grabPreview）。 */
export interface GrabPreview {
  kind: 'none' | 'stand' | 'release' | 'seat' | 'rail' | 'char';
  /** 座位 / 扶手 / 角色 id；none 为 -1。 */
  id: number;
}

/** 机器人能看到的规则层状态（Simulation 实现它）。 */
export interface BotView {
  readonly characters: readonly CharacterState[];
  readonly npcs: readonly NpcState[];
  readonly layout: BusLayout;
  readonly phase: Phase;
  readonly time: number;
  readonly event: ActiveEvent | null;
  readonly nav: NavGrid;
  readonly arrived: boolean;
  /** 正在进站刹车、马上要开的门。 */
  readonly pendingDoor: Door | null;
  /** 离下一次开门还有多久。 */
  readonly timeToDoors: number;
  openDoors(): Door[];
  seatFree(id: number): boolean;
  railFree(id: number, forId?: number): boolean;
  seatApproach(id: number): Vec2;
  canSit(id: number): boolean;
  isSeatMoving(id: number): boolean;
  grabImmune(id: number): boolean;
  grabPreview(id: number): GrabPreview;
  throwWouldExit(id: number): boolean;
  throwAim(id: number): Vec2 | null;
}

interface Mem {
  /** 进攻欲望 0.3~1：≥ HUNTER 的开门时会去门口找人下手，其余的开门时躲扶手/座位。 */
  aggr: number;
  /** 爱坐：没事就去抢座，没空座会去拽坐着的人。 */
  seatLover: boolean;
  /** 被扯住后多久按"推"挣脱。 */
  struggle: number;
  /** 坐着还愿意坐多久（到点起身找人打）。 */
  seatHold: number;
  /** 平时抓着扶手还愿意抓多久。 */
  railHold: number;
  /**
   * 当前正在打的人（-1 = 没在打）。每帧决策开始时清空、由"正在下手"的分支重新写入，
   * 所以它永远是新鲜的 —— 玩家的围攻名额（MAX_PLAYER_HUNTERS）按它算，不能被坐着/抓扶手的机器人白占。
   */
  preyId: number;
  /** 上一帧打的人（挑猎物时的"别换人"加成用它）。 */
  lastPrey: number;
  preyT: number;
  /** 推的节奏（别每冷却一好就推，给玩家喘息）。 */
  pushT: number;
  roam: Vec2 | null;
  roamT: number;
  /** 反卡死：想走但一直没挪动。 */
  lastPos: Vec2;
  stillT: number;
  /** 反卡死触发后，这段时间里放弃当前目标、随便走走。 */
  detourT: number;
  detour: Vec2 | null;
  /** 拽起别人后要抢的座位。 */
  yankSeat: number;
  /** 开门/机关的反应延迟（不是瞬间完美反应）。 */
  react: number;
}

const EMPTY = new Set<Button>();
const HELD_GRAB = new Set<Button>(['grab']);
const PRESS_GRAB = new Set<Button>(['grab']);
const PRESS_PUSH = new Set<Button>(['push']);
const PRESS_DASH = new Set<Button>(['dash']);
const NONE: InputFrame = { move: V2(), pressed: EMPTY, held: EMPTY };

/**
 * aggr（0.3~1 均匀分布）≥ 这个值的机器人，平时到站开门时去门口找人下手，约三分之一；
 * 其余的开门时躲到离门远的扶手/座位上。杀红了眼（见 WILD_*）时所有机器人都下手。
 * 由 probe 扫出来：0.65 时每回合淘汰 4.98 人（贴着 5 的上限），0.8 时提前结束只有 33%，0.75 两头余量最大。
 */
const HUNTER = 0.75;
/** 同一时刻最多几个机器人盯着玩家（要热闹，但别让玩家毫无还手之力）。 */
const MAX_PLAYER_HUNTERS = 2;
/**
 * 杀红了眼：车上只剩 WILD_ALIVE 个人以内，或者进入好挤模式那一刻只剩 WILD_FINALE_ALIVE 个以内
 * （即途中已经有人下车），所有机器人都变成猎手，离开扶手和座位去抢最后的位置。
 *
 * 没有这一条，人一少大家就各抱一根扶手、各坐一个座位熬到终点，"只剩 1 人提前结束"几乎不会发生
 * （探针实测 1%）。好挤模式按"开场那一刻"锁定而不是随时判断：这样回合是两种走向之一 ——
 * 途中没人下车就相对平稳地到站（好几个人一起赢），途中有人下车就一路杀到只剩一个。
 * 淘汰数因此是双峰分布，才能同时满足"平均淘汰 3~5 人"和"30%~60% 提前结束"。
 */
const WILD_ALIVE = 4;
/** 残局人数：这时候机器人冲撞不再挑时机、扶手上的人也照打不误。 */
const ENDGAME_ALIVE = 3;
const WILD_FINALE_ALIVE = 7;

/**
 * 上车后的站位：彼此 ≥ 1.0，离立杆 ≥ 0.6，离座位接近点 ≥ 1.0，不在门口正前方。
 */
const BOARD_SPOTS: Vec2[] = [
  V2(1.3, -2.9), V2(-1.3, -3.0), V2(0.8, -1.6), V2(-1.0, -1.9),
  V2(-0.9, -0.4), V2(0.9, 0.9), V2(-0.9, 1.9)
];

const frame = (move: Vec2, pressed: Set<Button> = EMPTY, held: Set<Button> = EMPTY): InputFrame =>
  ({ move, pressed, held });

const facingVec = (a: number): Vec2 => ({ x: Math.sin(a), z: Math.cos(a) });

/** 朝向与目标方向的夹角余弦。 */
function aimCos(c: CharacterState, target: Vec2): number {
  const to = v2Sub(target, c.pos);
  const d = v2Len(to);
  if (d < 1e-6) return 1;
  const f = facingVec(c.facing);
  return (to.x * f.x + to.z * f.z) / d;
}

/** 拖人去门口时的站位：门洞正对面、立杆外侧（0、4 号立杆正好挡在两扇门的中线上，从杆后面扔会砸到杆）。 */
export function carryStage(door: Door, v: BotView): Vec2 {
  return V2(v.layout.interior.maxX - 1.5, doorCenterZ(door));
}

/**
 * 拖着人去门口：先走到 carryStage（返回 null 表示调用方用寻路走过去），
 * 到了就朝门外迈步，把身子和手里的人一起转向门，对准了由调用方按"扔"。门还没开时到了就等着。
 */
export function carryToDoor(c: CharacterState, door: Door, v: BotView, open: boolean): Vec2 | null {
  // 已经有一条畅通的扔出线：原地转身对准（慢慢挪着转，手里的人跟着甩过去）。
  const aim = open ? v.throwAim(c.id) : null;
  if (aim) return v2Scale(aim, 0.3);
  const I = v.layout.interior;
  const zc = doorCenterZ(door);
  const stage = carryStage(door, v);
  const atStage = v2Dist(c.pos, stage) < 0.6 || (c.pos.x > stage.x - 0.2 && Math.abs(c.pos.z - zc) < 0.9);
  if (!atStage) return null;
  if (!open) return V2();
  return v2Scale(v2Norm(v2Sub(V2(I.maxX + 1.5, zc), c.pos)), 0.6);
}

/**
 * 机器人。每个 Simulation 一个实例，记忆随回合重建（不再是模块级全局状态，
 * 同时跑多个模拟、按回合新建模拟都不会串数据）。
 */
export class BotBrain {
  private mem = new Map<number, Mem>();
  /** 本帧是否"杀红了眼"（见 WILD_ALIVE）。 */
  private wild = false;
  /** 进入好挤模式那一刻车上还剩几人（-1 = 还没到）。 */
  private finaleAlive = -1;
  /** 残局：只剩 ENDGAME_ALIVE 人以内，谁也不躲，死盯一个打到底。 */
  private endgame = false;

  constructor(private rnd: () => number) {}

  private m(c: CharacterState): Mem {
    let m = this.mem.get(c.id);
    if (!m) {
      const r = this.rnd;
      m = {
        aggr: 0.3 + r() * 0.7,
        seatLover: r() < 0.4,
        struggle: 0.3 + r() * 0.4,
        seatHold: 8 + r() * 14,
        railHold: 2 + r() * 4,
        preyId: -1,
        lastPrey: -1,
        preyT: 0,
        pushT: r(),
        roam: null,
        roamT: 0,
        lastPos: { ...c.pos },
        stillT: 0,
        detourT: 0,
        detour: null,
        yankSeat: -1,
        react: 0.2 + r() * 0.5
      };
      this.mem.set(c.id, m);
    }
    return m;
  }

  /** 单个机器人的决策：返回本帧输入。 */
  decide(c: CharacterState, v: BotView, dt: number): InputFrame {
    const m = this.m(c);
    m.pushT -= dt;
    m.preyT += dt;
    m.roamT -= dt;
    m.detourT -= dt;
    if (!c.alive || c.status === 'down' || c.status === 'carried' || c.status === 'thrown') {
      m.preyId = -1;
      return NONE;
    }
    if (v.isSeatMoving(c.id)) return NONE;
    let alive = 0;
    for (const o of v.characters) if (o.alive) alive++;
    this.endgame = alive <= ENDGAME_ALIVE;
    if (v.phase === 'finale' && this.finaleAlive < 0) this.finaleAlive = alive;
    this.wild = alive <= WILD_ALIVE || (v.phase === 'finale' && this.finaleAlive <= WILD_FINALE_ALIVE);
    const out = this.decideInner(c, v, m, dt);
    this.trackStuck(c, v, m, out, dt);
    return out;
  }

  private decideInner(c: CharacterState, v: BotView, m: Mem, dt: number): InputFrame {
    if (m.preyId >= 0) m.lastPrey = m.preyId;
    m.preyId = c.hold?.kind === 'char' ? c.hold.id : -1;
    if (v.phase === 'boarding' || v.phase === 'ignition') return this.board(c, v, m);

    // 1) 被人扯住：反应一下就按"推"挣脱。
    if (c.heldBy !== null && c.seatId === null) {
      m.struggle -= dt;
      if (m.struggle <= 0) {
        m.struggle = 0.25 + this.rnd() * 0.45;
        return frame(V2(), PRESS_PUSH);
      }
      return NONE;
    }
    m.struggle = Math.min(m.struggle, 0.25 + this.rnd() * 0.45);

    // 2) 坐着。
    if (c.seatId !== null) return this.sitting(c, v, m, dt);

    // 3) 手里抓着人。
    if (c.hold?.kind === 'char') return this.holding(c, v, m);

    const doors = v.openDoors();
    const hazard = v.event;

    // 4) 机关预警 / 生效中：抓扶手（或坐下）。
    if (hazard) {
      if (c.hold?.kind === 'rail') return frame(V2(), EMPTY, HELD_GRAB);
      const g = this.braceFor(c, v, 2.4);
      if (g) return g;
    }

    // 5) 抓着扶手。
    if (c.hold?.kind === 'rail') return this.onRail(c, v, m, doors, dt);

    // 6) 门开着（或马上要开）：猎手去门口找人下手，其余的躲。
    const huntDoors = doors.length ? doors : v.pendingDoor ? [v.pendingDoor] : [];
    if (huntDoors.length) {
      if (m.aggr >= HUNTER || this.wild) {
        const f = this.hunt(c, v, m, huntDoors);
        if (f) return f;
      } else {
        m.preyId = -1;
      }
      return this.hide(c, v, huntDoors);
    }
    m.preyId = -1;

    // 7) 门关着：找座 / 拽座 / 抓扶手 / 闲逛，顺手推人。
    return this.cruise(c, v, m);
  }

  // ---------------- 各种情形 ----------------

  private board(c: CharacterState, v: BotView, m: Mem): InputFrame {
    // 站台上直走到门口；进了车厢，爱坐的直接去抢座，其余的去各自的站位。
    if (c.pos.x > 2.6) return frame(v2Norm(v2Sub(V2(1.8, -4.3), c.pos)));
    if (m.seatLover) {
      const s = this.seatPlan(c, v);
      if (s) return s;
    }
    const spot = BOARD_SPOTS[(c.id - 1 + BOARD_SPOTS.length) % BOARD_SPOTS.length];
    if (v2Dist(c.pos, spot) < 0.5) return NONE;
    return frame(this.go(c, v, spot));
  }

  private sitting(c: CharacterState, v: BotView, m: Mem, dt: number): InputFrame {
    m.seatHold -= dt;
    if (c.heldBy !== null) return NONE; // 被拽着起不来
    // 坐够了起身；猎手在开门时看到附近有躺着的人也会起身。
    let wantUp = m.seatHold <= 0;
    // 杀红了眼：门开着就起身去抢最后的位置（不然最后两个人各坐一个座位熬到终点）。
    if (this.wild && v.openDoors().length && m.react <= 0) wantUp = true;
    m.react = this.wild && v.openDoors().length ? m.react - dt : 0.2 + this.rnd() * 0.6;
    if (!wantUp && m.aggr > 0.75 && v.openDoors().length) {
      wantUp = v.characters.some((o) => o.alive && o.id !== c.id && o.status === 'down'
        && v2Dist(o.pos, c.pos) < 3 && !v.grabImmune(o.id));
    }
    if (wantUp) {
      m.seatHold = 8 + this.rnd() * 14;
      return frame(V2(), PRESS_GRAB);
    }
    return NONE;
  }

  /** 抓着人：拖着摔倒的人去门口扔；拽座时稳住；扯住站着的人就强推。 */
  private holding(c: CharacterState, v: BotView, m: Mem): InputFrame {
    const t = v.characters[c.hold!.id];
    if (t.status === 'carried') {
      if (v.throwWouldExit(c.id)) return frame(V2(), PRESS_PUSH, HELD_GRAB);
      const doors = v.openDoors();
      const cands = doors.length ? doors : v.pendingDoor ? [v.pendingDoor] : [];
      const door = this.nearestDoor(c.pos, cands, v);
      if (door) {
        const plan = carryToDoor(c, door, v, doors.length > 0);
        return frame(plan ?? this.go(c, v, carryStage(door, v)), EMPTY, HELD_GRAB);
      }
      // 没门可扔：前面有人就砸过去，快挣脱了也扔出去（落地再瘫一会儿）。
      const f = facingVec(c.facing);
      const inFront = v.characters.some((o) => o.alive && o.id !== c.id && o.id !== t.id && o.seatId === null
        && o.status !== 'thrown' && (() => {
          const to = v2Sub(o.pos, t.pos);
          const d = v2Len(to);
          return d < 3 && d > 0.3 && (to.x * f.x + to.z * f.z) / d > 0.85;
        })());
      if (inFront || t.downTimer <= 0) return frame(V2(), PRESS_PUSH, HELD_GRAB);
      return frame(V2(), EMPTY, HELD_GRAB);
    }
    if (t.seatId !== null || v.isSeatMoving(t.id)) {
      // 拽座：对着他、别松手。
      return frame(v2Scale(v2Norm(v2Sub(t.pos, c.pos)), 0.05), EMPTY, HELD_GRAB);
    }
    // 扯住站着的人。门关着时爱坐的拽起人来是为了抢座：松手，座位一空就坐上去。
    if (m.yankSeat >= 0 && v.openDoors().length === 0) {
      m.yankSeat = -1;
      return NONE;
    }
    m.yankSeat = -1;
    if (aimCos(c, t.pos) > 0.6 && c.pushCd <= 0) return frame(V2(), PRESS_PUSH, HELD_GRAB);
    return frame(v2Scale(v2Norm(v2Sub(t.pos, c.pos)), 0.3), EMPTY, HELD_GRAB);
  }

  /** 抓着扶手：什么时候继续抓、什么时候松手；抓着也能推身边的人。 */
  private onRail(c: CharacterState, v: BotView, m: Mem, doors: Door[], dt: number): InputFrame {
    m.railHold -= dt;
    const danger = doors.length > 0 || v.pendingDoor !== null || v.event !== null || v.timeToDoors < 1.5;
    const hunter = m.aggr >= HUNTER || this.wild;
    // 开门时：身边有人正好在门和我之间，推他一把（抓着扶手也能推）。
    if (doors.length && c.pushCd <= 0 && m.pushT <= 0) {
      const t = this.pushable(c, v, doors);
      if (t) {
        m.pushT = 0.3 + this.rnd() * 0.5;
        if (aimCos(c, t.pos) > 0.7) return frame(V2(), PRESS_PUSH, HELD_GRAB);
        return frame(v2Scale(v2Norm(v2Sub(t.pos, c.pos)), 0.15), EMPTY, HELD_GRAB);
      }
    }
    // 猎手：门开着、附近有能下手的，就松手去打。
    if (hunter && doors.length && v.event === null) {
      const prey = this.pickPrey(c, v, m, doors);
      if (prey && v2Dist(prey.pos, c.pos) < 4.5
        && (prey.status === 'down' || prey.balance < 0.75 || prey.seatId !== null || this.wild)) return NONE;
    }
    if (danger || m.railHold > 0) return frame(V2(), EMPTY, HELD_GRAB);
    m.railHold = 2 + this.rnd() * 5;
    return NONE; // 松手
  }

  /** 门口找人下手。没有合适的猎物返回 null。 */
  private hunt(c: CharacterState, v: BotView, m: Mem, doors: Door[]): InputFrame | null {
    const prey = this.pickPrey(c, v, m, doors);
    if (!prey) {
      m.preyId = -1;
      return null;
    }
    if (prey.id !== m.lastPrey) m.preyT = 0;
    m.preyId = prey.id;
    const d = v2Dist(prey.pos, c.pos);
    const pv = v.grabPreview(c.id);
    // 摔倒的：抓起来。
    if (prey.status === 'down') {
      if (pv.kind === 'char' && pv.id === prey.id) return frame(V2(), PRESS_GRAB, HELD_GRAB);
      if (d < c.radius + prey.radius + 0.5) return frame(v2Scale(v2Norm(v2Sub(prey.pos, c.pos)), 0.2));
      return frame(this.go(c, v, prey.pos));
    }
    // 坐着的：走到他座位跟前，抓住不放拽起来。
    if (prey.seatId !== null) {
      if (pv.kind === 'char' && pv.id === prey.id) return frame(V2(), PRESS_GRAB, HELD_GRAB);
      const ap = v.seatApproach(prey.seatId);
      if (v2Dist(c.pos, ap) > 0.35) return frame(this.go(c, v, ap));
      return frame(v2Scale(v2Norm(v2Sub(prey.pos, c.pos)), 0.2));
    }
    // 站着的：离门近、没抓扶手 → 绕到他靠车厢内侧的一边往门外推；
    // 抓着扶手或离门远 → 推哪边都行，先把他推晕（平衡快没了就抓住强推，推倒直接拖走）。
    const door = this.nearestDoor(prey.pos, doors, v)!;
    const exit = V2(v.layout.interior.maxX + 1, doorCenterZ(door));
    const out = v2Norm(v2Sub(exit, prey.pos));
    const ringOut = prey.hold?.kind !== 'rail' && v2Dist(prey.pos, this.doorInner(door, v)) < 2.6;
    const gap = c.radius + prey.radius + 0.12;
    const spot = ringOut ? V2(prey.pos.x - out.x * gap, prey.pos.z - out.z * gap) : prey.pos;
    const toPrey = v2Norm(v2Sub(prey.pos, c.pos));
    const lined = !ringOut || (d > 1e-3 && toPrey.x * out.x + toPrey.z * out.z > 0.45);
    const reach = c.radius + prey.radius + BALANCE.pushReach;
    if (lined && d <= reach) {
      if (aimCos(c, prey.pos) < 0.8) return frame(v2Scale(toPrey, 0.15));
      if (m.pushT > 0) return NONE;
      const strongKills = prey.balance <= BALANCE.pushBalance * BALANCE.strongPushMul * (prey.hold?.kind === 'rail' ? 0.5 : 1);
      if (strongKills && pv.kind === 'char' && pv.id === prey.id && prey.heldBy === null) {
        m.pushT = 0.1;
        return frame(V2(), PRESS_GRAB, HELD_GRAB);
      }
      if (c.pushCd <= 0) {
        m.pushT = 0.05 + this.rnd() * 0.2;
        return frame(V2(), PRESS_PUSH);
      }
      return NONE;
    }
    // 远一点、对得准：冲过去撞一下。
    if (lined && d < 2.6 && d > reach && c.dashCd <= 0 && aimCos(c, prey.pos) > 0.9 && (m.aggr > 0.7 || this.endgame)) {
      return frame(toPrey, PRESS_DASH);
    }
    return frame(this.go(c, v, spot));
  }

  /** 开门时不想打的：去离门远的扶手或空座。 */
  private hide(c: CharacterState, v: BotView, doors: Door[]): InputFrame {
    const s = this.seatPlan(c, v, 4);
    if (s) return s;
    const g = this.braceFor(c, v, 8, doors);
    if (g) return g;
    // 没地方抓：往远离门的那侧挪。
    const away = V2(-1.3, Math.max(-2.5, Math.min(2.5, c.pos.z)));
    if (v2Dist(c.pos, away) < 0.6) return NONE;
    return frame(this.go(c, v, away));
  }

  /** 门关着的时候。 */
  private cruise(c: CharacterState, v: BotView, m: Mem): InputFrame {
    if (m.seatLover) {
      const s = this.seatPlan(c, v);
      if (s) return s;
      // 没空座：去拽一个坐着的人（不拽路人）。
      if (m.aggr > 0.45) {
        let victim: CharacterState | null = null;
        let vd = 7;
        for (const o of v.characters) {
          if (!o.alive || o.id === c.id || o.seatId === null || o.heldBy !== null) continue;
          if (o.isPlayer && this.playerHunters(c.id) >= MAX_PLAYER_HUNTERS) continue;
          const d = v2Dist(o.pos, c.pos);
          if (d < vd) { vd = d; victim = o; }
        }
        if (victim) {
          const pv = v.grabPreview(c.id);
          if (pv.kind === 'char' && pv.id === victim.id) {
            m.yankSeat = victim.seatId!;
            return frame(V2(), PRESS_GRAB, HELD_GRAB);
          }
          m.preyId = victim.id;
          const ap = v.seatApproach(victim.seatId!);
          if (v2Dist(c.pos, ap) > 0.35) return frame(this.go(c, v, ap));
          return frame(v2Scale(v2Norm(v2Sub(victim.pos, c.pos)), 0.2));
        }
      }
    }
    // 快到站了：猎手往车厢中部靠，其余的去抓扶手。
    if (v.timeToDoors < 2.5) {
      if (m.aggr < HUNTER) {
        const g = this.braceFor(c, v, 6);
        if (g) return g;
      }
    }
    // 顺手推一把身边的人（先把他推晕，开门时好下手）。
    if (m.aggr > 0.55 && c.pushCd <= 0 && m.pushT <= 0) {
      m.pushT = 1.0 + this.rnd() * 1.6;
      const near = v.characters.find((o) => o.alive && o.id !== c.id && o.seatId === null && o.status !== 'thrown'
        && o.status !== 'carried' && v2Dist(o.pos, c.pos) < c.radius + o.radius + BALANCE.pushReach
        && !(o.isPlayer && this.playerHunters(c.id) >= MAX_PLAYER_HUNTERS));
      if (near && this.rnd() < 0.6) {
        if (aimCos(c, near.pos) > 0.6) return frame(V2(), PRESS_PUSH);
        return frame(v2Scale(v2Norm(v2Sub(near.pos, c.pos)), 0.2));
      }
    }
    // 平时：有一半时间去抓个扶手站着，其余时间闲逛。
    if (m.railHold > 0 && m.aggr < 0.8) {
      const g = this.braceFor(c, v, 5);
      if (g) return g;
    }
    if (!m.roam || m.roamT <= 0 || v2Dist(c.pos, m.roam) < 0.5) {
      m.roam = this.randomSpot(v);
      m.roamT = 2 + this.rnd() * 3;
    }
    const dir = this.go(c, v, m.roam);
    if (v2Len(dir) < 0.05) {
      m.roam = this.randomSpot(v);
      return frame(this.go(c, v, m.roam));
    }
    return frame(v2Scale(dir, 0.6));
  }

  // ---------------- 小工具 ----------------

  /** 去一个空座坐下（maxDist 以内），按"抓"的时机和模拟同一口径。没有返回 null。 */
  private seatPlan(c: CharacterState, v: BotView, maxDist = 7): InputFrame | null {
    if (v.canSit(c.id)) {
      const pv = v.grabPreview(c.id);
      if (pv.kind === 'seat') return frame(V2(), PRESS_GRAB);
    }
    let best = -1;
    let bd = maxDist;
    for (const s of v.layout.seats) {
      if (!v.seatFree(s.id)) continue;
      const ap = v.seatApproach(s.id);
      // 接近点已经站着别人（且不是我）：去了也只能顶着，换一个。
      if (v.characters.some((o) => o.id !== c.id && o.alive && o.seatId === null && v2Dist(o.pos, ap) < 0.5)) continue;
      if (v.npcs.some((n) => v2Dist(n.pos, ap) < 0.6)) continue;
      const d = v2Dist(c.pos, ap);
      if (d < bd) { bd = d; best = s.id; }
    }
    if (best < 0) return null;
    const ap = v.seatApproach(best);
    if (v2Dist(c.pos, ap) < 0.2) {
      const seat = v.layout.seats[best];
      return frame(v2Scale(v2Norm(v2Sub(V2(seat.x, seat.z), c.pos)), 0.3));
    }
    return frame(this.go(c, v, ap));
  }

  /**
   * 找扶手抓稳（机关、开门时）：够得着就按"抓"（预览必须是扶手或座位，别抓成人），
   * 否则走过去。avoid 给出时优先挑离这些门远的扶手。
   */
  private braceFor(c: CharacterState, v: BotView, maxDist: number, avoid: Door[] = []): InputFrame | null {
    const pv = v.grabPreview(c.id);
    if (pv.kind === 'rail' || pv.kind === 'seat') {
      if (avoid.length === 0 || pv.kind === 'seat' || this.doorDist(v.layout.handrails[pv.id], avoid, v) > 2.2) {
        return frame(V2(), PRESS_GRAB, HELD_GRAB);
      }
    }
    let best: Vec2 | null = null;
    let bs = Infinity;
    for (const h of v.layout.handrails) {
      if (!v.railFree(h.id, c.id)) continue;
      const d = v2Dist(c.pos, h);
      if (d > maxDist) continue;
      const dd = avoid.length ? this.doorDist(h, avoid, v) : 9;
      if (avoid.length && dd < 2.2) continue;
      const score = d - Math.min(dd, 4) * 0.4;
      if (score < bs) { bs = score; best = V2(h.x, h.z); }
    }
    if (!best) return null;
    if (v2Dist(c.pos, best) < BALANCE.railReach * 0.85) {
      // 够得着但预览不是扶手（前面有人/有座位优先）：侧身挪一下再抓。
      return frame(v2Scale(v2Norm(v2Sub(best, c.pos)), 0.2), EMPTY, EMPTY);
    }
    return frame(this.go(c, v, best));
  }

  /** 开门时身边能往门外推的人（我在他内侧、推的方向朝门）。 */
  private pushable(c: CharacterState, v: BotView, doors: Door[]): CharacterState | null {
    for (const o of v.characters) {
      if (!o.alive || o.id === c.id || o.seatId !== null || o.status === 'thrown' || o.status === 'carried') continue;
      if (o.isPlayer && this.playerHunters(c.id) >= MAX_PLAYER_HUNTERS && this.m(c).lastPrey !== o.id) continue;
      const d = v2Dist(o.pos, c.pos);
      if (d > c.radius + o.radius + BALANCE.pushReach) continue;
      const door = this.nearestDoor(o.pos, doors, v)!;
      if (v2Dist(o.pos, this.doorInner(door, v)) > 2.6) continue;
      const out = v2Norm(v2Sub(V2(v.layout.interior.maxX + 1, doorCenterZ(door)), o.pos));
      const to = v2Norm(v2Sub(o.pos, c.pos));
      if (to.x * out.x + to.z * out.z > 0.4) return o;
    }
    return null;
  }

  /** 挑猎物：躺着的 > 门口站着的（平衡越低越好）> 门口附近坐着的（拽起来）。 */
  private pickPrey(c: CharacterState, v: BotView, m: Mem, doors: Door[]): CharacterState | null {
    let best: CharacterState | null = null;
    let bs = 0;
    const hunters = this.playerHunters(c.id);
    for (const o of v.characters) {
      if (!o.alive || o.id === c.id || o.status === 'thrown' || o.status === 'carried') continue;
      if (v.isSeatMoving(o.id)) continue;
      if (o.heldBy !== null) continue;
      if (o.isPlayer && hunters >= MAX_PLAYER_HUNTERS && m.lastPrey !== o.id) continue;
      const d = v2Dist(o.pos, c.pos);
      if (d > (this.wild ? 14 : 7)) continue;
      const door = this.nearestDoor(o.pos, doors, v)!;
      const dd = v2Dist(o.pos, this.doorInner(door, v));
      let s: number;
      if (o.status === 'down') {
        if (v.grabImmune(o.id)) continue;
        s = 12 - dd * 1.1 - d * 0.8;
      } else if (o.seatId !== null) {
        s = (dd < 4.5 || this.wild ? 5.5 : 1.5) - dd * 0.5 - d * 0.5;
      } else {
        const railPenalty = this.endgame ? 0 : this.wild ? 0.8 : 2.5;
        s = 7 - dd * 1.2 - d * 0.5 + (1 - o.balance) * 4 - (o.hold?.kind === 'rail' ? railPenalty : 0);
      }
      if (o.id === m.lastPrey) s += 2.5; // 盯住一个，别左右横跳
      // 围攻：已经有别的机器人在打他，一起上（抓扶手的人一个人推不倒）。
      for (const [id, mm] of this.mem) if (id !== c.id && mm.preyId === o.id) s += 1.0;
      if (s > bs) { bs = s; best = o; }
    }
    return best;
  }

  /** 此刻盯着玩家的机器人数（不含自己）。 */
  private playerHunters(selfId: number): number {
    let n = 0;
    for (const [id, mm] of this.mem) if (id !== selfId && mm.preyId === 0) n++;
    return n;
  }

  private doorInner(d: Door, v: BotView): Vec2 {
    return V2(v.layout.interior.maxX - 0.75, doorCenterZ(d));
  }

  private doorDist(p: Vec2, doors: Door[], v: BotView): number {
    let best = Infinity;
    for (const d of doors) best = Math.min(best, v2Dist(p, this.doorInner(d, v)));
    return best;
  }

  private nearestDoor(p: Vec2, doors: Door[], v: BotView): Door | null {
    let best: Door | null = null;
    let bd = Infinity;
    for (const d of doors) {
      const x = v2Dist(p, this.doorInner(d, v));
      if (x < bd) { bd = x; best = d; }
    }
    return best;
  }

  private randomSpot(v: BotView): Vec2 {
    const r = v.layout.interior;
    for (let i = 0; i < 8; i++) {
      const p = V2(r.minX + 1.0 + this.rnd() * (r.maxX - r.minX - 2.2), r.minZ + 1.5 + this.rnd() * (r.maxZ - r.minZ - 3));
      if (v.nav.isFree(p)) return p;
    }
    return V2(0.8, -1.0);
  }

  /** 去某个点：交给寻路（绕立杆/座垫/障碍物/站着的路人）。反卡死期间先绕一下。 */
  private go(c: CharacterState, v: BotView, target: Vec2): Vec2 {
    const m = this.m(c);
    if (m.detourT > 0 && m.detour) {
      const dir = v.nav.steer(c.id, c.pos, m.detour, v.time).dir;
      if (v2Len(dir) > 0.05) return dir;
    }
    return v.nav.steer(c.id, c.pos, target, v.time).dir;
  }

  /**
   * 反卡死：想走（输入 > 0.5）却 1 秒内没离开起点 0.25，就换一个临时目标绕一下、放下当前猎物。
   * 按"离开起点多远"算而不是逐帧比较：贴着立杆来回蹭的人每帧都在动，但一直没走出去。
   */
  private trackStuck(c: CharacterState, v: BotView, m: Mem, f: InputFrame, dt: number) {
    const moved = v2Dist(c.pos, m.lastPos);
    if (v2Len(f.move) < 0.5 || moved > 0.25) {
      m.stillT = 0;
      m.lastPos = { ...c.pos };
      return;
    }
    m.stillT += dt;
    if (m.stillT > 1.0) {
      m.stillT = 0;
      m.lastPos = { ...c.pos };
      m.preyId = -1;
      m.lastPrey = -1;
      m.roam = null;
      m.detourT = 0.8;
      // 往身后/侧面随便一个空地绕一下。
      const back = v2Add(c.pos, v2Scale(v2Norm(V2(this.rnd() - 0.5, this.rnd() - 0.5)), 1.5));
      m.detour = v.nav.isFree(back) ? back : this.randomSpot(v);
    }
  }
}
