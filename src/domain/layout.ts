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
 * 座位。
 *
 * 以前 seats 只是一堆碰撞矩形，角色被 resolveCircleRect 直接推开，根本坐不上去 ——
 * slogan 写着「抢位置」，而抢位置是假的。现在座面可通行、只有靠背挡人，
 * 座位本身成为可占据的稀缺产出源。
 */
export interface Seat {
  id: number;
  kind: 'normal' | 'priority';
  /** 坐上去之后角色被钉在这个点。 */
  x: number;
  z: number;
  /** 坐着时的朝向（面朝过道）。 */
  facing: number;
  /** 座位占地（旧字段，导出给建模脚本用，碰撞不再读它）。 */
  rect: Rect;
  /** 靠背：参与碰撞。 */
  backRect: Rect;
  /**
   * 座垫：对"没坐在这个座位上的人"是实心的。
   * 范围和车模里的座垫视觉一致（x∈[-2.32,-1.42]、z∈[z-0.49, z+0.49]，顶面 y=0.46）。
   * 以前座面可以直接穿过去，站着的人会和坐着的人叠在同一张椅子上。
   */
  cushion: Rect;
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

/** 座位沿远侧车壁排布；靠背贴墙、座面朝过道。 */
const SEAT_HALF_LEN = 0.55;
/** 座垫碰撞范围（与车模视觉一致）。 */
const CUSHION_MIN_X = -2.32;
const CUSHION_MAX_X = -1.42;
const CUSHION_HALF_LEN = 0.49;
function makeSeats(defs: { id: number; kind: Seat['kind']; z: number }[]): Seat[] {
  return defs.map((d) => ({
    id: d.id,
    kind: d.kind,
    x: -1.78,
    z: d.z,
    facing: Math.PI / 2, // 面朝 +x（过道）
    rect: { minX: -2.35, maxX: -1.4, minZ: d.z - SEAT_HALF_LEN, maxZ: d.z + SEAT_HALF_LEN },
    backRect: { minX: -2.35, maxX: -2.12, minZ: d.z - SEAT_HALF_LEN, maxZ: d.z + SEAT_HALF_LEN },
    cushion: { minX: CUSHION_MIN_X, maxX: CUSHION_MAX_X, minZ: d.z - CUSHION_HALF_LEN, maxZ: d.z + CUSHION_HALF_LEN }
  }));
}
export const PLATFORM: Rect = { minX: 2.35, maxX: 6.0, minZ: -5.2, maxZ: -3.4 };

export const LAYOUT: BusLayout = {
  interior: INTERIOR,
  platform: PLATFORM,
  doors: [
    { id: 'front', zMin: 3.4, zMax: 5.2, open: false },
    { id: 'back', zMin: -5.2, zMax: -3.4, open: true }
  ],
  // 4 个座位 8 个人：一半人没座，够抢；再少的话落选者会直接放弃。
  // 爱心专座离后门最近，分更高但也最危险 —— 给"敢不敢坐门边"一个明确的赌注。
  seats: makeSeats([
    { id: 0, kind: 'normal', z: 2.45 },
    { id: 1, kind: 'normal', z: 1.15 },
    { id: 2, kind: 'normal', z: -1.15 },
    { id: 3, kind: 'priority', z: -3.7 }
  ]),
  // 只有 6 根扶手、8 个人：抓扶手是稀缺资源，得抢。
  handrails: [
    { id: 0, x: 0, z: -4.2 },
    { id: 1, x: 0, z: -2.1 },
    { id: 2, x: 0, z: 0 },
    { id: 3, x: 0, z: 2.1 },
    { id: 4, x: 0, z: 4.2 },
    { id: 5, x: 1.45, z: 0 }
  ],
  obstacles: [
    // 门那一侧堆着行李和轮拱，被推向车门时不好躲。
    { id: 0, kind: 'luggage', rect: { minX: 1.05, maxX: 1.95, minZ: -1.75, maxZ: -0.85 }, height: 0.78 },
    { id: 1, kind: 'wheelwell', rect: { minX: 1.85, maxX: 2.35, minZ: 0.7, maxZ: 1.9 }, height: 0.52 },
    // 婴儿车贴远侧墙、投币箱靠前门：立杆有了碰撞之后，原位置让 4 号杆和婴儿车只剩 0.3、
    // 3 号杆和投币箱只剩 0.94，去前门和车头只剩一条 1.084 的斜缝（角色直径 1.0），每局都堵死。
    // 现在过道里杆与障碍物的缝都 ≥ 1.16：4 号杆—婴儿车 1.30、4 号杆—投币箱 1.19、3 号杆—投币箱 1.16。
    { id: 2, kind: 'stroller', rect: { minX: -2.25, maxX: -1.35, minZ: 4.2, maxZ: 5.1 }, height: 0.95 },
    { id: 3, kind: 'bin', rect: { minX: 0.95, maxX: 1.55, minZ: 2.85, maxZ: 3.4 }, height: 0.86 }
  ],
  fillers: [
    // 5 号扶手 (1.45, 0) 背后那块地：杆到行李 0.8、到轮拱 0.76、到车壁 0.85，
    // 都小于角色直径 1.0。算过：这块区域里不存在合法站位，只会把人卡住。
    // 填充体从杆心往车壁方向铺满，杆本身西半边露在外面，和填充体连成一整块。
    { minX: 1.45, maxX: 2.35, minZ: -0.85, maxZ: 0.7 }
  ],
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
 * 角色半径另算，这里只给出座垫前沿中点外侧 margin 处。
 */
export function seatFrontPoint(seat: Seat, radius: number, margin = 0.03): Vec2 {
  return { x: seat.cushion.maxX + radius + margin, z: seat.z };
}

/** 判断点是否在车厢内部。 */
export function insideInterior(p: Vec2): boolean {
  const r = INTERIOR;
  return p.x >= r.minX && p.x <= r.maxX && p.z >= r.minZ && p.z <= r.maxZ;
}
