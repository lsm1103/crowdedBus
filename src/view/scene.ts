import * as THREE from 'three';
import { WORLD } from '../config/world';
import {
  CAMERA_YAW_DEFAULT, PIVOT_Y, VFOV_MIN_DEG, VFOV_MAX_DEG,
  IDLE_PULLBACK_DELAY, IDLE_PULLBACK_DISTANCE, IDLE_PULLBACK_PITCH_DEG,
  PEEK, RIG_BOARDING, type CameraRig
} from '../config/view';
import { INTERIOR } from '../domain/layout';
import { clamp, yawChase, type Vec2 } from '../core/math';

const DEG = Math.PI / 180;

/**
 * 贴身机位把相机夹在**车厢内部**。
 *
 * 相机和玩家都落在同一个凸的长方体里，中间就不可能隔着车壁 —— 这一条比任何
 * 遮挡剔除都可靠。之前夹在"车厢外一圈"，相机会直接钻进 0.3 米厚的墙体，
 * 半个屏幕被车身板糊住。
 */
const CAM_LIMIT = {
  minX: INTERIOR.minX + 0.28,
  maxX: INTERIOR.maxX - 0.28,
  minZ: INTERIOR.minZ + 0.28,
  maxZ: INTERIOR.maxZ - 0.28,
  minY: 1.15,
  // 车厢无顶（只有车头一小段），相机升高不会撞到任何东西，上限可以放宽。
  maxY: 4.8
};
/**
 * 车壁顶部高度。
 * 车厢是敞篷的（只有车头一小段有顶），所以相机一旦升过墙顶就没有任何遮挡，
 * 这时不必再夹在车厢内 —— 放开水平范围能拿到好得多的俯视构图。
 */
const WALL_TOP = 2.05;
const OUTSIDE_MARGIN = 1.6;
/** 被墙夹到离玩家太近时，改为抬高俯视，而不是把镜头怼进后脑勺。 */
const MIN_HORIZ_DIST = 1.5;
const CORNER_LIFT = 1.5;

const SKY_TOP = 0x69bdf0;
const SKY_HORIZON = 0xf3ead9;

/**
 * 天空球：顶部蓝、地平线暖白，按世界 y 插值。
 * 以前是贴在屏幕上的渐变背景，相机一低头"地平线"还在屏幕下沿，和地面对不上。
 */
function makeSkyDome(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(300, 32, 16);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color(SKY_TOP);
  const mid = new THREE.Color(0xbfe3f5);
  const hor = new THREE.Color(SKY_HORIZON);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / 300;
    if (t <= 0.02) c.copy(hor);
    else if (t < 0.25) c.copy(hor).lerp(mid, (t - 0.02) / 0.23);
    else c.copy(mid).lerp(top, Math.min(1, (t - 0.25) / 0.5));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -100;
  mesh.frustumCulled = false;
  return mesh;
}

/** 透视越肩相机 + 场景容器。 */
export class Scene3D {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;

  private container: HTMLElement;
  private onResize: () => void;

  private rig: CameraRig = RIG_BOARDING;
  private target = new THREE.Vector3();
  private focus = new THREE.Vector3();
  private facing = CAMERA_YAW_DEFAULT;
  private yaw = CAMERA_YAW_DEFAULT;
  /** 滑屏环顾：叠加在 yaw 之上的偏移，会自动回正。见 config/view.ts 的 PEEK。 */
  private peek = 0;
  private peekHold = 0;
  private peekDragging = false;
  private yawEff = CAMERA_YAW_DEFAULT;
  /** 站定不动的累计时长，用来做镜头拉开。 */
  private idleTimer = 0;
  private pullback = 0;

  private shakeAmp = 0;
  private shakeTime = 0;
  private roll = 0;
  private targetRoll = 0;

  private sky: THREE.Mesh;

  /**
   * 自适应分辨率。
   * 最高 2 倍像素 + 抗锯齿，在低端安卓上跑不满帧；连续掉帧就降一档，稳定满帧很久再试着升回来。
   * 每一档最多失败两次：偶发卡顿（后台下载、发热）还能升回去，真扛不住的不再来回跳。
   */
  private dprLevels = [...new Set([Math.min(window.devicePixelRatio || 1, 2), 1.5, 1.25, 1])]
    .filter((v) => v <= Math.min(window.devicePixelRatio || 1, 2))
    .sort((a, b) => b - a);
  private dprIndex = 0;
  private dprFails: number[] = [];
  private frameEma = 1 / 60;
  private slowFor = 0;
  private fastFor = 0;
  /** 开局头几秒有着色器编译、贴图上传，不算数。 */
  private dprWarmup = 3;
  private camPos = new THREE.Vector3();
  private pivot = new THREE.Vector3();
  private scratch = new THREE.Vector3();

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.dprLevels[0]);
    // 这里**不要**开 ACES 色调映射。
    // 试过：材质本来就是低动态范围的卡通纯色，再过一遍胶片曲线只会把画面冲白、
    // 对比度全丢。冷暖统一靠灯光色温和色板就够了，不需要 tone mapping。
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY_HORIZON);
    // 雾色 = 天空地平线色：路和楼的尽头融进天边，而不是一条硬边。
    this.scene.fog = new THREE.Fog(SKY_HORIZON, WORLD.fogNear, WORLD.fogFar);
    this.sky = makeSkyDome();
    this.scene.add(this.sky);

    // near 要很小：越肩时相机会贴到墙和椅背上。
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 400);

    this.addLights();

    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);
    this.resize();
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.applyProjection();
  }

  /**
   * 固定水平 FOV 反推垂直 FOV。
   * 若固定垂直 FOV，2.17 的手机宽高比会让平板（1.33）横向窄到看不见两侧车壁。
   */
  private applyProjection() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const aspect = w / h;
    const hFov = this.rig.fovDeg * DEG;
    const vFov = 2 * Math.atan(Math.tan(hFov / 2) / aspect);
    this.camera.fov = clamp(vFov / DEG, VFOV_MIN_DEG, VFOV_MAX_DEG);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** 切换机位（上车 / 启动 / 行驶 / 终局 / 观战各一套）。 */
  setRig(rig: CameraRig, immediate = false) {
    this.rig = rig;
    this.applyProjection();
    if (rig.yawMode === 'fixed' && rig.yawFixed !== undefined && immediate) {
      this.yaw = rig.yawFixed;
    }
    if (immediate) {
      this.focus.copy(this.target);
      this.idleTimer = 0;
      this.pullback = 0;
      // 切机位时保留一个残余偏移会让新机位一上来就是歪的。
      this.resetPeek();
      this.applyCamera(1 / 60);
    }
  }

  /** 每帧告诉镜头要跟谁（通常是玩家）。 */
  setTarget(p: Vec2, y = 0) {
    this.target.set(p.x, y, p.z);
  }

  /** 每帧告诉镜头角色朝哪儿，越肩偏航由它驱动。 */
  setTargetFacing(f: number) {
    this.facing = f;
  }

  /** 玩家这一帧有没有在移动，用来决定要不要拉开镜头。 */
  setMoving(moving: boolean) {
    this.idleTimer = moving ? 0 : this.idleTimer + 1 / 60;
  }

  /**
   * 环顾输入：dx 是舞台坐标下的水平位移比例（1 = 划过整个舞台宽度）。
   * 返回的是**实际生效**的角度，被限位吃掉的部分不会累积。
   */
  peekBy(dxRatio: number) {
    this.peekDragging = true;
    this.peekHold = PEEK.holdAfterRelease;
    const lim = PEEK.maxDeg * DEG;
    this.peek = clamp(this.peek - dxRatio * PEEK.degPerStageWidth * DEG, -lim, lim);
  }

  /** 手指抬起：进入保持期，之后缓缓回正。 */
  endPeek() {
    this.peekDragging = false;
    this.peekHold = PEEK.holdAfterRelease;
  }

  /** 立刻归零（切机位、重生、玩家出局时用）。 */
  resetPeek() {
    this.peek = 0;
    this.peekHold = 0;
    this.peekDragging = false;
  }

  /**
   * 相机偏航。**必须**把 peek 算进去：摇杆用它做 screenToWorld 的基向量，
   * 不算的话画面转了而输入没转，推上是斜着走。
   */
  get cameraYaw(): number {
    return this.yawEff;
  }

  get cameraPosition(): THREE.Vector3 {
    return this.camPos;
  }

  shake(amount: number) {
    this.shakeAmp = Math.min(0.9, Math.max(this.shakeAmp, amount));
  }

  setRoll(v: number) {
    this.targetRoll = v;
  }

  /** 每帧喂真实帧间隔（秒），决定要不要调渲染分辨率。 */
  private governResolution(dt: number) {
    if (this.dprLevels.length < 2) return;
    if (this.dprWarmup > 0) {
      this.dprWarmup -= dt;
      return;
    }
    this.frameEma += (dt - this.frameEma) * 0.1;
    this.slowFor = this.frameEma > 1 / 40 ? this.slowFor + dt : 0;
    this.fastFor = this.frameEma < 1 / 55 ? this.fastFor + dt : 0;
    let next = this.dprIndex;
    if (this.slowFor > 1.5 && this.dprIndex < this.dprLevels.length - 1) {
      this.dprFails[this.dprIndex] = (this.dprFails[this.dprIndex] ?? 0) + 1;
      next = this.dprIndex + 1;
    } else if (this.fastFor > 12 && this.dprIndex > 0 && (this.dprFails[this.dprIndex - 1] ?? 0) < 2) {
      next = this.dprIndex - 1;
    }
    if (next === this.dprIndex) return;
    this.dprIndex = next;
    this.renderer.setPixelRatio(this.dprLevels[next]);
    this.resize();
    this.slowFor = 0;
    this.fastFor = 0;
    this.frameEma = 1 / 60;
    this.dprWarmup = 1;
  }

  update(dt: number) {
    this.governResolution(dt);
    // 水平跟得紧，垂直跟得松：actors 的 bob 每帧在 0~0.07 跳，
    // 透视贴身下这个抖动会被放大成明显的镜头颠簸。
    const kh = 1 - Math.exp(-12 * dt);
    const kv = 1 - Math.exp(-4 * dt);
    this.focus.x += (this.target.x - this.focus.x) * kh;
    this.focus.z += (this.target.z - this.focus.z) * kh;
    this.focus.y += (this.target.y - this.focus.y) * kv;

    // 拉开慢、收回快：站定观察时缓缓拉开，一动立刻压回越肩。
    const wantPull = this.idleTimer > IDLE_PULLBACK_DELAY ? 1 : 0;
    this.pullback += (wantPull - this.pullback) * (1 - Math.exp(-(wantPull ? 1.4 : 8) * dt));

    // 环顾回正。idleTimer === 0 表示这一帧在走 —— 走起来就快速回正，
    // 否则叠加的偏移会让"推上"每帧多转一点，角色绕圈（见 PEEK 注释）。
    this.updatePeek(dt, this.idleTimer === 0);

    this.roll += (this.targetRoll - this.roll) * (1 - Math.exp(-2.6 * dt));
    this.shakeAmp *= Math.exp(-6 * dt);
    if (this.shakeAmp < 0.002) this.shakeAmp = 0;
    this.shakeTime += dt;

    this.applyCamera(dt);
  }

  private updatePeek(dt: number, moving: boolean) {
    if (this.peek === 0) return;
    // 走动时不吃保持期，直接回正：这时玩家要的是操控，不是观察。
    if (moving) {
      this.peekDragging = false;
      this.peekHold = 0;
    }
    if (this.peekDragging) return;
    if (this.peekHold > 0) {
      this.peekHold -= dt;
      return;
    }
    const lambda = moving ? PEEK.moveReturnLambda : PEEK.returnLambda;
    this.peek *= Math.exp(-lambda * dt);
    if (Math.abs(this.peek) < 1e-4) this.peek = 0;
  }

  private applyCamera(dt: number) {
    const cam = this.camera;
    const rig = this.rig;

    // yaw 的语义是"从枢轴指向相机"的方位角（也就是角色的背后），
    // 这与 screenToWorld(1,0,yaw) 推导时用的基向量一致；写成角色朝向会让
    // 摇杆的左右和画面的左右正好反过来。
    const yawTarget = rig.yawMode === 'chase'
      ? this.facing + Math.PI
      : (rig.yawFixed ?? CAMERA_YAW_DEFAULT);
    this.yaw = yawChase(this.yaw, yawTarget, dt, {
      deadzone: rig.chase.deadzoneDeg * DEG,
      lambda: rig.chase.lambda,
      maxRate: rig.chase.maxRateDeg * DEG
    });

    const dist = rig.distance + IDLE_PULLBACK_DISTANCE * this.pullback;
    const pitch = (rig.pitchDeg + IDLE_PULLBACK_PITCH_DEG * this.pullback) * DEG;
    // 抬升由距离和俯角导出，不单独配，免得两个参数打架。
    const height = dist * Math.tan(pitch);

    this.pivot.set(this.focus.x, this.focus.y + PIVOT_Y, this.focus.z);

    // 环顾偏移叠在跟随偏航之上；yawEff 同时是摇杆的换算基向量。
    this.yawEff = this.yaw + this.peek;
    const sy = Math.sin(this.yawEff);
    const cy = Math.cos(this.yawEff);
    // 屏幕右在世界里的方向，与 core/math.ts 的 screenToWorld 同源。
    const rightX = cy;
    const rightZ = -sy;
    this.camPos.set(
      this.pivot.x + sy * dist + rightX * rig.shoulder,
      this.pivot.y + height,
      this.pivot.z + cy * dist + rightZ * rig.shoulder
    );
    if (rig.clampToCabin) {
      // 低于墙顶才必须待在车厢内；高过墙顶就没东西挡了，可以外扩。
      const m = this.camPos.y >= WALL_TOP ? OUTSIDE_MARGIN : 0;
      this.camPos.x = clamp(this.camPos.x, CAM_LIMIT.minX - m, CAM_LIMIT.maxX + m);
      this.camPos.z = clamp(this.camPos.z, CAM_LIMIT.minZ - m, CAM_LIMIT.maxZ + m);
      // 贴墙/贴角时水平距离会被夹没，这时把相机抬起来俯视，而不是怼进后脑勺。
      const horiz = Math.hypot(this.camPos.x - this.pivot.x, this.camPos.z - this.pivot.z);
      const lift = horiz < MIN_HORIZ_DIST ? (MIN_HORIZ_DIST - horiz) * CORNER_LIFT : 0;
      this.camPos.y = clamp(this.camPos.y + lift, CAM_LIMIT.minY, CAM_LIMIT.maxY);
    }

    cam.position.copy(this.camPos);
    this.scratch.set(
      this.pivot.x + rightX * rig.shoulder,
      this.pivot.y,
      this.pivot.z + rightZ * rig.shoulder
    );
    cam.lookAt(this.scratch);

    // 抖动做成角度抖动。透视贴身下平移抖动会把相机怼进墙里。
    if (this.shakeAmp > 0) {
      const t = this.shakeTime * 42;
      cam.rotateX(Math.sin(t * 1.7) * this.shakeAmp * 0.035);
      cam.rotateY(Math.sin(t * 2.3 + 1.1) * this.shakeAmp * 0.035);
    }
    if (Math.abs(this.roll) > 1e-4) cam.rotateZ(this.roll);
    cam.updateMatrixWorld(true);
  }

  private addLights() {
    // 灯光转暖是统一冷暖最省力的杠杆：不用改任何材质就能把整场拉到同一色温。
    this.scene.add(new THREE.HemisphereLight(0xfff0dc, 0xc79e7a, 0.95));
    const dir = new THREE.DirectionalLight(0xffe7c2, 1.25);
    dir.position.set(10, 18, 8);
    this.scene.add(dir);
    const fill = new THREE.DirectionalLight(0xfff3e0, 0.45);
    fill.position.set(6, 10, 4);
    this.scene.add(fill);
    this.scene.add(new THREE.AmbientLight(0xffe8d2, 0.36));
  }

  render() {
    // 天空球跟着相机走：它只表达方向，不该有视差。
    this.sky.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.onResize);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
