import { V2, v2Dist, type Vec2 } from '../core/math';
import { distToRect, POLE_RADIUS, type BusLayout, type Rect } from './layout';

/**
 * 车厢内的静态寻路。
 *
 * 立杆和实心座垫加进碰撞之后，"朝目标直线走"会出现两类卡死：
 * 1. 正对杆心顶上去（切向分量为 0，碰撞只会把人推回原地）；
 * 2. 杆和障碍物之间的缝比角色直径窄时，直线穿缝的人会卡在"V 形口"里，
 *    永远以为再走一步就过去了（布局已经把过道里的这类缝都拓宽到 ≥ 1.16，
 *    但行李、别人、贴墙的凹口仍会形成临时的窄口）。
 * 第 1 类由 simulation 里的切向滑移兜底；第 2 类必须真的绕路，所以 bot 走这里。
 *
 * 做法：把车厢切成 0.05m 的格子，按角色半径膨胀所有静态障碍（墙、靠背、座垫、
 * 固定障碍物、填充体、立杆），得到"角色中心能站的格子"；A* 求路（离障碍越近代价越高，
 * 路径尽量走通道中间），再按视线往前挑最远的可直达路点，走出来是顺的折线而不是锯齿。
 * 门、别的角色不进网格（挤就是玩法）；实心行李作为临时障碍查询时现算。
 *
 * 为什么是 0.05m：通路宽度常常只比角色直径多几厘米（行李刷在过道里、两杆之间站着人），
 * 0.2m 的格子表示不出这种缝，会把本来走得通的区域判成"不可达"，bot 退回直线就顶死在
 * V 形口里（旧布局下实测过）。0.1m 勉强连通，0.05m 稳定连通。
 */

const CELL = 0.05;
/** 膨胀余量：比角色半径多留一点，避免路径贴着刀刃走；不能大，否则上面那条斜缝会被堵死。 */
const MARGIN = 0.01;
/** 缓存的路径多久强制重算一次（秒）。 */
const REPLAN_EVERY = 0.5;
/** 同一个 bot 两次重算之间至少隔这么久（追移动目标时目标格每帧都在变）。 */
const REPLAN_MIN = 0.2;
/** 视线前瞻：沿路径最多往前看这么远挑直达点（米）。 */
const LOOKAHEAD = 2.5;
/**
 * 计算预算：每个模拟步最多重算这么多条路径，其余 bot 沿用旧路径、排到下一步优先算。
 * 以前多个 bot 同一帧重算，单步最长 5~7ms（Node 实测），一帧就掉了。
 * 1 条就够：7 个 bot 正常每秒只需重算约 14 次（每人 0.5 秒一次），预算每秒 60 次。
 * 150 局实测（同一份代码）：预算 1 时 >2ms 的步 1 个，预算 2 时 25 个，卡死次数无差别。
 */
export const REPLANS_PER_STEP = 1;
/**
 * 单次 A* 最多展开这么多格（约 0.7ms）。超了就返回"离目标最近的那一段"，
 * bot 先走过去，下次再从更近处接着算 —— 长路径被拆成几段，不会单帧卡顿。
 * 实测不封顶时 p99 4700 格、最多 6600 格（约 2.5ms）。
 */
const MAX_EXPAND = 3000;
/** 启发式加权：略牺牲最优性（路径长一点点），换展开格数大幅下降。 */
const H_WEIGHT = 1.3;
/** 到投影后的目标点这么近就算到了，停下不再"想走"。 */
export const ARRIVE_DIST = 0.12;

interface PlanCache {
  goalCell: number;
  path: number[];
  at: number;
}

export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  private readonly x0: number;
  private readonly z0: number;
  private readonly free: Uint8Array;
  /** 每格离最近不可站格的距离（格数，封顶 8），用来让路径远离障碍。 */
  private readonly clearance: Uint8Array;
  private cache = new Map<number, PlanCache>();
  private readonly need: number;
  // A* / BFS 的复用缓冲：用"代数"标记代替每次清零，避免每帧分配几十 KB。
  private readonly gScore: Float32Array;
  private readonly came: Int32Array;
  private readonly stamp: Uint32Array;
  private readonly closedStamp: Uint32Array;
  private gen = 0;
  /** 本步剩余的重算次数；上一步被推迟、本步优先的 bot；本步被推迟的 bot。 */
  private budget = Infinity;
  private priority = new Set<number>();
  private deferred = new Set<number>();
  /** 临时障碍（实心行李），每帧由模拟更新。 */
  private dynamic: Rect[] = [];

  constructor(private layout: BusLayout, radius: number) {
    const r = layout.interior;
    this.x0 = r.minX;
    this.z0 = r.minZ;
    this.cols = Math.ceil((r.maxX - r.minX) / CELL);
    this.rows = Math.ceil((r.maxZ - r.minZ) / CELL);
    this.free = new Uint8Array(this.cols * this.rows);
    const need = radius + MARGIN;
    this.need = need;
    const rects: Rect[] = [
      ...layout.seats.map((s) => s.backRect),
      ...layout.seats.map((s) => s.cushion),
      ...layout.obstacles.map((o) => o.rect),
      ...layout.fillers
    ];
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const p = this.center(i, j);
        let ok = p.x - r.minX >= need && r.maxX - p.x >= need && p.z - r.minZ >= need && r.maxZ - p.z >= need;
        if (ok) ok = rects.every((rc) => distToRect(p, rc) >= need);
        if (ok) ok = layout.handrails.every((h) => v2Dist(p, h) >= need + POLE_RADIUS);
        this.free[j * this.cols + i] = ok ? 1 : 0;
      }
    }
    const n = this.cols * this.rows;
    this.gScore = new Float32Array(n);
    this.came = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closedStamp = new Uint32Array(n);
    // 离障碍的格距：从所有不可站格出发做多源 BFS（切比雪夫距离）。
    this.clearance = new Uint8Array(n).fill(8);
    let frontier: number[] = [];
    for (let c = 0; c < n; c++) if (!this.free[c]) { this.clearance[c] = 0; frontier.push(c); }
    for (let d = 1; d < 8 && frontier.length; d++) {
      const next: number[] = [];
      for (const c of frontier) {
        const ci = c % this.cols;
        const cj = Math.floor(c / this.cols);
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ni = ci + di;
            const nj = cj + dj;
            if (ni < 0 || nj < 0 || ni >= this.cols || nj >= this.rows) continue;
            const nb = nj * this.cols + ni;
            if (this.clearance[nb] > d) { this.clearance[nb] = d; next.push(nb); }
          }
        }
      }
      frontier = next;
    }
  }

  reset() {
    this.cache.clear();
    this.dynamic = [];
    this.budget = Infinity;
    this.priority = new Set();
    this.deferred = new Set();
  }

  /**
   * 开始新的一个模拟步：重算预算回满，上一步被推迟的 bot 本步优先。
   * 由 Simulation 在每步结束时调用（下一步的玩家输入和 bot 决策共用这份预算）。
   */
  beginStep(maxReplans: number = REPLANS_PER_STEP) {
    this.priority = this.deferred;
    this.deferred = new Set();
    this.budget = maxReplans;
  }

  /** 登记本帧的临时障碍（行李只存在几秒，不重建网格，查询时现算）。 */
  setDynamic(rects: Rect[]) {
    this.dynamic = rects;
  }

  /** 格子可站：静态可站，且不压在临时障碍上。 */
  private ok(c: number): boolean {
    if (!this.free[c]) return false;
    if (!this.dynamic.length) return true;
    const p = this.centerOf(c);
    return this.dynamic.every((r) => distToRect(p, r) >= this.need);
  }

  private center(i: number, j: number): Vec2 {
    return V2(this.x0 + (i + 0.5) * CELL, this.z0 + (j + 0.5) * CELL);
  }

  private cellOf(p: Vec2): number {
    const i = Math.min(this.cols - 1, Math.max(0, Math.floor((p.x - this.x0) / CELL)));
    const j = Math.min(this.rows - 1, Math.max(0, Math.floor((p.z - this.z0) / CELL)));
    return j * this.cols + i;
  }

  private centerOf(c: number): Vec2 {
    return this.center(c % this.cols, Math.floor(c / this.cols));
  }

  /** 点在车厢网格覆盖范围内（站台上的人不归这里管）。 */
  covers(p: Vec2): boolean {
    const r = this.layout.interior;
    return p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ;
  }

  /** 离 c 最近的可站格（BFS，按实际距离取最近）。 */
  private nearestFree(c: number, from: Vec2): number {
    if (this.ok(c)) return c;
    const g = ++this.gen;
    const seen = this.stamp;
    let frontier = [c];
    seen[c] = g;
    for (let ring = 0; ring < 40 && frontier.length; ring++) {
      let best = -1;
      let bestD = Infinity;
      const next: number[] = [];
      for (const f of frontier) {
        const fi = f % this.cols;
        const fj = Math.floor(f / this.cols);
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ni = fi + di;
            const nj = fj + dj;
            if (ni < 0 || nj < 0 || ni >= this.cols || nj >= this.rows) continue;
            const n = nj * this.cols + ni;
            if (seen[n] === g) continue;
            seen[n] = g;
            if (this.ok(n)) {
              const d = v2Dist(this.centerOf(n), from);
              if (d < bestD) { bestD = d; best = n; }
            } else {
              next.push(n);
            }
          }
        }
      }
      if (best >= 0) return best;
      frontier = next;
    }
    return c;
  }

  /** 线段是否整段落在可站格里（按半格步长采样）。 */
  private clear(a: Vec2, b: Vec2): boolean {
    const d = v2Dist(a, b);
    const n = Math.max(1, Math.ceil(d / (CELL * 0.5)));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const p = V2(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      if (!this.covers(p) || !this.ok(this.cellOf(p))) return false;
    }
    return true;
  }

  /** 8 邻接 A*，不允许斜穿被挡住的拐角。 */
  private astar(start: number, goal: number): number[] {
    if (start === goal) return [goal];
    const gen = ++this.gen;
    const g = this.gScore;
    const came = this.came;
    const seen = this.stamp;
    const closed = this.closedStamp;
    const G = (c: number) => (seen[c] === gen ? g[c] : Infinity);
    const heap = new MinHeap();
    const gx = goal % this.cols;
    const gz = Math.floor(goal / this.cols);
    const h = (c: number) => {
      const dx = Math.abs((c % this.cols) - gx);
      const dz = Math.abs(Math.floor(c / this.cols) - gz);
      return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
    };
    // 离目标最近的已展开格：展开数超限或目标不可达时，返回到它为止的那一段。
    let bestNode = start;
    let bestH = h(start);
    let expanded = 0;
    g[start] = 0;
    came[start] = -1;
    seen[start] = gen;
    heap.push(start, h(start) * H_WEIGHT);
    let found = false;
    while (heap.size) {
      const cur = heap.pop();
      if (cur === goal) { found = true; break; }
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      const hc = h(cur);
      if (hc < bestH) { bestH = hc; bestNode = cur; }
      if (++expanded > MAX_EXPAND) break;
      const ci = cur % this.cols;
      const cj = Math.floor(cur / this.cols);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = ci + di;
          const nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= this.cols || nj >= this.rows) continue;
          const nb = nj * this.cols + ni;
          if (closed[nb] === gen || !this.ok(nb)) continue;
          if (di && dj && (!this.ok(cj * this.cols + ni) || !this.ok(nj * this.cols + ci))) continue;
          // 贴着障碍走要多付代价：路径尽量走通道中间，只有真没别的路才去挤窄缝。
          const hug = Math.max(0, 4 - this.clearance[nb]) * 0.35;
          const ng = g[cur] + (di && dj ? Math.SQRT2 : 1) + hug;
          if (ng < G(nb)) {
            g[nb] = ng;
            seen[nb] = gen;
            came[nb] = cur;
            heap.push(nb, ng + h(nb) * H_WEIGHT);
          }
        }
      }
    }
    const end = found ? goal : bestNode;
    if (end === start) return [];
    const path: number[] = [];
    for (let c = end; c !== -1 && c !== start; c = came[c]) path.push(c);
    return path.reverse();
  }

  /**
   * 从 pos 去 target 的下一步方向（单位向量）。
   * target 落在障碍里（比如立杆本身、坐着的人所在的座位点）会被投影到最近的可站格：
   * 人会走到杆边、座垫前沿停下，而不是一直顶着。
   * 返回 arrived=true 表示已经到了投影后的目标，调用方应停下。
   */
  steer(id: number, pos: Vec2, target: Vec2, time: number): { dir: Vec2; arrived: boolean } {
    if (!this.covers(pos)) return { dir: unit(target.x - pos.x, target.z - pos.z), arrived: false };
    const rawGoal = this.cellOf(target);
    const goalCell = this.nearestFree(rawGoal, target);
    const goalPt = this.ok(rawGoal) && this.covers(target) ? target : this.centerOf(goalCell);
    if (v2Dist(pos, goalPt) < ARRIVE_DIST) return { dir: V2(), arrived: true };
    // 能直达就直走：绝大多数情况走这条，零开销。
    if (this.clear(pos, goalPt)) return { dir: unit(goalPt.x - pos.x, goalPt.z - pos.z), arrived: false };

    const startCell = this.nearestFree(this.cellOf(pos), pos);
    let plan = this.cache.get(id);
    const stale = !plan || time - plan.at > REPLAN_EVERY
      || (plan.goalCell !== goalCell && time - plan.at > REPLAN_MIN);
    if (stale) {
      // 预算：上一步被推迟的先算；其余人只有在预算比"排队的人数"多时才能插队。
      const mayPlan = this.budget > 0 && (this.priority.has(id) || this.budget > this.priority.size);
      if (mayPlan) {
        this.budget--;
        this.priority.delete(id);
        plan = { goalCell, path: this.astar(startCell, goalCell), at: time };
        this.cache.set(id, plan);
      } else {
        // 轮不到：沿用旧路径；一条都没有就先朝目标直走一步，下一步优先重算。
        this.deferred.add(id);
        if (!plan) return { dir: unit(goalPt.x - pos.x, goalPt.z - pos.z), arrived: false };
      }
    }
    plan = plan!;
    // 真不可达（目标投影落进了封闭的小口袋）：原地等下一次重算，别朝着墙顶。
    if (!plan.path.length) return { dir: V2(), arrived: true };
    // 丢掉已经走过的路点，然后沿路径往前找最远的可直达点。
    const here = plan.path.indexOf(startCell);
    if (here >= 0) plan.path = plan.path.slice(here + 1);
    let aim = plan.path.length ? this.centerOf(plan.path[0]) : goalPt;
    const far = Math.min(plan.path.length - 1, Math.round(LOOKAHEAD / CELL));
    for (let k = far; k >= 0; k -= 3) {
      const wp = k === plan.path.length - 1 ? goalPt : this.centerOf(plan.path[k]);
      if (this.clear(pos, wp)) { aim = wp; break; }
    }
    return { dir: unit(aim.x - pos.x, aim.z - pos.z), arrived: false };
  }

  /** 点所在格是否可站（含临时障碍）。 */
  isFree(p: Vec2): boolean {
    return this.covers(p) && this.ok(this.cellOf(p));
  }
}

function unit(x: number, z: number): Vec2 {
  const l = Math.hypot(x, z);
  return l < 1e-6 ? V2() : V2(x / l, z / l);
}

/** 二叉最小堆（A* 开放表）。 */
class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size() { return this.ids.length; }
  push(id: number, key: number) {
    this.ids.push(id);
    this.keys.push(key);
    let i = this.ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): number {
    const top = this.ids[0];
    const lastId = this.ids.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.ids.length) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.ids.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.ids.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}
