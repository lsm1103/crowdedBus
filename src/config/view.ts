/**
 * 相机机位参数。
 *
 * 越肩相机的偏航每帧都在变，所以输入侧读的是 Scene3D 的实时偏航（cameraYaw），
 * 本文件只提供偏航初值与各阶段的机位规格。
 */

/** 相机默认水平朝向（度）。上车阶段用它做固定机位，也是越肩偏航的初值。 */
export const CAMERA_YAW_DEG = 74;
export const CAMERA_YAW_DEFAULT = (CAMERA_YAW_DEG * Math.PI) / 180;

/** 相机绕着看的枢轴高度（世界格）。取胸口偏上，用脚底会让俯角一大人就贴屏幕底。 */
export const PIVOT_Y = 1.35;

/** 垂直 FOV 的夹取范围（度）。横屏宽高比跨度很大（手机 2.17、平板 1.33），不夹会在平板上鱼眼。 */
export const VFOV_MIN_DEG = 42;
export const VFOV_MAX_DEG = 64;

export interface ChaseOpts {
  /** 死区（度）：朝向误差小于它相机完全不动。 */
  deadzoneDeg: number;
  /** 阻尼系数，越大跟得越紧。 */
  lambda: number;
  /** 最大转速（度/秒）：防止 180° 急转把人转晕。 */
  maxRateDeg: number;
}

export interface CameraRig {
  /** 水平后撤距离。 */
  distance: number;
  /** 俯角（度）。相机抬升由 distance × tan(pitch) 导出，不单独配，免得两个参数互相矛盾。 */
  pitchDeg: number;
  /** 沿相机右向的横向偏移。正值让角色偏屏幕左，避开右下角的动作按钮。 */
  shoulder: number;
  /** 基准水平 FOV（度），垂直 FOV 由宽高比反推。 */
  fovDeg: number;
  yawMode: 'chase' | 'fixed';
  /** yawMode 为 fixed 时使用。 */
  yawFixed?: number;
  chase: ChaseOpts;
  /**
   * 是否把相机夹在车厢附近。
   * 贴身机位必须夹（否则玩家贴远壁转身时相机会甩到车外好几米，车厢在画面里缩成一团）；
   * 上车/观战这种远机位本来就在车外，不能夹。
   */
  clampToCabin: boolean;
}

const CHASE: ChaseOpts = { deadzoneDeg: 14, lambda: 6.5, maxRateDeg: 70 };

/** 上车：远机位固定朝向，能同时看到站台和后门。 */
export const RIG_BOARDING: CameraRig = {
  clampToCabin: false,
  distance: 8.5, pitchDeg: 21, shoulder: 0, fovDeg: 78,
  yawMode: 'fixed', yawFixed: CAMERA_YAW_DEFAULT, chase: CHASE
};

/** 启动过场：从远机位收向越肩的中间态。 */
export const RIG_IGNITION: CameraRig = {
  clampToCabin: false,
  distance: 4.2, pitchDeg: 22, shoulder: 0.25, fovDeg: 78,
  yawMode: 'fixed', yawFixed: CAMERA_YAW_DEFAULT, chase: CHASE
};

/**
 * 行驶：越肩，相机跟着角色转身一起转。
 *
 * 距离是按"角色占屏高约 1/3"反推的：可见高度 ≈ 2·d·tan(vFov/2)，
 * vFov 在手机上被夹到 42°，所以 d≈5.6 时可见约 4.7 格、角色 1.8 格 ≈ 38%。
 * 之前 3.4 是矮墙时代调的；车壁升到全高之后角色会占掉 60% 屏幕，
 * 看不见对手也看不见车厢，越肩就失去意义了。
 */
export const RIG_DRIVING: CameraRig = {
  clampToCabin: true,
  distance: 5.6, pitchDeg: 29, shoulder: 0.5, fovDeg: 78,
  yawMode: 'chase', chase: CHASE
};

/** 终局：再拉开一点，好看清自己正被甩向哪一侧。 */
export const RIG_FINALE: CameraRig = {
  clampToCabin: true,
  distance: 6.3, pitchDeg: 33, shoulder: 0.5, fovDeg: 78,
  yawMode: 'chase', chase: CHASE
};

/** 玩家出局后的观战机位：拉远看清自己是怎么被挤下去的。 */
export const RIG_ELIMINATED: CameraRig = {
  clampToCabin: false,
  distance: 6.0, pitchDeg: 30, shoulder: 0, fovDeg: 78,
  yawMode: 'fixed', yawFixed: CAMERA_YAW_DEFAULT, chase: CHASE
};

/**
 * 滑屏环顾（peek）。
 *
 * 做成「叠加在跟随偏航之上、会自动回正的偏移」，而不是直接设相机朝向：
 * 越肩偏航每帧都在追角色朝向，写绝对角度会被 yawChase 立刻拽回去，手感必然是坏的。
 *
 * **只在站定时可用，一推摇杆就回正**，这条不是保守，是数学上必须的：
 * 摇杆的世界方向由 screenToWorld(sx, sz, cameraYaw) 换算，所以 peek 必须计入
 * 输入基向量，否则推摇杆的方向会和画面对不上（之前踩过的那个 45° 错位）。
 * 而一旦计入，"边走边保持偏移"就等于每帧朝偏移方向多转一点，
 * 追随再跟上来 —— 角色会稳定地绕圈。环顾是观察工具，不是转向工具。
 *
 * 上下不做：俯角是由 distance × tan(pitch) 反推抬升的，且相机被夹在车厢内，
 * 抬头会直接穿过车顶、低头会怼进地板，没有可用行程。
 */
export const PEEK = {
  /** 左右限位（度）。 */
  maxDeg: 60,
  /** 横扫整个舞台宽度对应的转角（度）。用比例而非像素，分辨率无关。 */
  degPerStageWidth: 180,
  /** 松手后维持不动的时间（秒）：快速划一下也要看得清，不能立刻弹回。 */
  holdAfterRelease: 0.35,
  /** 松手后的回正阻尼。 */
  returnLambda: 3.2,
  /** 推摇杆时的回正阻尼，明显更快，避免走起来还在慢慢转。 */
  moveReturnLambda: 6
} as const;

/** 站定不动超过这个时间，镜头缓缓拉开便于观察周围。 */
export const IDLE_PULLBACK_DELAY = 0.8;
export const IDLE_PULLBACK_DISTANCE = 0.9;
export const IDLE_PULLBACK_PITCH_DEG = 6;
