/**
 * 车外世界的尺寸常量（世界格）。
 *
 * 车厢地板在 y=0；路面、人行道、始发站站台的高度都相对它定义。
 * scripts/blender/build_models.py 里的 GROUND_Y、SIDEWALK_Y 和这里是同一组数，
 * 改一边必须改另一边，然后 npm run model:build。
 */
export const WORLD = {
  /** 路面高度。车轮半径 0.46、轮心 -0.54，轮底正好落地。 */
  groundY: -1.0,
  /** 人行道、广场面高度（比路面高一个路缘石）。 */
  sidewalkY: -0.82,
  /** 近侧（车门一侧 +x）路缘线。车身外皮在 2.65，留出 0.75 的路边距。 */
  curbNearX: 3.4,
  /** 近侧人行道宽度。 */
  sidewalkW: 4.0,
  /** 远侧路缘线：对向车道一直铺到这里。 */
  curbFarX: -14.0,
  /** 路面、人行道沿 z 的铺设长度。两头藏在雾里。 */
  stripLen: 180,
  /** 两侧街景道具循环的周期长度。 */
  wrapLen: 160,
  /** 满速时景物相对车厢的移动速度（世界格/秒）。车轮转速也按它算。 */
  scrollSpeed: 7.5,
  /** 雾：近处完全清晰，远处和地平线同色，路的尽头就不会是一条硬边。 */
  fogNear: 32,
  fogFar: 95,
  /**
   * 始发站站台顶面范围（站台自身坐标，顶面 y=0，和车厢地板齐平）。
   * 与 scripts/blender/build_models.py 里 build_station 的 X0/X1/Z0/Z1 是同一组数。
   */
  stationPlatform: { minX: 2.75, maxX: 11.5, minZ: -15, maxZ: 11 }
} as const;
