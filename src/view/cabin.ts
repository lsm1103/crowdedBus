import * as THREE from 'three';

/**
 * 车身姿态：刹车点头、转弯/摇摆侧倾、行驶颠簸。纯视觉，不影响碰撞。
 *
 * group 里装的是车身和车里的一切（人、特效、地面圈）；车轮和街景不在里面 ——
 * 车身相对轮子晃，读起来就是悬挂在工作，比整辆车连轮子一起歪真实得多。
 *
 * 输入是模拟层施加给乘客的环境加速度（世界格/秒²）：
 *   纵向 +z 朝车头：刹车时乘客往前冲，车头下沉；起步时车头抬起。
 *   横向 +x 朝车门一侧：乘客被甩向车门时，车身也往车门一侧歪。
 * 角度都很小：车轮离轮拱只有 7cm，点头超过 ~0.8° 车身就会压到轮胎上。
 */
const DEG = Math.PI / 180;
/**
 * 点头主要看车速变化率：模拟层给乘客的纵向加速度扣掉了"站得住"的那一截，
 * 普通到站刹车时它可能是 0，但车身照样该点头。
 * 车速单位是"满速 = 1"，普通进站刹车 dv/dt 约 -2.1/s。
 */
const PITCH_PER_DECEL = 0.3;
/** 每 1 格/秒² 对应的角度（度）：叠加脉冲（晃动、上人）带来的额外点头。 */
const PITCH_PER_ACCEL = 0.05;
const ROLL_PER_ACCEL = 0.12;
const PITCH_MAX = 0.8 * DEG;
const ROLL_MAX = 1.4 * DEG;
/** 弹簧参数：刚度与阻尼。略欠阻尼，急刹时车身会回弹一下。 */
const STIFF = 60;
const DAMP = 9;
/** 满速时的颠簸幅度（格）。 */
const BUMP = 0.012;

export class CabinPose {
  readonly group = new THREE.Group();
  private pitch = 0;
  private pitchV = 0;
  private roll = 0;
  private rollV = 0;
  private t = 0;
  private lastSpeed = 0;
  private dvdt = 0;

  /** longAccel / latAccel：模拟层给乘客的环境加速度；speed：车速（满速 = 1）。 */
  update(dt: number, longAccel: number, latAccel: number, speed: number) {
    const h = Math.min(dt, 1 / 30);
    this.t += h;
    // 车速变化率做一点平滑：speed 是按固定步长更新的，渲染帧里直接差分会抖。
    const raw = h > 0 ? (speed - this.lastSpeed) / h : 0;
    this.lastSpeed = speed;
    this.dvdt += (raw - this.dvdt) * (1 - Math.exp(-10 * h));
    const pitchDeg = -this.dvdt * PITCH_PER_DECEL + longAccel * PITCH_PER_ACCEL;
    const pt = THREE.MathUtils.clamp(pitchDeg * DEG, -PITCH_MAX, PITCH_MAX);
    const rt = THREE.MathUtils.clamp(-latAccel * ROLL_PER_ACCEL * DEG, -ROLL_MAX, ROLL_MAX);
    this.pitchV += ((pt - this.pitch) * STIFF - this.pitchV * DAMP) * h;
    this.pitch += this.pitchV * h;
    this.rollV += ((rt - this.roll) * STIFF - this.rollV * DAMP) * h;
    this.roll += this.rollV * h;
    // 绕 x 正向转，车头（+z）往下；绕 z 负向转，车门一侧（+x）往下。
    this.group.rotation.set(this.pitch, 0, this.roll);
    const s = Math.min(1, Math.abs(speed));
    this.group.position.y = s * BUMP * (Math.sin(this.t * 11) * 0.6 + Math.sin(this.t * 17.3 + 1.2) * 0.4);
  }

  /** 平滑后的车速变化率（满速/秒，正 = 在加速）。引擎声的"油门"也用它。 */
  get throttle(): number {
    return this.dvdt;
  }

  /** 开局归零，免得上一局最后的倾斜带进来。 */
  reset() {
    this.pitch = this.pitchV = this.roll = this.rollV = 0;
    this.lastSpeed = 0;
    this.dvdt = 0;
    this.group.rotation.set(0, 0, 0);
    this.group.position.set(0, 0, 0);
  }
}
