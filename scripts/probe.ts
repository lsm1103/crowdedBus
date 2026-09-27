/**
 * 平衡探针（docs/08 第 6.5 节）。
 *
 * 1. 相机/输入的纯数学不回归（画面层没法无头验证，但这几块是纯函数）。
 * 2. **打法对照**：同一批种子，让玩家（0 号）分别用 5 种打法去打，其余 7 个是机器人。
 *    统计回合胜率、平均存活时间、扔出人数；同时统计全部回合的淘汰数、提前结束比例、回合时长，
 *    以及机器人卡死次数、过渡状态的单帧位移。
 * 3. 把验收标准写成断言。
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { Simulation } from '../src/domain/simulation';
import { CHARACTERS } from '../src/config/characters';
import { BALANCE } from '../src/config/balance';
import { CAMERA_YAW_DEFAULT, PIVOT_Y } from '../src/config/view';
import { V2, v2Norm, v2Sub, v2Dist, v2Len, v2Scale, angleDelta, screenToWorld, yawChase, type Vec2 } from '../src/core/math';
import { doorCenterZ, type Door } from '../src/domain/layout';
import { carryToDoor, carryStage } from '../src/domain/ai';
import type { Button, InputFrame } from '../src/core/input';
import type { CharacterState } from '../src/domain/types';

/** 项目没装 @types/node：脚本只用到 process 的这两样，自己声明一下。 */
declare const process: { env: Record<string, string | undefined>; exit(code: number): never };

// ---------------------------------------------------------------------------
// 一、纯数学断言
// ---------------------------------------------------------------------------
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log((ok ? '✓ ' : '✗ ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failed++;
}
function checkQuiet(name: string, ok: boolean, detail = '') {
  if (ok) return;
  failed++;
  console.error('✗ ' + name + (detail ? ' — ' + detail : ''));
}
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

{
  const r = screenToWorld(1, 0, CAMERA_YAW_DEFAULT);
  checkQuiet('screenToWorld 屏幕右',
    near(r.x, Math.cos(CAMERA_YAW_DEFAULT)) && near(r.z, -Math.sin(CAMERA_YAW_DEFAULT)), JSON.stringify(r));
  for (const yaw of [0, 0.7, 1.3, 2.9, -2.1]) {
    const u = screenToWorld(0, -1, yaw);
    checkQuiet('screenToWorld 屏幕上 @yaw=' + yaw.toFixed(2),
      near(u.x, -Math.sin(yaw)) && near(u.z, -Math.cos(yaw)), JSON.stringify(u));
  }
  const opts = { deadzone: 0.25, lambda: 8, maxRate: 1.2 };
  checkQuiet('yawChase 死区内不动', yawChase(0, 0.2, 1 / 60, opts) === 0);
  const big = yawChase(0, Math.PI, 1 / 60, opts);
  checkQuiet('yawChase 单帧受转速上限', big <= opts.maxRate / 60 + 1e-9, 'step=' + big.toFixed(4));
  let y = 0;
  for (let i = 0; i < 600; i++) y = yawChase(y, 2.0, 1 / 60, opts);
  const rest = angleDelta(y, 2.0);
  checkQuiet('yawChase 收敛到死区边缘', Math.abs(rest) <= opts.deadzone + 1e-3 && Math.abs(rest) > 1e-6);
  // 相机实际摆位 vs 摇杆基向量：这两者不一致就是"推右往左走"。
  for (const yaw of [CAMERA_YAW_DEFAULT, 0, 1.1, -2.4, 3.0]) {
    for (const shoulder of [0, 0.35]) {
      const cam = new PerspectiveCamera(50, 2, 0.05, 400);
      const dist = 2.4;
      const height = dist * Math.tan(13 * Math.PI / 180);
      const sy = Math.sin(yaw);
      const cy = Math.cos(yaw);
      cam.position.set(sy * dist + cy * shoulder, PIVOT_Y + height, cy * dist - sy * shoulder);
      cam.lookAt(cy * shoulder, PIVOT_Y, -sy * shoulder);
      cam.updateMatrixWorld(true);
      const camRight = new Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const basis = screenToWorld(1, 0, yaw);
      checkQuiet(`相机右向量 == 摇杆基 @yaw=${yaw.toFixed(2)} shoulder=${shoulder}`,
        near(camRight.x, basis.x, 2e-3) && near(camRight.z, basis.z, 2e-3));
    }
  }
  checkQuiet('angleDelta 环绕', near(angleDelta(3.0, -3.0), -6.0 + Math.PI * 2));
}

// ---------------------------------------------------------------------------
// 二、打法对照
// ---------------------------------------------------------------------------
const dt = 1 / BALANCE.tickRate;
const EMPTY = new Set<Button>();
const set = (...b: Button[]) => new Set<Button>(b);
const NONE: InputFrame = { move: V2(), pressed: EMPTY, held: EMPTY };
const f = (move: Vec2, pressed: Set<Button> = EMPTY, held: Set<Button> = EMPTY): InputFrame => ({ move, pressed, held });
const facingVec = (a: number): Vec2 => ({ x: Math.sin(a), z: Math.cos(a) });
const aimCos = (me: CharacterState, p: Vec2) => {
  const to = v2Sub(p, me.pos);
  const d = v2Len(to);
  if (d < 1e-6) return 1;
  const fv = facingVec(me.facing);
  return (to.x * fv.x + to.z * fv.z) / d;
};

interface Ctx { me: CharacterState; sim: Simulation }
interface Strategy { name: string; desc: string; act(c: Ctx): InputFrame }

/** 往某点走：和机器人同一套寻路。 */
const goTo = (sim: Simulation, me: CharacterState, p: Vec2) => sim.nav.steer(me.id, me.pos, p, sim.time).dir;
const doorInner = (sim: Simulation, d: Door) => V2(sim.layout.interior.maxX - 0.75, doorCenterZ(d));

/**
 * 被人扯住时挣脱：和机器人一样有反应时间（0.35 秒），不能在被扯住的同一帧就挣开 ——
 * 否则探针里的玩家对"拽起来 → 强推"天然免疫，测出来的座位强度是假的。
 */
const heldSince = new Map<number, number>();
function struggle(sim: Simulation, me: CharacterState): boolean {
  if (me.heldBy === null || sim.isSeatMoving(me.id)) {
    heldSince.delete(me.id);
    return false;
  }
  const t0 = heldSince.get(me.id) ?? sim.time;
  heldSince.set(me.id, t0);
  return sim.time - t0 >= 0.35;
}

/** 上车：先从站台走进车厢（所有打法一样）。进了车厢返回 null。 */
function boardIn(me: CharacterState): InputFrame | null {
  if (me.pos.x > 2.3) return f(v2Norm(v2Sub(V2(1.6, -4.3), me.pos)));
  return null;
}

/** 抓住最近的空扶手不放；已经抓着就一直按住。 */
function railPlay(sim: Simulation, me: CharacterState): InputFrame {
  if (me.hold?.kind === 'rail') return f(V2(), EMPTY, set('grab'));
  const pv = sim.grabPreview(me.id);
  if (pv.kind === 'rail') return f(V2(), set('grab'), set('grab'));
  let best: Vec2 | null = null;
  let bd = Infinity;
  for (const h of sim.layout.handrails) {
    if (!sim.railFree(h.id, me.id)) continue;
    const d = v2Dist(me.pos, h);
    if (d < bd) { bd = d; best = V2(h.x, h.z); }
  }
  if (!best) return NONE;
  if (bd < BALANCE.railReach * 0.8) return f(v2Scale(v2Norm(v2Sub(best, me.pos)), 0.2));
  return f(goTo(sim, me, best));
}

const STRATEGIES: Strategy[] = [
  {
    name: 'IDLE', desc: '上车后站着完全不动',
    act({ me, sim }) {
      const b = boardIn(me);
      if (b) return b;
      if (sim.phase === 'boarding') {
        const spot = V2(-0.4, -2.9);
        if (v2Dist(me.pos, spot) > 0.3) return f(goTo(sim, me, spot));
      }
      return NONE;
    }
  },
  {
    name: 'RAIL', desc: '全程抓扶手（被扯住会挣脱）',
    act({ me, sim }) {
      if (struggle(sim, me)) return f(V2(), set('push'), set('grab'));
      return boardIn(me) ?? railPlay(sim, me);
    }
  },
  {
    name: 'SITTER', desc: '抢座坐着；被拽起来就再找座，没座就守在座位边等',
    act({ me, sim }) {
      const b = boardIn(me);
      if (b) return b;
      if (me.seatId !== null) return NONE;
      if (struggle(sim, me)) return f(V2(), set('push'));
      if (sim.canSit(me.id)) return f(V2(), set('grab'));
      let best = -1;
      let bd = Infinity;
      for (const s of sim.layout.seats) {
        if (!sim.seatFree(s.id)) continue;
        const d = v2Dist(me.pos, sim.seatApproach(s.id));
        if (d < bd) { bd = d; best = s.id; }
      }
      if (best < 0) {
        // 没空座：守在最近的座位旁边等它空出来。
        let nd = Infinity;
        for (const s of sim.layout.seats) {
          const d = v2Dist(me.pos, sim.seatApproach(s.id));
          if (d < nd) { nd = d; best = s.id; }
        }
        const ap = sim.seatApproach(best);
        return v2Dist(me.pos, ap) > 0.4 ? f(goTo(sim, me, ap)) : NONE;
      }
      const ap = sim.seatApproach(best);
      if (v2Dist(me.pos, ap) < 0.2) {
        const s = sim.layout.seats[best];
        return f(v2Scale(v2Norm(v2Sub(V2(s.x, s.z), me.pos)), 0.3));
      }
      return f(goTo(sim, me, ap));
    }
  },
  {
    name: 'BRAWLER', desc: '一直追最近的人推、冲',
    act({ me, sim }) {
      const b = boardIn(me);
      if (b) return b;
      if (struggle(sim, me)) return f(V2(), set('push'));
      let foe: CharacterState | null = null;
      let bd = Infinity;
      for (const o of sim.characters) {
        if (o.id === me.id || !o.alive || o.seatId !== null || o.status === 'thrown' || o.status === 'carried') continue;
        const d = v2Dist(o.pos, me.pos);
        if (d < bd) { bd = d; foe = o; }
      }
      if (!foe) return NONE;
      const reach = me.radius + foe.radius + BALANCE.pushReach;
      const toFoe = v2Norm(v2Sub(foe.pos, me.pos));
      if (bd <= reach) {
        if (aimCos(me, foe.pos) < 0.8) return f(v2Scale(toFoe, 0.2));
        return f(V2(), me.pushCd <= 0 ? set('push') : EMPTY);
      }
      if (bd < 2.6 && me.dashCd <= 0 && aimCos(me, foe.pos) > 0.9) return f(toFoe, set('dash'));
      return f(goTo(sim, me, foe.pos));
    }
  },
  {
    name: 'THROWER', desc: '守在门边扶手上往门外推；有人躺在门口就松手抓起来扔出去',
    act({ me, sim }) {
      const b = boardIn(me);
      if (b) return b;
      if (struggle(sim, me)) return f(V2(), set('push'), me.hold ? set('grab') : EMPTY);
      const doors = sim.openDoors();
      const I = sim.layout.interior;
      // 1) 手里拖着人：去最近的开着的门，对准了就扔；门还没开就在门前等。
      if (me.hold?.kind === 'char') {
        const t = sim.characters[me.hold.id];
        if (t.status === 'carried') {
          if (sim.throwWouldExit(me.id)) return f(V2(), set('push'), set('grab'));
          const cands = doors.length ? doors : sim.pendingDoor ? [sim.pendingDoor] : [];
          if (!cands.length) return f(V2(), EMPTY, set('grab'));
          const door = cands.reduce((a, d) => (v2Dist(me.pos, doorInner(sim, d)) < v2Dist(me.pos, doorInner(sim, a)) ? d : a));
          const plan = carryToDoor(me, door, sim, doors.length > 0);
          return f(plan ?? goTo(sim, me, carryStage(door, sim)), EMPTY, set('grab'));
        }
        if (t.seatId !== null || sim.isSeatMoving(t.id)) return f(v2Scale(v2Norm(v2Sub(t.pos, me.pos)), 0.05), EMPTY, set('grab'));
        if (aimCos(me, t.pos) > 0.6 && me.pushCd <= 0) return f(V2(), set('push'), set('grab'));
        return f(v2Scale(v2Norm(v2Sub(t.pos, me.pos)), 0.3), EMPTY, set('grab'));
      }
      if (doors.length && !sim.event) {
        // 2) 门口附近有人躺着（抓得起来）：松开扶手去抓。
        let down: CharacterState | null = null;
        let dd = 3.2;
        for (const o of sim.characters) {
          if (!o.alive || o.id === me.id || o.status !== 'down' || o.heldBy !== null || sim.grabImmune(o.id)) continue;
          const d = v2Dist(o.pos, me.pos);
          const toDoor = Math.min(...doors.map((dr) => v2Dist(o.pos, doorInner(sim, dr))));
          if (d < dd && toDoor < 4) { dd = d; down = o; }
        }
        if (down) {
          if (me.hold?.kind === 'rail') return NONE; // 先松手
          const pv = sim.grabPreview(me.id);
          if (pv.kind === 'char' && pv.id === down.id) return f(V2(), set('grab'), set('grab'));
          if (dd < me.radius + down.radius + 0.5) return f(v2Scale(v2Norm(v2Sub(down.pos, me.pos)), 0.2));
          return f(goTo(sim, me, down.pos));
        }
        // 3) 身边有人正好在我和门之间：推出去（抓着扶手也能推）。
        if (me.pushCd <= 0) {
          for (const o of sim.characters) {
            if (!o.alive || o.id === me.id || o.seatId !== null || o.status === 'thrown' || o.status === 'carried') continue;
            if (v2Dist(o.pos, me.pos) > me.radius + o.radius + BALANCE.pushReach) continue;
            const door = doors.reduce((a, dr) => (v2Dist(o.pos, doorInner(sim, dr)) < v2Dist(o.pos, doorInner(sim, a)) ? dr : a));
            if (v2Dist(o.pos, doorInner(sim, door)) > 2.6) continue;
            const out = v2Norm(v2Sub(V2(I.maxX + 1, doorCenterZ(door)), o.pos));
            const to = v2Norm(v2Sub(o.pos, me.pos));
            if (to.x * out.x + to.z * out.z < 0.4) continue;
            if (aimCos(me, o.pos) > 0.75) return f(V2(), set('push'), me.hold ? set('grab') : EMPTY);
            return f(v2Scale(to, 0.15), EMPTY, me.hold ? set('grab') : EMPTY);
          }
        }
      }
      // 4) 平时：抓住离门口最近的空扶手（门边是下手的位置，扶手保命）。
      if (me.hold?.kind === 'rail') return f(V2(), EMPTY, set('grab'));
      const pv = sim.grabPreview(me.id);
      if (pv.kind === 'rail') return f(V2(), set('grab'), set('grab'));
      let best: Vec2 | null = null;
      let bs = Infinity;
      for (const h of sim.layout.handrails) {
        if (!sim.railFree(h.id, me.id)) continue;
        const toDoor = Math.min(...sim.layout.doors.map((dr) => v2Dist(h, doorInner(sim, dr))));
        const s2 = v2Dist(me.pos, h) * 0.5 + toDoor;
        if (s2 < bs) { bs = s2; best = V2(h.x, h.z); }
      }
      if (!best) return railPlay(sim, me);
      if (v2Dist(me.pos, best) < BALANCE.railReach * 0.8) return f(v2Scale(v2Norm(v2Sub(best, me.pos)), 0.2));
      return f(goTo(sim, me, best));
    }
  }
];

interface RoundStat {
  win: boolean;
  survival: number;
  throwOuts: number;
  elims: number;
  early: boolean;
  duration: number;
  stuck: number;
  jumps: number;
  maxJump: number;
  playerHuntFrames: number;
}

const STUCK_WINDOW = 2.0;
const STUCK_DIST = 0.2;

function runRound(st: Strategy, seed: number, stuckLog: string[]): RoundStat {
  const sim = new Simulation(seed);
  sim.setup(CHARACTERS.map((d, i) => ({ defId: d.id, name: d.name, color: d.color, isPlayer: i === 0 })), seed);
  const me = sim.characters[0];
  heldSince.clear();
  let diedAt = -1;
  let stuck = 0;
  let jumps = 0;
  let maxJump = 0;
  const win: { t0: number; p0: Vec2 }[] = sim.characters.map((c) => ({ t0: 0, p0: { ...c.pos } }));
  const lastContact: number[] = sim.characters.map(() => -99);
  const maxSteps = Math.ceil(150 / dt);
  for (let i = 0; i < maxSteps; i++) {
    const frame = me.alive ? st.act({ me, sim }) : NONE;
    const prev = sim.characters.map((c) => ({ pos: { ...c.pos }, status: c.status }));
    sim.applyPlayerInput(frame);
    sim.tick(dt);
    if (!me.alive && diedAt < 0) diedAt = sim.time;
    // 过渡状态（坐下/起身/被拖/落地）的单帧位移。被扔飞行中的那一帧（落地帧）不算。
    for (const c of sim.characters) {
      const tag = sim.kinematicTag(c.id);
      if (!tag || prev[c.id].status === 'thrown') continue;
      const step = v2Dist(c.pos, prev[c.id].pos);
      maxJump = Math.max(maxJump, step);
      if (step > 0.12) jumps++;
    }
    // 机器人卡死：连续 2 秒"想走"（输入 > 0.5、能自由走动）却没挪出 0.2，且最近 0.5 秒没贴着别人。
    for (const c of sim.characters) {
      if (c.isPlayer || !c.alive) continue;
      for (const o of sim.characters) {
        if (o !== c && o.alive && o.seatId === null && v2Dist(o.pos, c.pos) < c.radius + o.radius + 0.15) lastContact[c.id] = sim.time;
      }
      for (const n of sim.npcs) if (v2Dist(n.pos, c.pos) < c.radius + n.radius + 0.15) lastContact[c.id] = sim.time;
      const free = (c.status === 'idle' || c.status === 'walking' || c.status === 'dashing') && !c.hold
        && c.heldBy === null && c.stunTimer <= 0 && !sim.isSeatMoving(c.id) && !sim.arrived && sim.phase !== 'ended';
      const wants = v2Len(sim.moveIntent(c.id)) > 0.5;
      const w = win[c.id];
      if (!free || !wants || v2Dist(c.pos, w.p0) >= STUCK_DIST) {
        w.t0 = sim.time;
        w.p0 = { ...c.pos };
        continue;
      }
      if (sim.time - w.t0 >= STUCK_WINDOW) {
        if (sim.time - lastContact[c.id] > 0.5) {
          stuck++;
          if (stuckLog.length < 8) stuckLog.push(`${st.name} seed=${seed} t=${sim.time.toFixed(1)} bot=${c.id} pos=(${c.pos.x.toFixed(2)},${c.pos.z.toFixed(2)}) intent=(${sim.moveIntent(c.id).x.toFixed(2)},${sim.moveIntent(c.id).z.toFixed(2)})`);
        }
        w.t0 = sim.time;
        w.p0 = { ...c.pos };
      }
    }
    if (sim.phase === 'ended') break;
  }
  const r = sim.roundResult();
  if (!r) throw new Error('回合没有结束 seed=' + seed);
  return {
    win: r.winners.includes(0),
    survival: diedAt >= 0 ? diedAt : sim.time,
    throwOuts: me.throwOuts,
    elims: r.eliminated.length,
    early: sim.endedByKnockout,
    duration: sim.time,
    stuck,
    jumps,
    maxJump,
    playerHuntFrames: 0
  };
}

const RUNS = Number(process.env.PROBE_RUNS ?? 150);
const SEEDS = Array.from({ length: RUNS }, (_, i) => 1000 + i * 7919);

console.log(`\n打法对照（每种 ${RUNS} 回合，同一批种子；玩家 1 人 + 机器人 7 个）`);
console.log('打法       回合胜率  平均存活  扔出人数  回合淘汰  提前结束  回合时长  说明');
console.log('-'.repeat(92));

interface Row { name: string; winRate: number; survival: number; throwOuts: number }
const rows: Row[] = [];
const all: RoundStat[] = [];
const stuckLog: string[] = [];
for (const st of STRATEGIES) {
  const rs = SEEDS.map((s) => runRound(st, s, stuckLog));
  all.push(...rs);
  const avg = (fn: (r: RoundStat) => number) => rs.reduce((a, r) => a + fn(r), 0) / rs.length;
  const row = { name: st.name, winRate: avg((r) => (r.win ? 1 : 0)), survival: avg((r) => r.survival), throwOuts: avg((r) => r.throwOuts) };
  rows.push(row);
  console.log(
    st.name.padEnd(10) +
    (row.winRate * 100).toFixed(1).padStart(8) + '%' +
    row.survival.toFixed(1).padStart(9) + 's' +
    row.throwOuts.toFixed(2).padStart(10) +
    avg((r) => r.elims).toFixed(2).padStart(10) +
    (avg((r) => (r.early ? 1 : 0)) * 100).toFixed(0).padStart(9) + '%' +
    avg((r) => r.duration).toFixed(1).padStart(9) + 's  ' +
    st.desc
  );
}

// ---------------------------------------------------------------------------
// 三、验收门槛（docs/08 第 6.5 节）
// ---------------------------------------------------------------------------
const mean = (fn: (r: RoundStat) => number) => all.reduce((a, r) => a + fn(r), 0) / all.length;
const elims = mean((r) => r.elims);
const early = mean((r) => (r.early ? 1 : 0));
const dur = mean((r) => r.duration);
const stuck = all.reduce((a, r) => a + r.stuck, 0);
const jumps = all.reduce((a, r) => a + r.jumps, 0);
const maxJump = Math.max(...all.map((r) => r.maxJump));
const get = (n: string) => rows.find((r) => r.name === n)!;
const idle = get('IDLE');
const thrower = get('THROWER');
const sitter = get('SITTER');
const best = rows.reduce((a, r) => (r.winRate > a.winRate ? r : a));

console.log('');
check(`每回合平均淘汰 3~5 人`, elims >= 3 && elims <= 5, elims.toFixed(2));
check(`只剩 1 人提前结束的回合占 30%~60%`, early >= 0.3 && early <= 0.6, (early * 100).toFixed(1) + '%');
check(`平均回合时长 70~95 秒`, dur >= 70 && dur <= 95, dur.toFixed(1) + 's');
check(`IDLE 回合胜率明显低于 THROWER（差 ≥ 10 个百分点）`, thrower.winRate - idle.winRate >= 0.1,
  `IDLE ${(idle.winRate * 100).toFixed(1)}% vs THROWER ${(thrower.winRate * 100).toFixed(1)}%`);
check(`SITTER 不是胜率最高的打法`, best.name !== 'SITTER',
  `SITTER ${(sitter.winRate * 100).toFixed(1)}%，最高 ${best.name} ${(best.winRate * 100).toFixed(1)}%`);
check(`机器人卡死 0 次`, stuck === 0, `${stuck} 次`);
if (stuckLog.length) for (const s of stuckLog) console.log('    ' + s);
check(`坐下/起身/被拖/落地的单帧位移 ≤ 0.12`, jumps === 0, `超限 ${jumps} 帧，最大 ${maxJump.toFixed(3)}`);

if (failed > 0) {
  console.error(`\n${failed} 条断言失败`);
  process.exit(1);
}
console.log('\n全部断言通过');
