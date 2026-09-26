import { V2, v2Sub, v2Norm, v2Dist, v2Len, type Vec2 } from '../core/math';
import { BALANCE } from '../config/balance';
import type { InputFrame, Button } from '../core/input';
import type { CharacterState, Phase, ActiveEvent } from './types';
import { distToRect, seatFrontPoint, type BusLayout, type Seat } from './layout';
import type { HotZone } from './hotzone';
import type { NavGrid } from './nav';
import { SEAT } from '../config/balance';

export interface BotContext {
  characters: CharacterState[];
  phase: Phase;
  event: ActiveEvent | null;
  layout: BusLayout;
  time: number;
  crowd: number;
  /** 座位是否空着。座位是主要产出源，AI 不会抢就等于把分白送给玩家。 */
  seatFree: (id: number) => boolean;
  /** 扶手是否空着：以前 bot 只认最近的扶手，被占了也跑过去按，原地"抓空"。 */
  railFree: (id: number) => boolean;
  /** 按技能现在能不能放出来（冷却 + 阿远身前放不放得下箱子）。别往墙上扔箱子。 */
  canUseSkill: (id: number) => boolean;
  hotZone: HotZone;
  /** 静态寻路：绕开立杆、座垫、障碍物。 */
  nav: NavGrid;
}

interface BotMemory {
  target: Vec2 | null;
  timer: number;
  grabTimer: number;
  pushTimer: number;
  skillTimer: number;
  /** 进入危险区后的反应延迟：机器人不能瞬间做出完美闪避，否则一局下不了车。 */
  panic: number;
  /**
   * 还能在座位上赖多久。
   * 没有它，7 个机器人会把 4 个座位从头垄断到尾，玩家整局抢不到一个 ——
   * probe 里玩家所有策略的名次都卡在 6.3~7.2 就是这么来的。
   * 现实里乘客也会到站起身，这条既解决平衡又符合题材。
   */
  seatHold: number;
  /**
   * 从对局第几秒起才开始找座位（含拽人）。
   *
   * 以前 7 个 bot 一关门就同时扑向 4 个座位，玩家实测 3 局 2 局发车时座位全满，
   * "抢座"对玩家根本不存在。现在只有 3 个"急性子"一关门就找座，其余的人先站着，
   * 发车后 1~4 秒才加入 —— 进入行驶时 1~2 个空座的局约占 90%（probe 150 局：
   * 1 个空座 52 局、2 个 84 局），玩家按导航走过去基本都能抢到，但得快。
   */
  seatAfter: number;
}

const btnSet = (...b: Button[]) => new Set<Button>(b);

/**
 * 上车后的站位：每个 bot 一个，彼此相距 ≥ 1.0，离立杆 ≥ 0.7、离座垫/障碍物 ≥ 0.6。
 * 分布在车厢后半段（后门进来近），不会堵在门口。
 */
const BOARD_SPOTS: Vec2[] = [
  V2(-0.8, -5.5), V2(0.8, -5.5), V2(-0.8, -2.9), V2(0.8, -3.1),
  V2(-0.6, -1.2), V2(0.6, 0.9), V2(-0.7, 1.9)
];

/** 发车（进入行驶）的对局时刻。 */
const DEPART_AT = BALANCE.boardDuration + BALANCE.ignitionDuration;
/**
 * 一关门就找座的 bot。按 id 取而不是随机：session 每局都会打乱角色顺序，
 * 按 id 固定名额已经足够随机，而且保证"急性子"恰好 3 个 —— 4 个就又是发车即满座，
 * 2 个则空座太多、"坐着不动"反成最优（probe 里 SITTER 胜率冲到 40%）。
 */
const EAGER_SEATERS: ReadonlySet<number> = new Set([2, 5, 7]);
/** 其余 bot 在发车后多少秒开始加入抢座：[MIN, MIN + SPREAD)。 */
const SEAT_DELAY_MIN = 1;
const SEAT_DELAY_SPREAD = 3;
/**
 * bot 坐多久主动让座：[MIN, MIN + SPREAD) 秒。
 * 座位现在可以被"连推三下"拽起来，换座主要靠推挤；主动让座太勤（旧值 6~13 秒）
 * 等于不停白送空座，"抢到就坐着不动"又会重新变成最优解。
 */
const SEAT_HOLD_MIN = 20;
const SEAT_HOLD_SPREAD = 10;
/** 没空座时，多远以内的"坐着的人"值得过去拽（旧值 4.5 基本只够到隔壁座）。 */
const SEAT_ATTACK_RANGE = 8;
/**
 * 胆大的 bot：到站开门时会去门口黄圈刷分，被挤到离门 1.0 以内才慌。
 * 取 3 个非"急性子"的（急性子忙着抢座，见 EAGER_SEATERS）。
 * 没有他们，门口永远没人，"往门外推"这条进攻线在对局里不存在。
 */
const BRAVE_BOTS: ReadonlySet<number> = new Set([1, 4, 6]);
const BRAVE_PANIC_DIST = 1.0;
/**
 * 坏心眼的 bot：车门开着时（到站和终局），专挑离门最近、站着又没抓扶手的人，
 * 绕到他靠车厢内侧的一边往门外推（和 probe 里的 SMART 打法同一个思路）。
 *
 * 以前 bot 只会"顺手推身边的人"：玩家抓扶手不动时，300 局里 74% 的局没有任何 bot 掉下车，
 * 平均每局 0.33 次，"把对手挤下车"这条标语在对局里基本看不到。
 * 现在同口径每局约 1.5 次、终局前约占六成、"0 次"的局约 23%。
 *
 * 只有 2 个：3 个时会抢走玩家进攻打法的猎物、推挤扇形还会连带把守在门边的玩家推下去
 * （probe 里 SMART 存活率 91% → 71%）。坏心眼也不把玩家当目标、玩家在推挤扇形里时先不推 ——
 * 新增的这股推力只在 bot 之间发生，玩家承受的压力和改前一样（普通 bot 照旧会推玩家）。
 * probe 180 局对比：SITTER/BALANCED/TURTLE 存活率 90%/90%/88% → 92%/91%/88%。
 */
const BULLY_BOTS: ReadonlySet<number> = new Set([3, 7]);
/** 离门多远以内的人算"值得推"的目标。 */
const BULLY_RANGE = 3.0;

/** 玩家是否在这个 bot 此刻推挤的扇形范围里（与 simulation 的推挤判定同一口径）。 */
function playerInPushCone(char: CharacterState, ctx: BotContext): boolean {
  const f = V2(Math.sin(char.facing), Math.cos(char.facing));
  for (const o of ctx.characters) {
    if (!o.isPlayer || !o.alive) continue;
    const to = v2Sub(o.pos, char.pos);
    const d = v2Len(to);
    if (d > BALANCE.pushRange || d < 1e-6) continue;
    if ((to.x * f.x + to.z * f.z) / d >= 0.25) return true;
  }
  return false;
}

const memory = new Map<number, BotMemory>();
/** bot 记忆初始化也要走对局种子，否则同一 seed 跑两次结果不同。 */
let memRnd: () => number = Math.random;

function mem(id: number): BotMemory {
  let m = memory.get(id);
  if (!m) {
    m = {
      target: null,
      timer: 0,
      grabTimer: 0.6 + memRnd(),
      pushTimer: 0.8 + memRnd() * 1.4,
      skillTimer: 3 + memRnd() * 4,
      panic: 0.3,
      seatHold: SEAT_HOLD_MIN + memRnd() * SEAT_HOLD_SPREAD,
      seatAfter: EAGER_SEATERS.has(id)
        ? 0
        : DEPART_AT + SEAT_DELAY_MIN + memRnd() * SEAT_DELAY_SPREAD
    };
    memory.set(id, m);
  }
  return m;
}

/** 当前开着的门的“门口点”（车厢内侧靠门那一格）。 */
function openDoorPoints(layout: BusLayout): Vec2[] {
  const out: Vec2[] = [];
  for (const d of layout.doors) {
    if (!d.open) continue;
    out.push(V2(layout.interior.maxX - 0.2, (d.zMin + d.zMax) / 2));
  }
  return out;
}

function nearestDist(p: Vec2, pts: Vec2[]): number {
  let best = Infinity;
  for (const q of pts) best = Math.min(best, v2Dist(p, q));
  return best;
}

function randomInteriorTarget(layout: BusLayout, rnd: () => number): Vec2 {
  const r = layout.interior;
  return V2(
    r.minX + 1.2 + rnd() * (r.maxX - r.minX - 2.6),
    r.minZ + 1.2 + rnd() * (r.maxZ - r.minZ - 2.4)
  );
}

/** 去某个点：交给寻路（绕立杆/座垫/障碍物）；到了就返回零向量，别顶着东西原地踩。 */
function go(char: CharacterState, ctx: BotContext, target: Vec2): Vec2 {
  return ctx.nav.steer(char.id, char.pos, target, ctx.time).dir;
}

/** 最近的扶手；优先空着的，全被占了才退而求其次（站过去等着也比乱跑强）。 */
function pickRail(char: CharacterState, ctx: BotContext): { pos: Vec2; dist: number } | null {
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const pass of [true, false]) {
    for (const h of ctx.layout.handrails) {
      if (pass && !ctx.railFree(h.id)) continue;
      const d = v2Dist(char.pos, h);
      if (d < bestD) { bestD = d; best = V2(h.x, h.z); }
    }
    if (best) break;
  }
  return best ? { pos: best, dist: bestD } : null;
}

/** 推挤方向是角色朝向；朝向偏离目标超过这个角度就先转身再推，不然推空。 */
const AIM_TOLERANCE = 0.45;

/**
 * 贴近目标后：朝向对准了且能推就推；没对准就朝目标迈一步把身子转过来。
 * 冷却中就原地站着，不再一直往人身上顶（顶不动会被算成"想走走不动"）。
 */
function engage(char: CharacterState, target: Vec2, canPush: boolean): { move: Vec2; push: boolean } {
  const want = Math.atan2(target.x - char.pos.x, target.z - char.pos.z);
  let diff = want - char.facing;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  if (!canPush) return { move: V2(), push: false };
  if (Math.abs(diff) > AIM_TOLERANCE) return { move: v2Norm(v2Sub(target, char.pos)), push: false };
  return { move: V2(), push: true };
}

/**
 * 坏心眼的一步：挑目标 → 绕到他内侧 → 朝门的方向推。没有合适目标返回 null（照常做别的事）。
 * 目标只挑站着、没抓扶手的 bot：抓着扶手的人只吃 30% 推力，推不出去；玩家不挑（见 BULLY_BOTS）。
 */
function bully(
  char: CharacterState, ctx: BotContext, doors: Vec2[], m: BotMemory, rnd: () => number
): InputFrame | null {
  let victim: CharacterState | null = null;
  let door = V2();
  let best = BULLY_RANGE;
  for (const o of ctx.characters) {
    if (o.id === char.id || !o.alive || o.seatId !== null || o.grabHandrail !== null) continue;
    if (o.isPlayer) continue;
    for (const d of doors) {
      const x = v2Dist(o.pos, d);
      if (x < best) { best = x; victim = o; door = d; }
    }
  }
  if (!victim) return null;
  const buttons = new Set<Button>();
  if (char.grabHandrail !== null) return { move: V2(), buttons: btnSet('interact') };
  const out = v2Norm(v2Sub(door, victim.pos));
  const toVictim = v2Sub(victim.pos, char.pos);
  const dist = v2Len(toVictim);
  const lined = dist > 1e-3 && (toVictim.x * out.x + toVictim.z * out.z) / dist > 0.5;
  // 还没站到他内侧：绕过去（寻路会绕开立杆和人堆）。
  if (!(lined && dist <= BALANCE.pushRange * 0.95)) {
    const spot = V2(victim.pos.x - out.x * 1.05, victim.pos.z - out.z * 1.05);
    return { move: go(char, ctx, spot), buttons };
  }
  // 站好了：对准就推；推挤冷却中就用身体往门那边顶。
  // （试过冷却中冲刺顶人：冲刺把自己也带到门边，掉车数反而降了，不用。）
  if (char.pushCd <= 0 && m.pushTimer <= 0) {
    const e = engage(char, victim.pos, true);
    if (e.push && playerInPushCone(char, ctx)) {
      // 推挤是扇形范围，玩家站在旁边会被一起推出去：等他走开再推。
      return { move: V2(), buttons };
    }
    if (e.push) {
      buttons.add('push');
      m.pushTimer = 0.4 + rnd() * 0.5;
      return { move: V2(), buttons };
    }
    return { move: e.move, buttons };
  }
  return { move: v2Norm(toVictim), buttons };
}

/** 单个机器人的决策：返回本帧输入。 */
export function decideBot(
  char: CharacterState,
  ctx: BotContext,
  rnd: () => number,
  dt: number
): InputFrame {
  const m = mem(char.id);
  const buttons = new Set<Button>();
  let move = V2();

  if (ctx.phase === 'boarding') {
    // 站台上直走到门口，进了车厢各去各的站位（交给寻路），到了就站住。
    // 以前按 id%4 分 4 条通道，7 个 bot 两两共用一个点，后到的一直顶着先到的走不动。
    if (char.pos.x > 3.1) return { move: v2Norm(v2Sub(V2(2.9, -5.5), char.pos)), buttons };
    const spot = BOARD_SPOTS[(char.id - 1 + BOARD_SPOTS.length) % BOARD_SPOTS.length];
    // 差不多到了就站住：站位附近有人时硬挤进去只会原地顶着。
    if (v2Dist(char.pos, spot) < 0.6) return { move: V2(), buttons };
    return { move: go(char, ctx, spot), buttons };
  }

  const doors = openDoorPoints(ctx.layout);
  const myDoorDist = nearestDist(char.pos, doors);
  const crowdT = ctx.crowd / BALANCE.crowdMax;

  m.grabTimer -= dt;
  m.pushTimer -= dt;
  m.skillTimer -= dt;
  m.timer -= dt;

  // 1) 自己危险：先抓扶手，抓不到就逃离门口。反应有延迟，不是瞬间闪避。
  // 胆大的要被挤到门边（1.0 以内）才慌，站在门口黄圈内侧刷分时不慌。
  const brave = BRAVE_BOTS.has(char.id);
  if (myDoorDist < (brave ? BRAVE_PANIC_DIST : 1.7)) {
    m.panic -= dt;
    if (m.panic <= 0) {
      const r = pickRail(char, ctx);
      if (char.grabHandrail !== null) {
        move = V2();
      } else if (r && r.dist < BALANCE.handrailGrabRange * 0.9) {
        buttons.add('interact');
      } else if (r && r.dist < 2.2) {
        move = go(char, ctx, r.pos);
      } else {
        move = v2Norm(V2(-1, (rnd() - 0.5) * 0.5));
        if (char.dashCd <= 0 && myDoorDist < 1.1) buttons.add('dash');
      }
      return { move, buttons };
    }
  } else {
    m.panic = 0.25 + rnd() * 0.5;
  }

  // 1.2) 坏心眼的：车门开着时，把离门最近的人往门外推。
  if (BULLY_BOTS.has(char.id) && char.seatId === null && doors.length
    && (ctx.phase === 'driving' || ctx.phase === 'finale')) {
    const b = bully(char, ctx, doors, m, rnd);
    if (b) return b;
  }

  // 1.5) 胆大的：到站开门、黄圈正好贴在门口时，优先去门口刷分（到了就站住）。
  // 这是热区设计本来的意图 ——"敢不敢去门口刷分"。以前所有 bot 离门 1.9 以内都不进圈，
  // 开门的 27 秒里 7 个 bot 在门口 1.5m 内合计只待 2 人·秒，推人出门的打法根本没有目标。
  if (brave && char.seatId === null && doors.length && ctx.phase === 'driving'
    && nearestDist(ctx.hotZone.pos, doors) < 1.6) {
    if (char.grabHandrail !== null) return { move: V2(), buttons: btnSet('interact') };
    if (v2Dist(char.pos, ctx.hotZone.pos) > ctx.hotZone.radius * 0.8) {
      return { move: go(char, ctx, ctx.hotZone.pos), buttons };
    }
    return { move: V2(), buttons };
  }

  // 2) 座位：主要产出源，优先级仅次于保命。
  if (ctx.phase !== 'finale') {
    if (char.seatId !== null) {
      m.seatHold -= dt;
      // "坐够了"就起身，让座位在整局里有轮换。
      // 以前还有一条"稳定度 < 0.36 就主动让座"：那是推不起来时代（E1 之前）的补丁，
      // 现在连推三下一定能拽起，它反而让 bot 被推两下就让座 —— 玩家要推三下、bot 只要两下，
      // 规则不一致，还让"守着座位旁边连推"变成刷分点。
      if (m.seatHold <= 0) {
        m.seatHold = SEAT_HOLD_MIN + rnd() * SEAT_HOLD_SPREAD;
        return { move: V2(), buttons: btnSet('interact') };
      }
      return { move: V2(), buttons };
    }
    if (char.sitLockTimer <= 0 && m.seatHold > 0.5 && ctx.time >= m.seatAfter) {
      let target: Seat | null = null;
      let bestD = Infinity;
      for (const st of ctx.layout.seats) {
        if (!ctx.seatFree(st.id)) continue;
        // 空座前沿已经站着别人、而且他马上就能坐：去了也只能顶着他，换一个。
        // 刚被拽起来的人（锁定期内坐不下）不算 —— 否则被拽起的人站在自己座位前，
        // bot 全都绕开，锁一过他又坐回去，"拽座"等于白拽。
        const front = seatFrontPoint(st, char.radius);
        if (ctx.characters.some((o) => o.id !== char.id && o.alive && o.seatId === null && o.sitLockTimer <= 0
          && v2Dist(o.pos, front) < 0.6)
          && distToRect(char.pos, st.cushion) > SEAT.reachEdge) continue;
        const d = v2Dist(char.pos, st);
        if (d < bestD) { bestD = d; target = st; }
      }
      if (target) {
        // 座垫是实心的：走到座垫前沿、贴上就坐（判定口径与模拟一致：到座垫边缘）。
        if (distToRect(char.pos, target.cushion) < SEAT.reachEdge * 0.9) {
          return { move: V2(), buttons: btnSet('interact') };
        }
        if (bestD < 5.5) return { move: go(char, ctx, seatFrontPoint(target, char.radius)), buttons };
      } else {
        // 没空座就去把坐着的人拽起来 —— 这是"抢座"真正发生的地方。
        let victim: CharacterState | null = null;
        let vd = Infinity;
        for (const o of ctx.characters) {
          if (o.id === char.id || !o.alive || o.seatId === null) continue;
          const d = v2Dist(o.pos, char.pos);
          if (d < vd) { vd = d; victim = o; }
        }
        if (victim && vd < SEAT_ATTACK_RANGE) {
          if (vd <= BALANCE.pushRange * 0.92) {
            const e = engage(char, victim.pos, char.pushCd <= 0);
            if (e.push) buttons.add('push');
            return { move: e.move, buttons };
          }
          // 坐着的人在座垫里，寻路会把目标投影到座垫前沿。
          return { move: go(char, ctx, victim.pos), buttons };
        }
      }
    }
  }

  // 3) 事件预警 / 高拥挤 / 终局：抓扶手。
  const wantGrab =
    (ctx.event !== null && ctx.event.warnRemaining > 0) ||
    ctx.phase === 'finale' ||
    crowdT > 0.75;
  if (wantGrab && char.grabHandrail === null) {
    const r = pickRail(char, ctx);
    if (r) {
      if (r.dist < BALANCE.handrailGrabRange * 0.9) {
        if (ctx.layout.handrails.some((h) => ctx.railFree(h.id) && v2Dist(char.pos, h) < BALANCE.handrailGrabRange)) {
          buttons.add('interact');
        }
      } else {
        move = go(char, ctx, r.pos);
        return { move, buttons };
      }
    }
  } else if (!wantGrab && char.grabHandrail !== null && m.grabTimer <= 0) {
    // 平时别一直挂在扶手上，不然整局没人动。
    buttons.add('interact');
    m.grabTimer = 3 + rnd() * 4;
  }

  // 3.5) 没座位就去热区刷分。没有这一条，没抢到座的 AI 会整局在车厢里瞎逛。
  if (char.seatId === null && (ctx.phase === 'driving' || ctx.phase === 'finale')) {
    const zd = v2Dist(char.pos, ctx.hotZone.pos);
    // 已经在圈里（90% 半径内）就不再往圈心挤：圈里有人时硬挤只会原地顶着。
    if (zd > ctx.hotZone.radius * 0.9 && zd < 6.5 && myDoorDist > 1.9) {
      return { move: go(char, ctx, ctx.hotZone.pos), buttons };
    }
  }

  // 4) 进攻：优先挑“已经比我更靠近门”的对手，把他往门那边顶。
  let prey: CharacterState | null = null;
  let preyScore = -Infinity;
  for (const o of ctx.characters) {
    if (o.id === char.id || !o.alive) continue;
    const d = v2Dist(o.pos, char.pos);
    if (d > 3.2) continue;
    const theirDoorDist = nearestDist(o.pos, doors);
    // 对手离门越近、离我越近，越值得推。
    const score = (theirDoorDist < myDoorDist ? 2.2 : 0) + 3 / Math.max(0.4, d) - theirDoorDist * 0.25;
    if (score > preyScore) {
      preyScore = score;
      prey = o;
    }
  }

  if (prey && doors.length > 0) {
    const d = v2Dist(prey.pos, char.pos);
    // 贴身时用身体往门那边顶（碰撞会把对方挤过去），这是挤人的主要方式，保留。
    move = go(char, ctx, prey.pos);
    if (d <= BALANCE.pushRange * 0.92 && char.pushCd <= 0 && m.pushTimer <= 0) {
      const e = engage(char, prey.pos, true);
      if (e.push) {
        buttons.add('push');
        m.pushTimer = 0.7 + rnd() * 1.1;
      } else {
        move = e.move;
      }
    }
    if (char.skillCd <= 0 && m.skillTimer <= 0 && d < 2.4 && ctx.canUseSkill(char.id)) {
      buttons.add('skill');
      m.skillTimer = 5 + rnd() * 5;
    }
    return { move, buttons };
  }

  // 4) 没门开着 / 没目标：在车厢里闲逛，顺手推一把身边的人。
  if (!m.target || m.timer <= 0 || v2Dist(char.pos, m.target) < 0.6) {
    m.target = randomInteriorTarget(ctx.layout, rnd);
    m.timer = 1.6 + rnd() * 2.4;
  }
  move = go(char, ctx, m.target);
  // 闲逛目标落在障碍里时寻路会停在它旁边：到了就换个目标，而不是原地发呆。
  if (v2Len(move) < 0.05) {
    m.target = randomInteriorTarget(ctx.layout, rnd);
    m.timer = 1.6 + rnd() * 2.4;
    move = go(char, ctx, m.target);
  }

  if (m.pushTimer <= 0 && char.pushCd <= 0) {
    const near = ctx.characters.find(
      (o) => o.id !== char.id && o.alive && v2Dist(o.pos, char.pos) < BALANCE.pushRange * 0.9
    );
    if (near && rnd() < 0.7) {
      move = v2Norm(v2Sub(near.pos, char.pos));
      buttons.add('push');
    }
    m.pushTimer = 1.2 + rnd() * 1.8;
  }
  if (m.skillTimer <= 0 && char.skillCd <= 0 && ctx.canUseSkill(char.id)) {
    buttons.add('skill');
    m.skillTimer = 6 + rnd() * 6;
  }

  return { move, buttons };
}

export function resetAiMemory(rnd?: () => number) {
  memory.clear();
  memRnd = rnd ?? Math.random;
}
