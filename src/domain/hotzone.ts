import { V2, v2Dist, type Vec2 } from '../core/math';
import type { BusLayout, Door } from './layout';

/**
 * 流动热区。
 *
 * 座位只覆盖 4 个人，另外 4 个必须有事可做，否则他们整局没有目标 —— 这是
 * "非风险期无所事事"的直接解法。
 *
 * 三条关键设计：
 * 1. **分数按区内人数稀释**：两个人同占不如一个人独占，天然驱动互推。
 * 2. **到站时热区移到开着的那扇门前**：把"门口 5 秒风险窗口"从纯避险变成
 *    "敢不敢去门口刷分"的正向诱惑，风险和收益绑在同一格地面上。
 *    但圆必须完整落在车厢内：以前圆心 x=1.6、半径 1.25，外缘伸到 x=2.85，
 *    越过了 2.65 的淘汰线 —— "得分区"里有一圈站上去就直接出局。
 * 3. **终局不再钉在门口**：终局两门全开 + 持续侧倾，旧版热区 14 秒钉死在前门，
 *    照着"去黄圈"做的新手 90% 在终局开始 3 秒内被甩出去。终局热区改在过道中线
 *    附近跳，圆心放在两根扶手中间：扶手在圈外（站在扶手根下拿不到分），
 *    座位也在圈外（终局被强制清座的人原地站着不能白拿分）。
 *    想两头都要就得抓着扶手探身过去（抓握范围比圈大，但移速 -20%、离杆远了会脱手）。
 */

/** 平时热区半径。 */
const R_IDLE = 1.25;
/**
 * 门口热区半径：圆心贴门、外缘正好到车壁线。
 * 取 1.0 还有一个目的 —— 让 0/4 号扶手（x=0, z=±4.2）落在圈外，
 * 不然"抓着扶手站门口刷分"就把风险抹平了。
 */
const R_DOOR = 1.0;
/** 终局热区半径：配合 pickFinalePoint 的点位，让所有扶手和座位都落在圈外。 */
const R_FINALE = 1.0;

export class HotZone {
  pos: Vec2 = V2(0, 0);
  radius = R_IDLE;
  private timer = 0;
  private atDoor = false;
  private inFinale = false;

  constructor(private layout: BusLayout) {
    this.pos = this.pickIdlePoint(0);
  }

  reset() {
    this.timer = 0;
    this.atDoor = false;
    this.inFinale = false;
    this.radius = R_IDLE;
    this.pos = this.pickIdlePoint(0);
  }

  /** 车厢中段的候选点：避开座位那一侧，逼没座的人在过道里争。 */
  private pickIdlePoint(rnd: number): Vec2 {
    const r = this.layout.interior;
    const zs = [r.minZ + 2.2, -1.2, 1.2, r.maxZ - 2.2];
    const z = zs[Math.floor(rnd * zs.length) % zs.length];
    return V2(0.55, z);
  }

  /**
   * 终局候选点：过道中线偏座位侧、两根扶手中间。
   * 到最近扶手 ≈ √(0.3² + 1.05²) ≈ 1.09 > R_FINALE；
   * 到最近座位锚点（x=-1.78）≥ 1.48 > R_FINALE。
   */
  private pickFinalePoint(rnd: number): Vec2 {
    const zs = [-3.15, -1.05, 1.05, 3.15];
    return V2(-0.3, zs[Math.floor(rnd * zs.length) % zs.length]);
  }

  update(dt: number, rnd: () => number, openDoor: Door | null, finale = false) {
    if (finale) {
      if (!this.inFinale) {
        this.inFinale = true;
        this.atDoor = false;
        this.timer = 0;
      }
      this.radius = R_FINALE;
      this.timer -= dt;
      if (this.timer <= 0) {
        this.timer = 4 + rnd() * 2;
        this.pos = this.pickFinalePoint(rnd());
      }
      return;
    }
    // 到站开门时强制贴到门口，其余时间在车厢中段跳。
    if (openDoor) {
      if (!this.atDoor) {
        this.atDoor = true;
        this.radius = R_DOOR;
        this.pos = V2(this.layout.interior.maxX - R_DOOR, (openDoor.zMin + openDoor.zMax) / 2);
      }
      return;
    }
    if (this.atDoor) {
      this.atDoor = false;
      this.timer = 0;
      this.radius = R_IDLE;
      this.pos = this.pickIdlePoint(rnd());
      return;
    }
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 9 + rnd() * 4;
      this.pos = this.pickIdlePoint(rnd());
    }
  }

  contains(p: Vec2): boolean {
    return v2Dist(p, this.pos) <= this.radius;
  }
}
