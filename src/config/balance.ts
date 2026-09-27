/**
 * 回合数值（docs/08-派对玩法重构.md 第 6.1、6.2 节；单位：世界格、秒）。
 *
 * 规则层只剩一条胜负线："把别人挤下车，最后留在车上的人赢这一回合"。
 * 没有积分、技能、座位稳定度、拥挤度；这里的每个数都服务于"推晕 → 拖走 → 扔下车"。
 * 数值由 scripts/probe.ts 的打法对照和断言把关，改了要重跑 `npm run probe`。
 */
export const BALANCE = {
  tickRate: 60,
  botCount: 7,

  // ---------------- 回合时间线（6.1） ----------------
  boardDuration: 7,
  ignitionDuration: 2.4,
  /** 途经几站（不含终点）。 */
  stationCount: 4,
  /**
   * 站间（上一次到站 → 下一次到站，含停站开门的时间）。发车 → 第 1 站、第 4 站 → 好挤模式也按这个区间。
   * 5 段平均 55 秒，加上下面的开门前刹车，行驶阶段约 58 秒。
   */
  legDuration: [9, 13] as const,
  /** 进站刹车，车速低于这个值才开门（真车是停稳才开门）。约刹车后 0.6 秒。 */
  doorOpenSpeed: 0.25,
  /** 每站开门时长。 */
  doorOpenDuration: 4.5,
  /** 好挤模式总长：两门全开、左右摇摆，最后 terminalBrake 秒减速停靠终点。 */
  finaleDuration: 15,
  terminalBrake: 2.0,
  /** 终点停稳后多久进入 ended（让画面把最后的动作播完）。 */
  terminalHold: 0.8,
  /** 只剩 1 人时提前结束，留给摔出去的演出。 */
  earlyEndDelay: 1.5,

  // ---------------- 移动 ----------------
  /** 车厢收窄后角色等比放大，8 个人的占地比例翻倍，挤才成立。 */
  characterRadius: 0.5,
  walkSpeed: 3.2,
  /** 速度阻尼（1/秒）：被推、被撞、惯性带来的速度按它衰减。 */
  velDamping: 3.2,

  // ---------------- 平衡值（6.2） ----------------
  /** 推中扣多少（约 3 下摔倒）。 */
  pushBalance: 0.34,
  /** 冲撞扣多少。 */
  dashBalance: 0.5,
  /** 被扔出去的人撞到扣多少。 */
  thrownHitBalance: 0.6,
  /** 扯住人时按"推"是强推一下：扣平衡和击退都乘这个倍数。 */
  strongPushMul: 1.5,
  /** 多久没掉平衡才开始回。 */
  balanceRegenDelay: 1.0,
  /** 每秒回多少。 */
  balanceRegen: 0.35,
  /** 抓着扶手：机关造成的失衡与位移乘这个。 */
  railEnvMul: 0.3,
  /** 抓着扶手：被推（含冲撞、被扔出的人撞到）的失衡与击退乘这个。 */
  railPushMul: 0.5,
  /** 摔倒瘫多久。 */
  downDuration: 1.6,
  /** 爬起来时的平衡值。 */
  getUpBalance: 0.7,
  /** 爬起后这么久内平衡值不低于 getUpFloor（防止被连环按在地上）。 */
  getUpGuard: 1.0,
  getUpFloor: 0.3,

  // ---------------- 推 / 冲 ----------------
  pushCooldown: 0.8,
  /** 推的距离：身体表面外多少格。 */
  pushReach: 0.6,
  /** 推的扇形：与朝向夹角余弦 ≥ 这个值（0.5 = 前方 120°）。 */
  pushConeCos: 0.5,
  /** 推中的击退初速（格/秒，按 velDamping 衰减，约挪 1.4 格）。 */
  pushKnock: 4.5,
  /** 被推后的短硬直。 */
  pushStun: 0.3,
  /** 推人时自己往后退的速度。 */
  pushRecoil: 1.0,
  dashCooldown: 2.5,
  dashSpeed: 8.0,
  dashDuration: 0.28,
  dashKnock: 6.0,
  dashStun: 0.45,
  /** 硬直中移速只剩这么多。 */
  stunSlow: 0.2,

  // ---------------- 抓 ----------------
  /** 抓人的距离：身体表面外多少格；扇形同推。 */
  grabReach: 0.6,
  grabConeCos: 0.5,
  /** 抓扶手：角色中心到杆心的距离（身体表面外约 0.6）。 */
  railReach: 1.15,
  /** 抓着扶手时离杆心最远多远（被推、被晃也甩不出这个圈）。 */
  railLeash: 1.2,
  /** 抓着扶手时的移速倍率（只能绕着杆挪）。 */
  railSlow: 0.6,
  /** 扯住站着的人：双方移速倍率。 */
  holdSlow: 0.5,
  /** 扯住站着的人：多久后对方自动挣脱。 */
  holdAutoBreak: 1.2,
  /** 扯住时两人中心距离的上限（超过就互相拉近）。 */
  holdTether: 1.45,
  /** 挣脱后多久不能再被抓。 */
  breakFreeImmune: 1.0,
  /** 被人挣脱后多久不能再抓。 */
  regrabCooldown: 0.6,
  /** 拖着摔倒的人：拖人者移速倍率。 */
  carrySlow: 0.7,
  /** 被拖的人贴在拖人者前方多远（中心距）。 */
  carryOffset: 0.7,
  /** 被拖的人爬起后再过多久挣脱。 */
  carryBreakAfterUp: 0.8,
  /** 抓住坐着的人不放多久把他拽起来。 */
  yankTime: 1.0,
  /** 被拽起来的人的平衡值。 */
  yankBalance: 0.3,
  /** 拽的时候移速倍率（基本站着不动）。 */
  yankSlow: 0.3,

  // ---------------- 扔 ----------------
  throwSpeed: 8,
  throwAir: 0.45,
  /** 落地后再瘫多久。 */
  throwLandDown: 1.0,
  /** 被扔出的人撞到别人时，对方的击退初速。 */
  throwHitKnock: 5,
  throwHitStun: 0.5,
  /** 飞行中与墙、座位、立杆碰撞用的半径（人在空中缩成一团）。 */
  throwBodyRadius: 0.45,

  // ---------------- 环境（车速、惯性、机关） ----------------
  /**
   * 惯性：乘客感受到的纵向加速度 = -inertiaGain × d(车速)/dt（车速是 0~1 的归一化值），
   * 刹车往车头 +z 冲、起步往车尾 -z 仰。超过"站得住"阈值 envFooting 的部分才推人、才扣平衡。
   * 门在 ±x 侧、惯性沿 z，刹车不会直接把人往门外推；它的作用是把人晃倒，给门口的人制造机会。
   */
  inertiaGain: 9,
  /** 站得住的阈值（格/秒²）：轻刹大部分被脚下吃掉、急刹大部分推人。急转弯同样按它扣除。 */
  envFooting: 6.5,
  /** 环境冲量（超过阈值的部分，格/秒）每 1 格/秒扣多少平衡值。 */
  envBalancePerImpulse: 0.1,
  busAccelRate: 1.1,
  /** 进站刹车速率（指数衰减）。画面层按它推算停车点，见 Simulation.brakeRate。 */
  stationBrakeRate: 2.2,

  /** 机关：预警时长。 */
  hazardWarn: 0.8,
  /** 每段站间几个机关。 */
  hazardsPerLeg: [1, 2] as const,
  /** 急刹：猛刹到这个车速再恢复。 */
  brakeHazardRate: 6,
  brakeHazardFloor: 0.3,
  /** 急转弯：时长与横向加速度峰值（正弦包络，超过 envFooting 的部分推人）。 */
  turnDuration: [1.0, 1.4] as const,
  turnAccel: 15,
  /** 颠簸：两下踉跄，每下直接扣平衡、随机方向踢一下。 */
  bumpBalance: 0.35,
  bumpKick: 1.8,

  /** 好挤模式：每次换边那一下的冲量（以 swayPulse 秒的短脉冲施加）与扣的平衡。 */
  swayInterval: 1.7,
  swayImpulse: 7.6,
  swayPulse: 0.15,
  swayBalance: 0.2,
  /**
   * 好挤模式：车身持续侧倾的加速度（格/秒²），只推人、不扣平衡；站着不动就会被一路推向敞开的车门。
   * 9.5 → 6.4：旧值下被推的终端速度约 3.0 格/秒，和走路速度 3.2 几乎一样，
   * 人被顶在座位角上时怎么走都走不开（探针里的"机器人卡死"全是这么来的）。
   * 6.4 时终端速度约 2.0，站着不动每次摇摆仍会滑出 2 格多，但想走总能走开。
   */
  finaleTilt: 6.4,
  /** 好挤模式车速（略快于平时）。 */
  finaleSpeed: 1.15
} as const;

/** 座位相关数值。 */
export const SEAT = {
  /**
   * 能坐下的判定：角色中心到**座垫矩形边缘**的距离 ≤ 这个值。
   * 座垫对站着的人是实心的，贴上去（0.5）就能坐，留 0.15 容差；从座位侧面贴过去也算。
   */
  reachEdge: 0.65,
  /** 落座过渡（从座垫边滑到座位点）。 */
  sitDelay: 0.35,
  /** 起身过渡。 */
  standDelay: 0.5,
  /** 被拽起来的过渡。 */
  yankStandDelay: 0.6,
  /** 被拽起来后多久不能再坐。 */
  lockAfterYank: 2.0,
  /** 起身落脚点有人时最多原地等多久。 */
  exitHoldMax: 0.5
} as const;

/** 路人乘客（docs/08 第 6.2 节最后一行）。 */
export const NPC = {
  radius: 0.45,
  walkSpeed: 2.0,
  /** 同车最多几个。 */
  max: 8,
  /** 上客站上来几个、下客站下去几个。 */
  board: [2, 4] as const,
  alight: [1, 3] as const,
  /** 上客时相邻两人间隔。 */
  boardGap: 0.4,
  /**
   * 比玩家重：人和路人重叠时，路人只让出这个比例（玩家让出其余）。
   * 路人推着人走的速度约为自己步速的 80%，玩家硬顶也顶不回去。
   */
  pushShare: 0.2,
  /** 推路人一下：击退打这个折扣。 */
  knockMul: 0.2,
  /** 环境冲量对路人打这个折扣。 */
  envMul: 0.5,
  /** 下车的路人把挡在前面的人往门外带：对方沿路人前进方向的最低速度与每秒失衡。 */
  carrySpeed: 2.4,
  carryBalance: 0.3,
  /** 离门多近才开始"往外带"。 */
  carryRange: 2.2
} as const;

/**
 * 输入缓冲：按下后这么久内动作没能执行（硬直中、冷却差一点），就保留到能执行为止。
 * 只给玩家用；机器人每帧自己决策。
 */
export const INPUT_BUFFER = 0.15;
