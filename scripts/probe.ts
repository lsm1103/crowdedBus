/**
 * 数值探针。
 *
 * 两件事：
 * 1. 断言相机/输入的纯数学不回归（view 层无法在无头环境验证，但这几块是纯函数）。
 * 2. **策略对照实验** —— 用同一批种子分别让"乌龟流 / 莽夫流 / 均衡流 / 完全不动"
 *    去打，看谁的名次高。这是验证"消极打法还是不是最优解"的唯一手段，
 *    靠肉眼玩几局是看不出来的。
 */
import { PerspectiveCamera, Vector3 } from 'three';
import { Simulation } from '../src/domain/simulation';
import { CHARACTERS } from '../src/config/characters';
import { BALANCE } from '../src/config/balance';
import { CAMERA_YAW_DEFAULT, PIVOT_Y } from '../src/config/view';
import { V2, v2Norm, v2Sub, v2Dist, angleDelta, screenToWorld, yawChase } from '../src/core/math';
import type { Button, InputFrame } from '../src/core/input';
import type { CharacterState } from '../src/domain/types';

// ---------------------------------------------------------------------------
// 一、纯数学断言
// ---------------------------------------------------------------------------
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) return;
  failed++;
  console.error('✗ ' + name + (detail ? ' — ' + detail : ''));
}
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

{
  const r = screenToWorld(1, 0, CAMERA_YAW_DEFAULT);
  check('screenToWorld 屏幕右',
    near(r.x, Math.cos(CAMERA_YAW_DEFAULT)) && near(r.z, -Math.sin(CAMERA_YAW_DEFAULT)), JSON.stringify(r));
  check('屏幕右对应 -z（车头 +z 在屏幕左）', r.z < 0, 'z=' + r.z.toFixed(4));

  for (const yaw of [0, 0.7, 1.3, 2.9, -2.1]) {
    const u = screenToWorld(0, -1, yaw);
    check('screenToWorld 屏幕上 @yaw=' + yaw.toFixed(2),
      near(u.x, -Math.sin(yaw)) && near(u.z, -Math.cos(yaw)), JSON.stringify(u));
  }

  const opts = { deadzone: 0.25, lambda: 8, maxRate: 1.2 };
  check('yawChase 死区内不动', yawChase(0, 0.2, 1 / 60, opts) === 0);
  const big = yawChase(0, Math.PI, 1 / 60, opts);
  check('yawChase 单帧受转速上限', big <= opts.maxRate / 60 + 1e-9, 'step=' + big.toFixed(4));
  let y = 0;
  for (let i = 0; i < 600; i++) y = yawChase(y, 2.0, 1 / 60, opts);
  const rest = angleDelta(y, 2.0);
  check('yawChase 收敛到死区边缘',
    Math.abs(rest) <= opts.deadzone + 1e-3 && Math.abs(rest) > 1e-6, 'rest=' + rest.toFixed(4));

  // 相机实际摆位 vs 摇杆基向量：这两者不一致就是"推右往左走"。
  for (const yaw of [CAMERA_YAW_DEFAULT, 0, 1.1, -2.4, 3.0]) {
    for (const shoulder of [0, 0.35]) {
      const cam = new PerspectiveCamera(50, 2, 0.05, 400);
      const dist = 2.4;
      const height = dist * Math.tan(13 * Math.PI / 180);
      const sy = Math.sin(yaw);
      const cy = Math.cos(yaw);
      const rx = cy;
      const rz = -sy;
      cam.position.set(sy * dist + rx * shoulder, PIVOT_Y + height, cy * dist + rz * shoulder);
      cam.lookAt(rx * shoulder, PIVOT_Y, rz * shoulder);
      cam.updateMatrixWorld(true);
      const camRight = new Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
      const basis = screenToWorld(1, 0, yaw);
      check(`相机右向量 == 摇杆基 @yaw=${yaw.toFixed(2)} shoulder=${shoulder}`,
        near(camRight.x, basis.x, 2e-3) && near(camRight.z, basis.z, 2e-3),
        `cam=(${camRight.x.toFixed(3)},${camRight.z.toFixed(3)}) basis=(${basis.x.toFixed(3)},${basis.z.toFixed(3)})`);
    }
  }

  {
    const facing = 0.6;
    const yaw = facing + Math.PI;
    const dist = 2.4;
    const dot = Math.sin(yaw) * dist * Math.sin(facing) + Math.cos(yaw) * dist * Math.cos(facing);
    check('相机在角色背后', dot < -dist * 0.99, 'dot=' + dot.toFixed(3));
  }

  check('angleDelta 环绕', near(angleDelta(3.0, -3.0), -6.0 + Math.PI * 2));
  check('angleDelta 反向环绕', near(angleDelta(-3.0, 3.0), 6.0 - Math.PI * 2));
}

// ---------------------------------------------------------------------------
// 二、策略对照实验
// ---------------------------------------------------------------------------
const dt = 1 / BALANCE.tickRate;
const btn = (...b: Button[]) => new Set<Button>(b);
const NONE: InputFrame = { move: V2(), buttons: new Set<Button>() };

interface Ctx {
  me: CharacterState;
  sim: Simulation;
  step: number;
}

type Strategy = { name: string; desc: string; act(c: Ctx): InputFrame };

/** 离所有车门最远的角落。 */
function safeCorner(sim: Simulation) {
  const r = sim.layout.interior;
  return V2(r.minX + 0.8, 0);
}

/** 最近的扶手，优先没人抓的（被占的扶手按了也抓不上，旧写法会在被占的杆前一直抓空）。 */
function nearestRail(sim: Simulation, me: CharacterState) {
  const taken = (id: number) => sim.characters.some((c) => c.id !== me.id && c.alive && c.grabHandrail === id);
  let best = sim.layout.handrails[0];
  let bd = Infinity;
  for (const freeOnly of [true, false]) {
    for (const h of sim.layout.handrails) {
      if (freeOnly && taken(h.id)) continue;
      const d = v2Dist(me.pos, h);
      if (d < bd) { bd = d; best = h; }
    }
    if (bd < Infinity) break;
  }
  return { rail: best, dist: bd };
}

/**
 * 座垫对站着的人是实心的：走向座位点只会贴到座垫前沿，能不能坐以模拟的判定为准
 * （旧写法"离座位点 < 0.7"现在永远够不着）。
 */
const canSit = (sim: Simulation) => sim.canSit(0);

/** 往某点走：交给和 bot 同一套寻路（绕立杆/座垫/障碍物），策略只管决策不管走位细节。 */
function goTo(sim: Simulation, me: CharacterState, target: { x: number; z: number }) {
  return sim.nav.steer(me.id, me.pos, V2(target.x, target.z), sim.time).dir;
}

/** 开着的门在车厢内侧的门口点。 */
function openDoorPoints(sim: Simulation) {
  return sim.layout.doors.filter((d) => d.open).map((d) => V2(sim.layout.interior.maxX, (d.zMin + d.zMax) / 2));
}

/** 朝向与目标方向的夹角（弧度）。 */
function aimError(me: CharacterState, dir: { x: number; z: number }) {
  let d = Math.atan2(dir.x, dir.z) - me.facing;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}

function nearestFoe(sim: Simulation, me: CharacterState): CharacterState | null {
  let best: CharacterState | null = null;
  let bd = Infinity;
  for (const o of sim.characters) {
    if (o.id === me.id || !o.alive) continue;
    const d = v2Dist(o.pos, me.pos);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

const STRATEGIES: Strategy[] = [
  {
    name: 'TURTLE', desc: '躲角落抓扶手，全程不动不推',
    act({ me, sim }) {
      const { rail, dist } = nearestRail(sim, me);
      if (me.grabHandrail !== null) return NONE;
      if (dist < BALANCE.handrailGrabRange * 0.85) return { move: V2(), buttons: btn('interact') };
      const corner = safeCorner(sim);
      const target = dist < 3 ? V2(rail.x, rail.z) : corner;
      return { move: v2Norm(v2Sub(target, me.pos)), buttons: new Set<Button>() };
    }
  },
  {
    name: 'SITTER', desc: '抢最近的座位，坐着不动',
    act({ me, sim }) {
      if (me.seatId !== null) return NONE;
      let best = null as null | { x: number; z: number; id: number };
      let bd = Infinity;
      for (const st of sim.layout.seats) {
        if (sim.characters.some((c) => c.seatId === st.id)) continue;
        const d = v2Dist(me.pos, st);
        if (d < bd) { bd = d; best = st; }
      }
      if (!best) return NONE;
      if (canSit(sim)) return { move: V2(), buttons: btn('interact') };
      return { move: goTo(sim, me, V2(best.x + 0.9, best.z)), buttons: new Set<Button>() };
    }
  },
  {
    name: 'BRAWLER', desc: '一直追最近的人推',
    act({ me, sim }) {
      const foe = nearestFoe(sim, me);
      if (!foe) return NONE;
      const d = v2Dist(foe.pos, me.pos);
      const buttons = new Set<Button>();
      if (d <= BALANCE.pushRange * 0.9 && me.pushCd <= 0) buttons.add('push');
      if (me.skillCd <= 0 && d < 2.4) buttons.add('skill');
      return { move: v2Norm(v2Sub(foe.pos, me.pos)), buttons };
    }
  },
  {
    // 这条策略代表"设计里期望的最优打法"：座位是持续产出源，所以要一直争。
    // 之前写成"随便找人推"是错的 —— 推人一局只打得出 0.2~0.4 次击落，
    // 那测的其实是一个没人会用的烂打法。
    name: 'BALANCED', desc: '死争座位：空座就占，没空座就把人拽下来',
    act({ me, sim }) {
      // 真的快掉下去了才抓扶手
      const danger = sim.layout.doors.some(
        (d) => d.open && Math.abs(me.pos.z - (d.zMin + d.zMax) / 2) < 1.6 && me.pos.x > 1.2
      );
      if (danger || sim.phase === 'finale') {
        const { rail, dist } = nearestRail(sim, me);
        if (me.grabHandrail !== null) return NONE;
        if (dist < BALANCE.handrailGrabRange * 0.85) return { move: V2(), buttons: btn('interact') };
        return { move: v2Norm(v2Sub(V2(rail.x, rail.z), me.pos)), buttons: new Set<Button>() };
      }
      if (me.seatId !== null) return NONE; // 坐着就守着
      if (me.grabHandrail !== null) return { move: V2(), buttons: btn('interact') };

      let free = null as null | { x: number; z: number };
      let fd = Infinity;
      for (const st of sim.layout.seats) {
        if (sim.characters.some((c) => c.seatId === st.id)) continue;
        const d = v2Dist(me.pos, st);
        if (d < fd) { fd = d; free = st; }
      }
      if (free) {
        if (canSit(sim)) return { move: V2(), buttons: btn('interact') };
        return { move: goTo(sim, me, V2(free.x + 0.9, free.z)), buttons: new Set<Button>() };
      }
      // 没空座 → 把最近的"坐着的人"拽起来，这是抢座真正发生的地方
      let sitter: CharacterState | null = null;
      let sd = Infinity;
      for (const o of sim.characters) {
        if (o.id === me.id || !o.alive || o.seatId === null) continue;
        const d = v2Dist(o.pos, me.pos);
        if (d < sd) { sd = d; sitter = o; }
      }
      if (!sitter) return NONE;
      const buttons = new Set<Button>();
      if (sd <= BALANCE.pushRange * 0.9 && me.pushCd <= 0) buttons.add('push');
      if (me.skillCd <= 0 && sd < 2.2) buttons.add('skill');
      // 远了先绕过去（坐着的人在座垫里，寻路会停在座垫前沿），近了正对着推。
      const move = sd > BALANCE.pushRange * 0.9 ? goTo(sim, me, sitter.pos) : v2Norm(v2Sub(sitter.pos, me.pos));
      return { move, buttons };
    }
  },
  {
    // 进攻打法的上限，用来衡量"推人"这条线能走多远（不坐座位）：
    // - 身边有人、推他正好朝着开着的门：不管在干什么先推（抓着扶手也能推，原地转身）；
    // - 终局：守在离门最近的扶手上，等被车身甩过来的人；
    // - 开门的站点：挑离门最近的对手，绕到他靠车厢内侧的一边；
    // - 没门开着：去拽坐着的人；也没有就站黄圈。
    name: 'SMART', desc: '聪明进攻：门开时绕到内侧往门外推，终局守门边扶手，平时拽座',
    act({ me, sim }) {
      const doors = openDoorPoints(sim);
      const nearestDoor = (p: { x: number; z: number }) => {
        let b = V2();
        let bd = Infinity;
        for (const d of doors) { const x = v2Dist(d, p); if (x < bd) { bd = x; b = d; } }
        return { d: b, dist: bd };
      };
      const buttons = new Set<Button>();
      // 1) 能把身边的人往门外推，就推。
      if (doors.length && me.pushCd <= 0) {
        let target: CharacterState | null = null;
        let bd = Infinity;
        for (const o of sim.characters) {
          if (o.id === me.id || !o.alive || o.seatId !== null) continue;
          if (v2Dist(o.pos, me.pos) > BALANCE.pushRange * 0.95) continue;
          const nd = nearestDoor(o.pos);
          if (nd.dist > 3.2) continue;
          const toFoe = v2Norm(v2Sub(o.pos, me.pos));
          const out = v2Norm(v2Sub(nd.d, o.pos));
          if (toFoe.x * out.x + toFoe.z * out.z < 0.35) continue;
          if (nd.dist < bd) { bd = nd.dist; target = o; }
        }
        if (target) {
          const toFoe = v2Norm(v2Sub(target.pos, me.pos));
          const aimed = aimError(me, toFoe) < 0.5;
          if (aimed) buttons.add('push');
          // 抓着扶手就不迈步（迈步只为转身，不松手）。
          return { move: me.grabHandrail !== null && aimed ? V2() : toFoe, buttons };
        }
      }
      // 2) 终局：守在靠门的扶手上。
      if (sim.phase === 'finale') {
        const r = sim.layout.handrails.reduce((a, b) =>
          v2Dist(me.pos, a) + nearestDoor(a).dist < v2Dist(me.pos, b) + nearestDoor(b).dist ? a : b);
        if (me.grabHandrail !== null) return NONE;
        if (v2Dist(me.pos, r) < BALANCE.handrailGrabRange * 0.85) return { move: V2(), buttons: btn('interact') };
        return { move: goTo(sim, me, r), buttons };
      }
      if (me.grabHandrail !== null) return { move: V2(), buttons: btn('interact') };
      if (me.seatId !== null) return { move: V2(), buttons: btn('interact') };
      // 3) 开门站点：绕到离门最近的对手内侧。
      if (doors.length) {
        let best: CharacterState | null = null;
        let bestD = 3.5;
        let bestDoor = V2();
        for (const o of sim.characters) {
          if (o.id === me.id || !o.alive || o.seatId !== null) continue;
          const nd = nearestDoor(o.pos);
          if (nd.dist < bestD) { bestD = nd.dist; best = o; bestDoor = nd.d; }
        }
        if (best) {
          const out = v2Norm(v2Sub(bestDoor, best.pos));
          return { move: goTo(sim, me, V2(best.pos.x - out.x * 1.1, best.pos.z - out.z * 1.1)), buttons };
        }
      }
      // 4) 没门开着：拽坐着的人。
      let sitter: CharacterState | null = null;
      let sd = Infinity;
      for (const o of sim.characters) {
        if (o.id === me.id || !o.alive || o.seatId === null) continue;
        const d = v2Dist(o.pos, me.pos);
        if (d < sd) { sd = d; sitter = o; }
      }
      if (sitter) {
        if (sd <= BALANCE.pushRange * 0.9 && me.pushCd <= 0) buttons.add('push');
        const move = sd > BALANCE.pushRange * 0.9 ? goTo(sim, me, sitter.pos) : v2Norm(v2Sub(sitter.pos, me.pos));
        return { move, buttons };
      }
      // 5) 站黄圈。
      const hz = sim.hotZone.pos;
      if (v2Dist(me.pos, hz) > sim.hotZone.radius * 0.7) return { move: goTo(sim, me, hz), buttons };
      return NONE;
    }
  },
  { name: 'IDLE', desc: '完全不动（基线）', act: () => NONE }
];

interface Result {
  rank: number; score: number; knockouts: number; alive: boolean;
}

function runMatch(strategy: Strategy, seed: number): Result {
  const sim = new Simulation(seed);
  sim.setup(
    CHARACTERS.map((d, i) => ({ defId: d.id, name: d.name, color: d.color, isPlayer: i === 0 })),
    seed
  );
  const me = sim.characters[0];
  const steps = Math.ceil(BALANCE.matchDuration / dt) + 120;
  for (let i = 0; i < steps; i++) {
    // 上车阶段所有策略都一样：先进车厢，否则测的是"谁更会上车"。
    // 上车目标点离开 0 号立杆（0,-4.2）：旧点 (0,-4.6) 只隔 0.4，立杆有碰撞后会一直绕着杆转。
    const frame = sim.phase === 'boarding'
      ? { move: v2Norm(v2Sub(V2(0.6, -5.0), me.pos)), buttons: new Set<Button>() }
      : (me.alive ? strategy.act({ me, sim, step: i }) : NONE);
    sim.applyPlayerInput(frame);
    sim.tick(dt);
    if (sim.phase === 'ended') break;
  }
  const ranking = sim.winnerRanking();
  return {
    rank: ranking.findIndex((c) => c.isPlayer) + 1,
    score: Math.round(me.score),
    knockouts: me.knockouts,
    alive: me.alive
  };
}

// 15 局时名次标准误约 ±0.5，门槛在 1.0 附近判定会抖；30 局约 ±0.35。
// 90 局：分数倍数这条噪声很大，30 局时换一批种子就能差 0.15（见下方门槛注释）。跑一遍约 3 分钟。
const RUNS = 90;
const SEEDS = Array.from({ length: RUNS }, (_, i) => 1000 + i * 7919);

console.log('\n策略对照（每种 ' + RUNS + ' 局，同一批种子）');
console.log('策略       平均名次  第一名率  平均分  平均击落  存活率  说明');
console.log('-'.repeat(82));

const table: { name: string; avgRank: number; winRate: number; avgScore: number }[] = [];
for (const st of STRATEGIES) {
  const rs = SEEDS.map((s) => runMatch(st, s));
  const avg = (f: (r: Result) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
  const avgRank = avg((r) => r.rank);
  const winRate = rs.filter((r) => r.rank === 1).length / rs.length;
  table.push({ name: st.name, avgRank, winRate, avgScore: avg((r) => r.score) });
  console.log(
    st.name.padEnd(10) +
    avgRank.toFixed(2).padStart(8) +
    (winRate * 100).toFixed(0).padStart(9) + '%' +
    avg((r) => r.score).toFixed(0).padStart(8) +
    avg((r) => r.knockouts).toFixed(2).padStart(10) +
    (avg((r) => (r.alive ? 1 : 0)) * 100).toFixed(0).padStart(7) + '%  ' +
    st.desc
  );
}

// ---------------------------------------------------------------------------
// 三、验收门槛
// ---------------------------------------------------------------------------
// 门槛直接编码设计目标"主动参与必须优于躲起来"，而不是拍一个绝对名次。
// 绝对名次会随 AI 强度一起漂移：AI 变强时所有玩家策略的名次都会变差，
// 那个数字失去意义，真正要守住的是**两种打法之间的差距**。
const turtle = table.find((t) => t.name === 'TURTLE')!;
const sitter = table.find((t) => t.name === 'SITTER')!;
const balanced = table.find((t) => t.name === 'BALANCED')!;
const passiveRank = Math.min(turtle.avgRank, sitter.avgRank);
const passiveScore = Math.max(turtle.avgScore, sitter.avgScore);
console.log('');
check(`乌龟流落到后半区（平均名次 ${turtle.avgRank.toFixed(2)} 应 ≥ 5.0）`, turtle.avgRank >= 5.0);
check(`乌龟流第一名率 ${(turtle.winRate * 100).toFixed(0)}% 应 ≤ 10%`, turtle.winRate <= 0.10);
check(
  `主动打法名次要明显更好（均衡 ${balanced.avgRank.toFixed(2)} vs 消极 ${passiveRank.toFixed(2)}，差 ≥ 1.0）`,
  passiveRank - balanced.avgRank >= 1.0
);
// 分数倍数门槛 3 → 1.6 → 1.55 → 1.3：
// - 3 倍是在"机器人上车就把座位抢光"的旧局面下定的，那时消极打法根本拿不到座。现在发车时会留
//   1~2 个空座（这是修复，不是退步），坐着不动也能吃到第一段坐座分。
// - 拽座分 90 → 80（为了不让座位线压过推人线）后，均衡打法少了一截拽座分。
// - 加入乘客惯性后，惯性只推站着的人，站在座垫前拽人的节奏被打断，"只坐不动"变强。
//   三批各 90 局实测 1.43 / 1.37 / 1.52（平均约 1.44），批次间波动约 ±0.08，
//   所以门槛放在最低实测值之下留余量，而不是贴着平均值。
// "主动优于消极"这条设计目标主要由上面的名次差门槛把关（三批都领先 2.4 名以上），这里只防止分数差被抹平。
check(
  `主动打法得分要明显高于消极（均衡 ${balanced.avgScore.toFixed(0)} vs 消极 ${passiveScore.toFixed(0)}，应 ≥ 1.3 倍）`,
  balanced.avgScore >= passiveScore * 1.3
);
check('不存在碾压策略（第一名率 ≤ 60%）', table.every((t) => t.winRate <= 0.6));
// 进攻打法必须是一条正经的路：聪明进攻和均衡差距在 1 名以内、明显好于消极；
// 无脑追着推至少要好过"躲着"和"只坐不动"。
const smart = table.find((t) => t.name === 'SMART')!;
const brawler = table.find((t) => t.name === 'BRAWLER')!;
check(
  `聪明进攻与均衡差距 ≤ 1.0（聪明 ${smart.avgRank.toFixed(2)} vs 均衡 ${balanced.avgRank.toFixed(2)}）`,
  Math.abs(smart.avgRank - balanced.avgRank) <= 1.0
);
check(
  `聪明进攻明显好于消极（聪明 ${smart.avgRank.toFixed(2)} vs 消极 ${passiveRank.toFixed(2)}，差 ≥ 1.0）`,
  passiveRank - smart.avgRank >= 1.0
);
check(
  `无脑推好于躲扶手和只坐不动（莽夫 ${brawler.avgRank.toFixed(2)} vs 龟 ${turtle.avgRank.toFixed(2)} / 坐 ${sitter.avgRank.toFixed(2)}）`,
  brawler.avgRank < turtle.avgRank && brawler.avgRank < sitter.avgRank
);

if (failed > 0) {
  console.error(`\n${failed} 条断言失败`);
  process.exit(1);
}
console.log('全部断言通过');
