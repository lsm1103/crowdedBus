import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { getCharacterAsset } from './models';

/**
 * 正式角色的身体：蒙皮模型 + 动作混合 + 代码补的姿势。
 *
 * 角色工程（blender_char）里 8 个人共用同一套 37 根骨骼，自带 12 段动作；
 * 但除了待机 / 走 / 跑，其余几段（抓、推、坐、受击）幅度太小或者不是游戏要的样子，
 * 而游戏里的"坐下、抓扶手、抓人、推、踉跄、瘫倒、被拎、被扔"都要跟规则状态实时对齐，
 * 所以这些姿势一律在代码里算：先让动作剪辑给出基础姿态，再按 {@link Pose} 在模型空间里转骨骼。
 *
 * 模型空间：脚底在原点，+z 是正面，+y 向上，+x 是角色的左手边。
 */

/** 角色身高（世界单位）。和原来的占位人偶一样高：越肩镜头、扶手握把、座椅都是按这个高度摆的。 */
export const CHAR_HEIGHT = 1.85;
/** 角色工程里的标准身高（阿强更壮更高，按同一比例缩放，保留他高出来的那一截）。 */
const SRC_HEIGHT = 3.07;
export const MODEL_SCALE = CHAR_HEIGHT / SRC_HEIGHT;

/** 走路 / 跑步剪辑在 timeScale = 1 时对应的前进速度（世界单位/秒，由脚步幅度量出）。 */
const WALK_REF = 0.52;
const RUN_REF = 1.14;
/**
 * 跑步剪辑最多加速到几倍。游戏里走速 3.2 格/秒，完全不打滑需要 2.8 倍，腿会抡成一团；
 * 限到 2.1 倍，脚下略滑，但看得清是在跑。
 */
const RUN_MAX_RATE = 2.1;

type Side = 0 | 1;
const BONE_NAMES = [
  'spine', 'chest', 'head',
  'upperarmL', 'upperarmR', 'forearmL', 'forearmR', 'handL', 'handR',
  'thighL', 'thighR', 'shinL', 'shinR'
] as const;
type BoneName = typeof BONE_NAMES[number];

/**
 * 代码补的姿势，全部是模型空间里的转角（弧度），0 = 完全交给动作剪辑。
 * 下标 0 = 左，1 = 右。
 */
export interface Pose {
  /** 手臂往前抬（+）/ 往后摆（-）。 */
  armFwd: [number, number];
  /** 手臂往外侧抬（+）。 */
  armOut: [number, number];
  /** 小臂往前收（+）。在 straight 之后叠加。 */
  elbow: [number, number];
  /** 先把小臂拉直到多少（0~1）：待机动作本身是弯着肘的，伸手够东西、推人时要先拉直。 */
  straight: [number, number];
  /** 朝某个方向伸直手臂（模型空间方向，从肩膀出发），aimW 为权重。 */
  aim: [THREE.Vector3, THREE.Vector3];
  aimW: [number, number];
  /** 大腿往前抬（+）。 */
  legFwd: [number, number];
  /** 小腿往后弯（+）。 */
  knee: [number, number];
  /** 上身前倾（+）/ 后仰（-），侧弯（+ 往左）。 */
  spineFwd: number;
  spineSide: number;
  /** 低头（+）。 */
  headFwd: number;
}

export function emptyPose(): Pose {
  return {
    armFwd: [0, 0], armOut: [0, 0], elbow: [0, 0], straight: [0, 0],
    aim: [new THREE.Vector3(), new THREE.Vector3()], aimW: [0, 0],
    legFwd: [0, 0], knee: [0, 0],
    spineFwd: 0, spineSide: 0, headFwd: 0
  };
}

export function resetPose(p: Pose): Pose {
  p.armFwd[0] = p.armFwd[1] = 0;
  p.armOut[0] = p.armOut[1] = 0;
  p.elbow[0] = p.elbow[1] = 0;
  p.straight[0] = p.straight[1] = 0;
  p.aimW[0] = p.aimW[1] = 0;
  p.legFwd[0] = p.legFwd[1] = 0;
  p.knee[0] = p.knee[1] = 0;
  p.spineFwd = p.spineSide = p.headFwd = 0;
  return p;
}

const AX = new THREE.Vector3(1, 0, 0);
const AZ = new THREE.Vector3(0, 0, 1);
const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _qd = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const ID = new THREE.Quaternion();

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 把 glTF 的 PBR 材质换成场景统一的 Lambert；每个角色一份，挡视线淡出时各淡各的。 */
function lambertOf(src: THREE.MeshStandardMaterial): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({
    color: src.color, map: src.map, vertexColors: src.vertexColors,
    transparent: src.transparent, opacity: src.opacity, side: src.side, alphaTest: src.alphaTest
  });
  m.depthWrite = src.depthWrite;
  m.name = src.name;
  return m;
}

export class CharacterBody {
  /** 挂到场景里的节点：脚底在原点，正面朝 +z，已按 {@link MODEL_SCALE} 缩放。 */
  readonly root = new THREE.Group();
  /** 身上的全部材质（挡视线淡出、dispose 用）。 */
  readonly materials: THREE.Material[] = [];
  /** 坐下时大腿根的高度（世界单位）：坐姿对齐座垫要用。 */
  readonly thighHeight: number;
  /** 模型没加载到时退回成一根胶囊，保证能玩。 */
  readonly fallback: boolean;
  private model: THREE.Object3D;
  private mixer: THREE.AnimationMixer | null = null;
  private idle: THREE.AnimationAction | null = null;
  private walk: THREE.AnimationAction | null = null;
  private run: THREE.AnimationAction | null = null;
  private bones: Partial<Record<BoneName, THREE.Object3D>> = {};
  /**
   * 剪辑给出的原始姿态（叠加代码姿势之前）。
   * AnimationMixer 只在剪辑数值变化时才写骨骼 —— 待机时腿是静止的，
   * 不先还原的话，上一帧叠上去的旋转会留在骨骼上，一帧帧越转越多。
   */
  private clipPose = new Map<THREE.Object3D, THREE.Quaternion>();
  /** 绑定姿势下的小臂旋转（手臂伸直）。 */
  private restQ = new Map<THREE.Object3D, THREE.Quaternion>();
  private handFallback = [new THREE.Object3D(), new THREE.Object3D()];

  constructor(defId: string, color: string) {
    this.root.scale.setScalar(MODEL_SCALE);
    const asset = getCharacterAsset(defId);
    if (!asset) {
      this.fallback = true;
      const mat = new THREE.MeshLambertMaterial({ color });
      this.materials.push(mat);
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, SRC_HEIGHT - 1, 6, 12), mat);
      body.position.y = SRC_HEIGHT / 2;
      this.model = body;
      this.root.add(body);
      this.handFallback[0].position.set(0.6, 1.4, 0.3);
      this.handFallback[1].position.set(-0.6, 1.4, 0.3);
      body.add(...this.handFallback);
      this.thighHeight = 0.38 * CHAR_HEIGHT;
      return;
    }
    this.fallback = false;
    this.model = cloneSkinned(asset.scene);
    this.root.add(this.model);

    const own = new Map<THREE.Material, THREE.Material>();
    this.model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // 蒙皮网格的包围球按绑定姿势算，躺倒/被拎起来时会被错误地裁掉；角色就 8 个，不裁。
      mesh.frustumCulled = false;
      const src = mesh.material as THREE.MeshStandardMaterial;
      let m = own.get(src);
      if (!m) {
        m = lambertOf(src);
        own.set(src, m);
        this.materials.push(m);
      }
      mesh.material = m;
    });
    for (const n of BONE_NAMES) {
      const b = this.model.getObjectByName(n);
      if (!b) continue;
      this.bones[n] = b;
      this.restQ.set(b, b.quaternion.clone());
    }

    this.mixer = new THREE.AnimationMixer(this.model);
    const clip = (name: string) => asset.animations.find((a) => a.name === name) ?? null;
    const act = (name: string, w: number) => {
      const c = clip(name);
      if (!c) return null;
      const a = this.mixer!.clipAction(c);
      a.play();
      a.setEffectiveWeight(w);
      return a;
    };
    this.idle = act('Idle', 1);
    this.walk = act('Walk', 0);
    this.run = act('Run', 0);
    // 同一个角色的 8 个副本不要踩在同一拍上。
    this.mixer.setTime(Math.random() * 2);
    // 必须在 setTime 之后记：混合器已经把这一帧写进骨骼，下一帧数值没变就不会再写。
    for (const b of Object.values(this.bones)) this.clipPose.set(b, b.quaternion.clone());

    // root 此时还没挂进场景：它的世界矩阵就是自身的缩放，量出来直接是世界单位。
    this.root.updateMatrixWorld(true);
    const thigh = this.bones.thighL;
    this.thighHeight = thigh ? thigh.getWorldPosition(_v).y : 0.38 * CHAR_HEIGHT;
  }

  /**
   * 走跑混合。speed 是实际位移速度（世界单位/秒），剪辑播放速率跟着它走，慢走时脚才不打滑。
   */
  locomotion(speed: number, dt: number) {
    if (!this.mixer) return;
    for (const [b, q] of this.clipPose) b.quaternion.copy(q);
    const wRun = smoothstep(0.9, 1.8, speed);
    const wWalk = smoothstep(0.08, 0.45, speed) * (1 - wRun);
    const wIdle = 1 - wRun - wWalk;
    if (this.walk && this.run && this.idle) {
      this.idle.setEffectiveWeight(wIdle);
      this.walk.setEffectiveWeight(wWalk);
      this.run.setEffectiveWeight(wRun);
      this.walk.timeScale = Math.min(2, Math.max(0.5, speed / WALK_REF));
      this.run.timeScale = Math.min(RUN_MAX_RATE, Math.max(0.8, speed / RUN_REF));
    }
    this.mixer.update(dt);
    for (const [b, q] of this.clipPose) q.copy(b.quaternion);
  }

  /** 在动作剪辑给出的姿态上叠加代码姿势。每帧 locomotion() 之后调用一次。 */
  applyPose(p: Pose) {
    if (this.fallback) return;
    const b = this.bones;
    // 自上而下：父骨骼先转，子骨骼再在"已经转过的"模型空间里转，方向才对得上。
    if (p.spineFwd || p.spineSide) {
      this.rotate(b.spine, AX, p.spineFwd * 0.45);
      this.rotate(b.spine, AZ, -p.spineSide * 0.45);
      this.rotate(b.chest, AX, p.spineFwd * 0.55);
      this.rotate(b.chest, AZ, -p.spineSide * 0.55);
    }
    if (p.headFwd) this.rotate(b.head, AX, p.headFwd);
    for (const s of [0, 1] as Side[]) {
      const upper = s === 0 ? b.upperarmL : b.upperarmR;
      const fore = s === 0 ? b.forearmL : b.forearmR;
      if (fore && p.straight[s] > 0.001) fore.quaternion.slerp(this.restQ.get(fore)!, Math.min(1, p.straight[s]));
      const out = s === 0 ? p.armOut[s] : -p.armOut[s];
      if (out) this.rotate(upper, AZ, out);
      if (p.armFwd[s]) this.rotate(upper, AX, -p.armFwd[s]);
      if (p.aimW[s] > 0.001) this.aimBone(upper, fore, p.aim[s], p.aimW[s]);
      if (p.elbow[s]) this.rotate(fore, AX, -p.elbow[s]);
      const thigh = s === 0 ? b.thighL : b.thighR;
      const shin = s === 0 ? b.shinL : b.shinR;
      if (p.legFwd[s]) this.rotate(thigh, AX, -p.legFwd[s]);
      if (p.knee[s]) this.rotate(shin, AX, p.knee[s]);
    }
  }

  /** 手掌节点（抓扶手的连接线从这里连出去）。 */
  hand(side: Side): THREE.Object3D {
    return (side === 0 ? this.bones.handL : this.bones.handR) ?? this.handFallback[side];
  }

  /** 节点在模型空间里的朝向（不含 root 的缩放）。 */
  private modelQuat(o: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
    out.identity();
    for (let n: THREE.Object3D | null = o; n && n !== this.model; n = n.parent) out.premultiply(n.quaternion);
    return out;
  }

  /** 绕模型空间的轴转一根骨骼：局部旋转 = Qp⁻¹ · D · Qp · 原旋转。 */
  private rotate(bone: THREE.Object3D | undefined, axis: THREE.Vector3, angle: number) {
    if (!bone || !bone.parent) return;
    _qd.setFromAxisAngle(axis, angle);
    this.applyModelDelta(bone, _qd);
  }

  private applyModelDelta(bone: THREE.Object3D, d: THREE.Quaternion) {
    this.modelQuat(bone.parent!, _qp);
    _qi.copy(_qp).invert();
    _q.copy(_qi).multiply(d).multiply(_qp);
    bone.quaternion.premultiply(_q);
  }

  /** 把"肩 → 肘"这一段转到指向 dir（模型空间），weight 在当前姿态和伸直之间插值。 */
  private aimBone(upper: THREE.Object3D | undefined, fore: THREE.Object3D | undefined, dir: THREE.Vector3, weight: number) {
    if (!upper || !fore || !upper.parent) return;
    // 当前"肩 → 肘"的模型空间方向 = 上臂的模型朝向作用在肘关节的局部位置上。
    this.modelQuat(upper, _qp);
    _v.copy(fore.position).applyQuaternion(_qp).normalize();
    _w.copy(dir).normalize();
    _qd.setFromUnitVectors(_v, _w);
    _qa.copy(ID).slerp(_qd, Math.min(1, weight));
    this.applyModelDelta(upper, _qa);
  }

  dispose() {
    for (const m of this.materials) m.dispose();
    this.mixer?.stopAllAction();
    if (this.fallback) (this.model as THREE.Mesh).geometry.dispose();
  }
}
