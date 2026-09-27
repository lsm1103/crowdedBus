import type { Vec2 } from '../core/math';

/** 轴对齐矩形（XZ 平面）。 */
export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Door {
  id: 'front' | 'back';
  zMin: number;
  zMax: number;
  /** 当前是否打开（打开时该墙缺口可通行且危险）。 */
  open: boolean;
}

export interface Handrail {
  id: number;
  x: number;
  z: number;
}

/**
 * 座位（docs/08 第 6.3 节）。
 *
 * 坐着的人最稳：免疫机关和推挤，但不能出手；别人抓住他不放 1 秒就能把他拽起来。
 * 座垫对"没坐在这个座位上的人"是实心的，靠背始终参与碰撞。
 */
export interface Seat {
  id: number;
  /** single = 单人座；bench = 后排长椅的一格（建模时连成一条）。 */
  kind: 'single' | 'bench';
  /** 坐上去之后角色被钉在这个点（座垫中心）。 */
  x: number;
  z: number;
  /** 坐着时的朝向（弧度，0 = +z 车头方向，π/2 = +x 车门一侧）。 */
  facing: number;
  /** 朝向的单位向量：站着的人从这一侧接近、起身时从这一侧落脚。 */
  front: Vec2;
  /** 座垫：对没坐在上面的人是实心的；范围与车模一致。 */
  cushion: Rect;
  /** 靠背：在朝向的反侧，始终参与碰撞。 */
  backRect: Rect;
}

export type ObstacleKind = 'luggage' | 'stroller' | 'bin' | 'wheelwell';

/** 车厢里的固定障碍物：挡路、断视野、让走位真的要绕。 */
export interface Obstacle {
  id: number;
  kind: ObstacleKind;
  rect: Rect;
  /** 视觉高度（世界格）。 */
  height: number;
}

/** 车厢布局（单位：世界格，对应 docs/03 灰盒）。 */
export interface BusLayout {
  interior: Rect;
  /** 站台（仅上车阶段可通行），与后门缺口对齐。 */
  platform: Rect;
  doors: Door[];
  seats: Seat[];
  handrails: Handrail[];
  obstacles: Obstacle[];
  /**
   * 不可见的碰撞填充体：封死"缝比角色直径还窄"的死角。
   * 这种死角里没有任何一个位置能同时满足所有碰撞约束，角色一旦被挤进去，
   * 求解器会在几面墙之间来回推、永远出不来；干脆让它整块不可进入。
   */
  fillers: Rect[];
  spawn: Vec2[];
}

/**
 * 车厢比初版更窄更短（5.4x15 → 4.7x12.4）。
 * 配合放大后的角色半径，同样 8 个人的占地比例翻了一倍多，"挤"才成立。
 */
export const INTERIOR: Rect = { minX: -2.35, maxX: 2.35, minZ: -6.2, maxZ: 6.2 };

/** 靠背厚度。 */
const BACK_T = 0.18;

/** 按座垫范围和朝向生成座位；靠背贴在朝向的反侧。 */
function seat(id: number, kind: Seat['kind'], cushion: Rect, dir: '+z' | '+x'): Seat {
  const x = (cushion.minX + cushion.maxX) / 2;
  const z = (cushion.minZ + cushion.maxZ) / 2;
  const backRect: Rect = dir === '+z'
    ? { minX: cushion.minX, maxX: cushion.maxX, minZ: cushion.minZ - BACK_T, maxZ: cushion.minZ }
    : { minX: cushion.minX - BACK_T, maxX: cushion.minX, minZ: cushion.minZ, maxZ: cushion.maxZ };
  return {
    id, kind, x, z,
    facing: dir === '+z' ? 0 : Math.PI / 2,
    front: dir === '+z' ? { x: 0, z: 1 } : { x: 1, z: 0 },
    cushion, backRect
  };
}

export const PLATFORM: Rect = { minX: 2.35, maxX: 6.0, minZ: -5.2, maxZ: -3.4 };

export const LAYOUT: BusLayout = {
  interior: INTERIOR,
  platform: PLATFORM,
  doors: [
    { id: 'front', zMin: 3.4, zMax: 5.2, open: false },
    { id: 'back', zMin: -5.2, zMax: -3.4, open: true }
  ],
  // 按国内城市公交的布局：前部左侧两个朝前的单人座，中部左侧一个朝过道的单人座，
  // 后排三连长椅。中部是开阔的站立区（主战场），路人乘客也会来抢座。
  seats: [
    seat(0, 'single', { minX: -2.30, maxX: -1.40, minZ: 4.50, maxZ: 5.40 }, '+z'),
    seat(1, 'single', { minX: -2.30, maxX: -1.40, minZ: 3.25, maxZ: 4.15 }, '+z'),
    seat(2, 'single', { minX: -2.32, maxX: -1.42, minZ: 0.20, maxZ: 1.20 }, '+x'),
    seat(3, 'bench', { minX: -2.30, maxX: -1.40, minZ: -5.98, maxZ: -5.10 }, '+z'),
    seat(4, 'bench', { minX: -1.40, maxX: -0.50, minZ: -5.98, maxZ: -5.10 }, '+z'),
    seat(5, 'bench', { minX: -0.50, maxX: 0.40, minZ: -5.98, maxZ: -5.10 }, '+z')
  ],
  // 只有 6 根扶手、8 个人：抓扶手是稀缺资源，得抢。
  handrails: [
    { id: 0, x: 0, z: -4.2 },
    { id: 1, x: 0, z: -2.1 },
    { id: 2, x: 0, z: 0 },
    { id: 3, x: 0, z: 2.1 },
    { id: 4, x: 0, z: 4.2 },
    { id: 5, x: 1.45, z: 0 }
  ],
  // 车厢里的"障碍物"改由路人乘客承担，固定障碍只留前门旁的投币箱。
  obstacles: [
    { id: 0, kind: 'bin', rect: { minX: 0.95, maxX: 1.55, minZ: 2.85, maxZ: 3.4 }, height: 0.86 }
  ],
  fillers: [],
  /**
   * 站台出生点，**按离后门由近到远排列**。
   * 玩家固定是 0 号，之前这个数组是由远到近，等于玩家每局都从最远的位置起步、
   * 最后一个上车、座位永远被抢光 —— probe 里所有策略的名次都卡在 6.5~7 就是这么来的。
   */
  spawn: [
    { x: 3.4, z: -4.3 },
    { x: 3.7, z: -3.7 },
    { x: 3.9, z: -4.9 },
    { x: 4.3, z: -4.1 },
    { x: 4.6, z: -4.8 },
    { x: 4.9, z: -3.8 },
    { x: 5.2, z: -4.6 },
    { x: 5.5, z: -4.0 }
  ]
};

/** 站台外侧护栏，防止上车阶段走出世界。 */
export const PLATFORM_FENCE: Rect = { minX: 6.0, maxX: 6.3, minZ: -5.2, maxZ: -3.4 };

/**
 * 上车阶段的站台围栏（前后两侧）。
 * 8 个人同时冲后门会互相推挤，没有围栏就会在开局把同伴挤下站台判成淘汰。
 */
export function boardingFence(): Rect[] {
  return [
    { minX: 2.35, maxX: 6.3, minZ: -5.5, maxZ: -5.2 },
    { minX: 2.35, maxX: 6.3, minZ: -3.4, maxZ: -3.1 }
  ];
}

/** 车厢墙体（不含门缺口）。门由调用方决定是否补墙。 */
export function baseWalls(): Rect[] {
  const d = LAYOUT.doors;
  return [
    { minX: -2.65, maxX: -2.35, minZ: -6.7, maxZ: 6.7 }, // 远侧墙
    { minX: 2.35, maxX: 2.65, minZ: -6.7, maxZ: d[1].zMin }, // 近侧墙·后段
    { minX: 2.35, maxX: 2.65, minZ: d[1].zMax, maxZ: d[0].zMin }, // 近侧墙·中段
    { minX: 2.35, maxX: 2.65, minZ: d[0].zMax, maxZ: 6.7 }, // 近侧墙·前段
    { minX: -2.65, maxX: 2.65, minZ: -6.7, maxZ: -6.4 }, // 车尾
    { minX: -2.65, maxX: 2.65, minZ: 6.4, maxZ: 6.7 } // 车头
  ];
}

/** 立杆碰撞半径（车模立杆视觉半径 0.045）。 */
export const POLE_RADIUS = 0.05;

/** 点到矩形的距离（点在矩形内为 0）。 */
export function distToRect(p: Vec2, r: Rect): number {
  const dx = Math.max(r.minX - p.x, 0, p.x - r.maxX);
  const dz = Math.max(r.minZ - p.z, 0, p.z - r.maxZ);
  return Math.hypot(dx, dz);
}

/**
 * 站着的人在座垫前沿外的站位（坐下前的接近点、起身后的落脚点）。
 * 沿座位朝向，从座垫前沿再往外 radius + margin。
 */
export function seatFrontPoint(seat: Seat, radius: number, margin = 0.03): Vec2 {
  const c = seat.cushion;
  const halfDepth = seat.front.x !== 0 ? (c.maxX - c.minX) / 2 : (c.maxZ - c.minZ) / 2;
  const d = halfDepth + radius + margin;
  return { x: seat.x + seat.front.x * d, z: seat.z + seat.front.z * d };
}

// ---------------------------------------------------------------------------
// 以下为规则层新增的派生点位（只读 LAYOUT，不改任何已有坐标）。
// ---------------------------------------------------------------------------

/** 门洞中线的 z。 */
export function doorCenterZ(d: Door): number {
  return (d.zMin + d.zMax) / 2;
}

/**
 * 半径 radius 的站着的人能不能站在 p：在车厢内、不压座垫/靠背/障碍物/填充体/立杆。
 * 车厢边界按 INTERIOR 算（与寻路网格同一口径，比车墙碰撞更保守）。
 */
export function standable(p: Vec2, radius: number, margin = 0.02): boolean {
  const r = INTERIOR;
  const need = radius + margin;
  if (p.x - r.minX < need || r.maxX - p.x < need || p.z - r.minZ < need || r.maxZ - p.z < need) return false;
  for (const s of LAYOUT.seats) {
    if (distToRect(p, s.cushion) < need || distToRect(p, s.backRect) < need) return false;
  }
  for (const o of LAYOUT.obstacles) if (distToRect(p, o.rect) < need) return false;
  for (const f of LAYOUT.fillers) if (distToRect(p, f) < need) return false;
  for (const h of LAYOUT.handrails) {
    if (Math.hypot(p.x - h.x, p.z - h.z) < need + POLE_RADIUS) return false;
  }
  return true;
}

/**
 * 坐下前的接近点 / 起身后的落脚点。
 *
 * 首选 seatFrontPoint（沿朝向正前方）。但新布局里有三个座位的正前方站不了人：
 * - 0 号：座垫前沿到车头只剩 0.8 格，比角色直径 1.0 窄；
 * - 1 号：正前方是 0 号座的靠背和座垫（前后排腿部空间只有 0.17）；
 * - 5 号：正前方压在 0 号立杆上。
 * 这时依次试：从过道一侧（+x）贴着座垫接近、沿座垫前沿左右挪半个身位。
 * 返回的点保证 standable，且到座垫边缘 ≤ SEAT.reachEdge（贴上去就能坐）。
 */
export function seatApproachPoint(seat: Seat, radius: number): Vec2 {
  const c = seat.cushion;
  const margin = 0.03;
  const cands: Vec2[] = [seatFrontPoint(seat, radius, margin)];
  if (seat.front.z !== 0) {
    // 朝车头的座位：过道在 +x 一侧。
    cands.push({ x: c.maxX + radius + margin, z: seat.z });
    const f = cands[0];
    cands.push({ x: f.x + 0.45, z: f.z }, { x: f.x - 0.45, z: f.z });
  } else {
    // 朝过道的座位：两侧是 ±z。
    cands.push({ x: seat.x, z: c.maxZ + radius + margin }, { x: seat.x, z: c.minZ - radius - margin });
    const f = cands[0];
    cands.push({ x: f.x, z: f.z + 0.45 }, { x: f.x, z: f.z - 0.45 });
  }
  for (const p of cands) if (standable(p, radius, -0.01)) return p;
  return cands[0];
}

/**
 * 路人乘客站着的位置（站立区）。
 * 彼此 ≥ 1.0、离立杆/座位/车壁留足余量、离所有座位的接近点 ≥ 1.0（不堵座位），
 * 不站在两扇门的正前方（门口是主战场，留给玩家打）。
 */
export const NPC_SPOTS: readonly Vec2[] = [
  { x: -1.35, z: -3.3 },
  { x: -1.4, z: -1.6 },
  { x: 1.55, z: -2.3 },
  { x: 0.85, z: -1.05 },
  { x: 1.6, z: 1.25 },
  { x: -1.45, z: 1.95 },
  { x: -0.6, z: 2.6 },
  { x: 0.9, z: 5.6 },
  { x: -0.95, z: -0.55 },
  { x: 1.65, z: 2.35 }
];
