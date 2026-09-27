/** 基础数学工具：游戏逻辑使用 XZ 平面（y 轴向上）。 */
export interface Vec2 {
  x: number;
  z: number;
}

export const V2 = (x = 0, z = 0): Vec2 => ({ x, z });

export const v2Add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, z: a.z + b.z });
export const v2Sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, z: a.z - b.z });
export const v2Scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, z: a.z * s });
export const v2Len = (a: Vec2): number => Math.hypot(a.x, a.z);
export const v2Dist = (a: Vec2, b: Vec2): number => v2Len(v2Sub(a, b));
export const v2Norm = (a: Vec2): Vec2 => {
  const l = v2Len(a);
  return l < 1e-6 ? V2() : { x: a.x / l, z: a.z / l };
};

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const TAU = Math.PI * 2;

/** 把角度折到 (-π, π]。 */
export function angleWrap(d: number): number {
  let r = d % TAU;
  if (r > Math.PI) r -= TAU;
  if (r < -Math.PI) r += TAU;
  return r;
}

/** 从 a 转到 b 的最近角度差。 */
export const angleDelta = (a: number, b: number): number => angleWrap(b - a);

/** 无环绕的最近角度插值，用于转身平滑。 */
export function angleLerp(a: number, b: number, t: number): number {
  return a + angleDelta(a, b) * t;
}

/**
 * 屏幕方向 → 世界方向。
 *
 * sx = 屏幕向右，sz = 屏幕向下，yaw = 相机的水平朝向。
 * 这个公式对任意 yaw 都恰好等于相机的 right / back 基向量，所以越肩相机每帧
 * 换 yaw 也不用改公式 —— 摇杆推哪边，角色就往屏幕的哪边走。
 */
export function screenToWorld(sx: number, sz: number, yaw: number): Vec2 {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: sx * c + sz * s, z: -sx * s + sz * c };
}

export interface YawChaseOpts {
  /** 死区（弧度）：误差小于它就完全不动，避免角色微调朝向时镜头抖。 */
  deadzone: number;
  /** 阻尼系数，越大跟得越紧。 */
  lambda: number;
  /** 单位时间最大转速（弧度/秒），防止 180° 急转把玩家转晕。 */
  maxRate: number;
}

/**
 * 相机偏航追逐角色朝向：死区 + 阻尼 + 转速上限。
 * 注意是朝"死区边缘"收敛而不是朝目标中心，否则在死区边界会来回抽。
 */
export function yawChase(cur: number, target: number, dt: number, o: YawChaseOpts): number {
  const d = angleDelta(cur, target);
  const mag = Math.abs(d);
  if (mag <= o.deadzone) return cur;
  const sign = d < 0 ? -1 : 1;
  const want = sign * (mag - o.deadzone);
  let step = want * (1 - Math.exp(-o.lambda * dt));
  const cap = o.maxRate * dt;
  if (step > cap) step = cap;
  if (step < -cap) step = -cap;
  return cur + step;
}
