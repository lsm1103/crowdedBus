import * as THREE from 'three';
import type { CharacterState } from '../domain/types';
import { setMaterialTransparent } from './models';
import { CharacterBody, CHAR_HEIGHT, emptyPose, resetPose, type Pose } from './character';

/** 推挤动作时长。 */
const PUSH_DUR = 0.3;

/** 名字牌排序用的最大参考距离。 */
const LABEL_MAX_DIST = 18;
/** 名字牌尺寸补偿的参考距离：太近不放大到糊脸，太远不小到看不清。 */
const LABEL_REF_DIST = 4;

/**
 * 坐姿对齐。座垫顶面在 y=0.46（scripts/blender/build_models.py 的座椅）。
 * 大腿放平后，大腿根往下 THIGH_R 就是屁股底面；让它落在座垫上、略陷进去一点。
 * 座位坐标是座垫中心，人要往靠背方向挪 SIT_BACK，背才贴得上靠背。
 */
const SEAT_TOP = 0.46;
const SEAT_SINK = 0.03;
const THIGH_R = 0.09;
const SIT_BACK = 0.25;

/**
 * 身体的转轴高度（腰）。摔倒、被拎、被扔都绕腰转：绕脚底转的话，
 * 人躺下时整个身子会甩到身后一米多，压到别人和墙里。
 */
const PIVOT = 0.42 * CHAR_HEIGHT;
/** 躺在地上时腰离地的高度（身体厚度的一半）。 */
const LIE_Y = 0.16;
/** 肩膀在角色局部坐标里的位置（伸手瞄准扶手/别人时从这里出发）。+x 是左手边。 */
const SHOULDER_X = 0.2;
const SHOULDER_Y = 0.66 * CHAR_HEIGHT;

/** 名字牌离镜头比这更近就淡出：贴脸的名字牌会盖住半个屏幕。 */
const LABEL_NEAR_HIDE = 2.2;
const LABEL_NEAR_FULL = 3.4;
/**
 * 名字牌贴边内收（NDC，屏幕宽高各为 2）。
 * 顶部要让出 HUD 状态栏：它约 50px 高，手机横屏（高 360~430）上约占 13% 屏高。
 */
const LABEL_EDGE_SIDE = 0.02;
const LABEL_EDGE_TOP = 0.26;
const LABEL_EDGE_BOTTOM = 0.04;
/** 两个名字牌在屏幕上重叠超过自身面积的这个比例，就只留离镜头近的那个。 */
const LABEL_OVERLAP = 0.12;
/**
 * 摔下车演出（返场和最终淘汰共用）。
 * 落地后停留多久开始淡出：车停着时躺一下就走；车在开时要多留一会儿，让人看清他被甩在后面滚远。
 */
const KO_REST_STILL = 0.55;
const KO_REST_MOVING = 1.4;
const KO_FADE = 0.45;
/** 兜底：无论如何这么久之后一定结束。 */
const KO_MAX = 3.2;

/** 车外世界给人偶提供的信息：地面高度、地面相对车厢的移动速度。由 SceneryView 实现。 */
export interface GroundInfo {
  heightAt(x: number, z: number): number;
  readonly driftZ: number;
}

/** 每帧给角色的环境信息：伸手要够到的东西在哪（车厢坐标）。 */
export interface ActorWorld {
  characters: CharacterState[];
  railAnchor(id: number): THREE.Vector3 | null;
}

/**
 * 挡视线淡出。越肩镜头从玩家背后斜着往下看，站在镜头和玩家之间的人会把玩家整个盖住。
 * 判定放在屏幕空间里做：离镜头更近、且在屏幕上盖住玩家身体超过 OCCLUDER_COVER 的人淡成虚影。
 * （三维里"离视线近"不行：镜头高，视线从挡路人的头顶上方一米多穿过，但画面上照样盖住了人。）
 */
const BODY_TOP = CHAR_HEIGHT + 0.1;
const BODY_HALF_W = 0.45;
const OCCLUDER_COVER = 0.25;
const OCCLUDER_ALPHA = 0.28;

/** 平衡值低于它开始站不稳（踉跄幅度随平衡值线性变大）。 */
const WOBBLE_BELOW = 0.45;
/** 被推硬直的参考时长（秒），踉跄幅度按它归一。 */
const STUN_REF = 0.42;
/** 被扔出去时抛物线的最高点（格）。 */
const THROW_ARC = 0.9;

/** 共享几何体：脚下的标记，8 个人共用。 */
const GEO = {
  shadow: new THREE.CircleGeometry(0.46, 20),
  ring: new THREE.RingGeometry(0.44, 0.56, 26),
  grabRing: new THREE.TorusGeometry(0.6, 0.048, 8, 22),
  arrow: new THREE.ConeGeometry(0.19, 0.34, 4)
};

const SHARED = {
  shadow: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.24 }),
  grab: new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.9 }),
  playerArrow: new THREE.MeshBasicMaterial({ color: 0xffd23f })
};

const labelCache = new Map<string, THREE.CanvasTexture>();

/** 名字牌：底色用角色配色，人挤成一团时靠颜色也能分辨。 */
function labelTexture(name: string, color: string, isPlayer: boolean): THREE.Texture {
  const key = name + '|' + color + '|' + (isPlayer ? 1 : 0);
  const hit = labelCache.get(key);
  if (hit) return hit;

  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 80;
  const ctx = c.getContext('2d')!;
  ctx.font = 'bold 34px "PingFang SC", sans-serif';
  const w = Math.min(244, ctx.measureText(name).width + 34);
  const x = (256 - w) / 2;

  ctx.fillStyle = isPlayer ? '#ffd23f' : color;
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, 14, w, 52, 16);
  else ctx.rect(x, 14, w, 52);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = isPlayer ? '#3a2a06' : '#ffffff';
  ctx.fillText(name, 128, 41);

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  labelCache.set(key, t);
  return t;
}

const ease = (k: number, dt: number) => 1 - Math.exp(-k * dt);
const _t = new THREE.Vector3();
const _h = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** 身体材质和它本来的透明设定（兰姐的菜袋本来就是半透明的，淡回去时不能变成实心）。 */
interface BodyMat {
  m: THREE.Material;
  opacity: number;
  transparent: boolean;
}

/**
 * 单个角色：正式模型 + 影子、配色地环、抓环、昵称、玩家指示箭头。
 *
 * 节点层级：group（位置、朝向）→ lean（踉跄，绕脚底歪）→ flop（摔倒/被拎/被扔，绕腰转）→ 模型。
 * 脚下的标记挂在 group 上，人怎么歪它们都平贴地面。
 */
export class Actor {
  group: THREE.Group;
  private lean = new THREE.Group();
  private flopG = new THREE.Group();
  private body: CharacterBody;
  private pose: Pose = emptyPose();
  private materials: THREE.Material[] = [];
  private grabRing: THREE.Mesh;
  private colorRing: THREE.Mesh;
  /** 抓人时双手前伸、抓扶手时单手够过去、摔倒/被拖/被扔时身体软掉的程度（0~1，平滑过渡用）。 */
  private reach = 0;
  private armLift = 0;
  private flop = 0;
  private sitBlend = 0;
  private nameLabel: THREE.Sprite;
  private labelMat: THREE.SpriteMaterial;
  /** 名字牌当前透明度与目标（由 ActorManager 做屏幕空间去重后给出）。 */
  labelAlpha = 1;
  labelTarget = 1;
  readonly isPlayer: boolean;
  private arrow: THREE.Mesh | null = null;
  private labelBaseW: number;
  private labelBaseH: number;
  private selfMarkers = true;
  private lastX = 0;
  private lastZ = 0;
  /** 平滑后的实际移动速度（世界单位/秒），走跑动作的播放速率跟着它。 */
  private speed = 0;
  /** 推挤动作计时（定时动作，不能读 status —— 它下一帧就被覆盖回 idle 了）。 */
  private pushTimer = 0;
  /** 淘汰摔飞演出。 */
  private ko: {
    t: number; dx: number; dz: number; x0: number; z0: number;
    /** 落地时刻（-1 = 还在空中）、落地后沿 z 的相对速度与累计位移。 */
    landT: number; vz: number; slide: number;
    done: boolean;
  } | null = null;
  /** 摔下车后的淡出系数，和挡视线淡出相乘。 */
  private koAlpha = 1;
  private shadow: THREE.Mesh;
  /** 由 ActorManager 在每帧 update 前设置。 */
  ground: GroundInfo | null = null;
  /** 离镜头太近时的名字牌淡出系数（0~1）。 */
  labelNear = 1;
  /** 身体材质（不含脚下的环、影子这类标记），挡视线时整体淡出。 */
  private bodyMats: BodyMat[] = [];
  private bodyAlpha = 1;
  /** 由 ActorManager 每帧给出：这个人是否挡在镜头和玩家之间。 */
  occluding = false;
  /** 抓扶手用哪只手：0 = 左，1 = 右（离扶手近的那只）。 */
  private railHand: 0 | 1 = 1;
  /** 坐下时身体下沉多少（负数），由模型的腿长算出。 */
  private sitLift: number;

  constructor(defId: string, color: string, name: string, isPlayer: boolean) {
    this.isPlayer = isPlayer;
    this.group = new THREE.Group();
    this.body = new CharacterBody(defId, color);
    this.group.add(this.lean);
    this.lean.add(this.flopG);
    this.flopG.position.y = PIVOT;
    this.flopG.add(this.body.root);
    this.body.root.position.y = -PIVOT;
    this.sitLift = SEAT_TOP - SEAT_SINK - (this.body.thighHeight - THIGH_R);
    this.bodyMats = this.body.materials.map((m) => ({ m, opacity: m.opacity, transparent: m.transparent }));

    const shadow = new THREE.Mesh(GEO.shadow, SHARED.shadow);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.012;
    this.group.add(shadow);
    this.shadow = shadow;

    // 脚下的配色圆环：名字牌重叠时，这是分辨谁是谁的第二条线索。
    const ringMat = new THREE.MeshBasicMaterial({
      color: isPlayer ? 0xffd23f : new THREE.Color(color),
      transparent: true,
      opacity: isPlayer ? 0.95 : 0.62,
      side: THREE.DoubleSide
    });
    this.materials.push(ringMat);
    this.colorRing = new THREE.Mesh(GEO.ring, ringMat);
    this.colorRing.rotation.x = -Math.PI / 2;
    this.colorRing.position.y = 0.02;
    this.group.add(this.colorRing);

    this.grabRing = new THREE.Mesh(GEO.grabRing, SHARED.grab);
    this.grabRing.rotation.x = Math.PI / 2;
    this.grabRing.position.y = 0.05;
    this.grabRing.visible = false;
    this.group.add(this.grabRing);

    const s = isPlayer ? 1.28 : 1.0;
    const labelMat = new THREE.SpriteMaterial({
      map: labelTexture(name, color, isPlayer), transparent: true, depthTest: false, depthWrite: false
    });
    this.materials.push(labelMat);
    this.labelMat = labelMat;
    this.nameLabel = new THREE.Sprite(labelMat);
    this.labelBaseW = s;
    this.labelBaseH = s * 0.3125;
    this.nameLabel.scale.set(this.labelBaseW, this.labelBaseH, 1);
    this.nameLabel.position.y = CHAR_HEIGHT + (isPlayer ? 0.5 : 0.3);
    this.group.add(this.nameLabel);

    if (isPlayer) {
      // 玩家头顶的跳动箭头：8 个人里一眼找到自己。
      this.arrow = new THREE.Mesh(GEO.arrow, SHARED.playerArrow);
      this.arrow.rotation.x = Math.PI;
      this.arrow.position.y = CHAR_HEIGHT + 0.2;
      this.group.add(this.arrow);
    }
  }

  /**
   * 推挤动作。
   * simulation 里推挤是瞬时的，读 status 根本抓不到 —— 必须由 session 消费 push 事件来触发。
   */
  playPush() {
    this.pushTimer = PUSH_DUR;
  }

  /**
   * 淘汰摔飞。dir 是被推出去的方向（世界 xz）。
   * 原来只是原地压扁缩没，读起来像 bug 不像"被挤下车"。
   */
  playEliminate(dx: number, dz: number, x0: number, z0: number) {
    if (this.ko) return;
    const len = Math.hypot(dx, dz) || 1;
    this.ko = { t: 0, dx: dx / len, dz: dz / len, x0, z0, landT: -1, vz: 0, slide: 0, done: false };
  }

  /**
   * 越肩贴身时隐藏玩家自己的名字牌和头顶箭头。
   * 镜头本身已经回答了"哪个是我"，这两个标记挂在屏幕正中央反而挡视线。
   */
  setSelfMarkersVisible(v: boolean) {
    this.selfMarkers = v;
  }

  /** 把车厢坐标里的点换成"从肩膀出发"的模型空间方向（只看朝向，不管踉跄歪斜）。 */
  private aimFrom(side: 0 | 1, target: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    _t.set(target.x - this.group.position.x, target.y - this.group.position.y, target.z - this.group.position.z)
      .applyAxisAngle(Y_AXIS, -this.group.rotation.y);
    return out.set(_t.x - (side === 0 ? SHOULDER_X : -SHOULDER_X), _t.y - SHOULDER_Y, _t.z);
  }

  update(state: CharacterState, t: number, dt: number, camPos: THREE.Vector3, world: ActorWorld) {
    this.group.position.x = state.pos.x;
    this.group.position.z = state.pos.z;
    this.group.rotation.y = state.facing;
    const p = resetPose(this.pose);

    // 被挤下车：演完摔飞再消失。
    if (state.status === 'eliminated') {
      this.nameLabel.visible = false;
      if (this.arrow) this.arrow.visible = false;
      if (!this.ko) this.playEliminate(1, 0, state.pos.x, state.pos.z);
      this.colorRing.visible = false;
      this.grabRing.visible = false;
      this.shadow.visible = false;
      this.updateKnockout(this.ko!, dt);
      this.body.locomotion(0, dt);
      const tt = this.ko!.t;
      p.armOut[0] = 2.2 + Math.sin(tt * 11) * 0.4;
      p.armOut[1] = 2.2 + Math.sin(tt * 13 + 1) * 0.4;
      p.legFwd[0] = 0.7 + Math.sin(tt * 10) * 0.4;
      p.legFwd[1] = -0.5 + Math.sin(tt * 12) * 0.4;
      this.body.applyPose(p);
      return;
    }
    if (this.ko) {
      // 新回合：把摔飞演出的残留变换清干净。
      this.ko = null;
      this.koAlpha = 1;
      this.flopG.rotation.set(0, 0, 0);
      this.shadow.visible = true;
    }

    this.group.visible = true;
    this.nameLabel.visible = this.selfMarkers;

    const down = state.status === 'down';
    const carried = state.status === 'carried';
    const thrown = state.status === 'thrown';
    const limp = down || carried || thrown;
    const sitting = state.status === 'sitting';

    // 走跑：步频跟实际位移速度走，慢走时脚才不打滑。
    const moved = Math.hypot(state.pos.x - this.lastX, state.pos.z - this.lastZ);
    this.lastX = state.pos.x;
    this.lastZ = state.pos.z;
    const speed = dt > 1e-4 ? Math.min(12, moved / dt) : 0;
    this.speed += ((sitting || limp ? 0 : speed) - this.speed) * ease(12, dt);
    this.body.locomotion(this.speed, dt);

    let y = 0;
    let leanX = 0;
    let leanZ = 0;

    // ---- 坐下：大腿放平、小腿垂下、双手搭在腿上；整个人下沉并往靠背挪 ----
    this.sitBlend += ((sitting ? 1 : 0) - this.sitBlend) * ease(12, dt);
    const sb = this.sitBlend;
    if (sb > 0.001) {
      // 膝盖弯得比直角小一点：小腿垂直的话鞋尖会戳进座椅底座。
      p.legFwd[0] = p.legFwd[1] = 1.45 * sb;
      p.knee[0] = p.knee[1] = 1.2 * sb;
      p.armFwd[0] = p.armFwd[1] = 0.45 * sb;
      p.elbow[0] = p.elbow[1] = 0.8 * sb;
      p.spineFwd = -0.06 * sb;
    }
    this.body.root.position.y = -PIVOT + this.sitLift * sb;
    this.body.root.position.z = -SIT_BACK * sb;

    // ---- 抓扶手：离扶手近的那只手伸过去握住；抓人：双手伸向对方 ----
    const holdRail = state.hold?.kind === 'rail';
    const holdChar = state.hold?.kind === 'char';
    this.armLift += ((holdRail ? 1 : 0) - this.armLift) * ease(11, dt);
    this.reach += ((holdChar ? 1 : 0) - this.reach) * ease(14, dt);
    if (holdRail && state.hold) {
      const a = world.railAnchor(state.hold.id);
      if (a) {
        _t.set(a.x - state.pos.x, 0, a.z - state.pos.z).applyAxisAngle(Y_AXIS, -state.facing);
        this.railHand = _t.x >= 0 ? 0 : 1;
        this.aimFrom(this.railHand, a, p.aim[this.railHand]);
      }
    }
    if (this.armLift > 0.001) {
      p.aimW[this.railHand] = this.armLift;
      p.straight[this.railHand] = this.armLift;
    }
    if (this.reach > 0.001 && state.hold?.kind === 'char') {
      const v = world.characters[state.hold.id];
      if (v) {
        const vLimp = v.status === 'down' || v.status === 'carried';
        _h.set(v.pos.x, vLimp ? 0.6 : 1.15, v.pos.z);
        this.aimFrom(0, _h, p.aim[0]);
        this.aimFrom(1, _h, p.aim[1]);
        for (const i of [0, 1] as const) {
          p.aimW[i] = Math.max(p.aimW[i], this.reach);
          p.straight[i] = Math.max(p.straight[i], this.reach);
        }
        p.spineFwd += (vLimp ? 0.35 : 0.15) * this.reach;
      }
    }

    // ---- 推挤 / 踉跄。推挤优先 ----
    if (this.pushTimer > 0) {
      this.pushTimer -= dt;
      // 蓄力(0~0.06，收肘后拉) → 爆发(0.06~0.12，双掌平推出去) → 定住(~0.2) → 收回。
      const e = PUSH_DUR - this.pushTimer;
      const fwd = e < 0.06
        ? -0.4 * (e / 0.06)
        : e < 0.12
          ? -0.4 + 1.85 * ((e - 0.06) / 0.06)
          : e < 0.2
            ? 1.45
            : 1.45 * Math.max(0, 1 - (e - 0.2) / 0.1);
      const bend = e < 0.06 ? 1.3 * (e / 0.06) : Math.max(0, 1.3 - 22 * (e - 0.06));
      for (const i of [0, 1] as const) {
        p.armFwd[i] = fwd;
        p.armOut[i] = -0.15;
        p.straight[i] = 1;
        p.elbow[i] = bend;
        p.aimW[i] *= 0.2;
      }
      p.spineFwd += e < 0.06 ? -0.15 : 0.3;
    } else if (!sitting && (state.stunTimer > 0 || state.balance < WOBBLE_BELOW)) {
      // 踉跄：被推的硬直，或平衡值偏低时站不稳。往受力的反方向后仰、双臂乱挥、叠一层抖动。
      const k = Math.min(1, Math.max(state.stunTimer / STUN_REF, (WOBBLE_BELOW - state.balance) / WOBBLE_BELOW));
      const localAngle = Math.atan2(state.vel.x, state.vel.z) - state.facing;
      const sway = Math.sin(t * 7 + state.id) * 0.1 * k;
      leanX = -0.22 * k * Math.cos(localAngle) + sway;
      leanZ = 0.22 * k * Math.sin(localAngle) + Math.cos(t * 6 + state.id) * 0.08 * k;
      p.armOut[0] += (1.0 + Math.sin(t * 13) * 0.45) * k;
      p.armOut[1] += (1.0 + Math.sin(t * 11 + 1) * 0.45) * k;
      p.armFwd[0] += Math.sin(t * 9) * 0.6 * k;
      p.armFwd[1] += Math.cos(t * 8) * 0.6 * k;
      p.spineFwd -= 0.2 * k;
      p.legFwd[0] += 0.3 * k;
      y += Math.abs(Math.sin(t * 19)) * 0.02 * k;
    }

    // ---- 摔倒 / 被拖 / 被扔：身体软掉，绕腰转。和站姿之间平滑过渡，不会一帧突变 ----
    this.flop += ((limp ? 1 : 0) - this.flop) * ease(limp ? 16 : 7, dt);
    let fx = 0;
    let fz = 0;
    let fy = PIVOT;
    const f = this.flop;
    if (f > 0.001) {
      // 瘫在地上（仰面）：四肢摊开，偶尔抽一下，看得出是"晕了"而不是"死了"。
      fx = -Math.PI / 2;
      fy = LIE_Y + Math.max(0, Math.sin(t * 5 + state.id)) * 0.015;
      fz = Math.sin(t * 2.3 + state.id) * 0.05;
      let aF = 0.3 + Math.sin(t * 3 + state.id) * 0.15;
      let aO = 1.1 + Math.cos(t * 3.4 + state.id) * 0.15;
      let lF = 0.2;
      let kn = 0.35;
      let hd = -0.25;
      if (carried) {
        // 被夹在拖人者身前：脸朝下横着吊起来，四肢往下耷拉、跟着步子晃。
        fx = 1.4;
        fz = Math.sin(t * 6 + state.id) * 0.12;
        fy = 0.55 + Math.sin(t * 9) * 0.04;
        aF = 1.35 + Math.sin(t * 8) * 0.3;
        aO = 0.2;
        lF = 1.0 + Math.sin(t * 7) * 0.25;
        kn = 0.5 + Math.sin(t * 7 + 1.7) * 0.2;
        hd = 0.5;
      } else if (thrown) {
        // 飞在空中：抛物线 + 翻滚 + 四肢乱甩。
        const u = state.airDur > 0 ? Math.min(1, state.airT / state.airDur) : 1;
        fy = 0.6 + 4 * THROW_ARC * u * (1 - u);
        fx = -0.6 + u * 5.5;
        fz = Math.sin(u * 9) * 0.6;
        aF = Math.sin(t * 17) * 0.8;
        aO = 2.2 + Math.sin(t * 15 + 1) * 0.4;
        lF = 0.8 + Math.sin(t * 13) * 0.6;
        kn = 0.7;
        hd = 0.3;
      }
      for (const i of [0, 1] as const) {
        p.armFwd[i] += (aF - p.armFwd[i]) * f;
        p.armOut[i] += (aO - p.armOut[i]) * f;
        p.elbow[i] *= 1 - f;
        p.aimW[i] *= 1 - f;
        p.straight[i] += (0.7 - p.straight[i]) * f;
        p.legFwd[i] += ((i === 0 ? lF : lF * 0.6) - p.legFwd[i]) * f;
        p.knee[i] += (kn - p.knee[i]) * f;
      }
      p.headFwd += (hd - p.headFwd) * f;
    }
    this.flopG.rotation.x = fx * f;
    this.flopG.rotation.z = fz * f;
    this.flopG.position.y = PIVOT + (fy - PIVOT) * f;
    this.body.applyPose(p);

    this.group.position.y = y;
    this.lean.rotation.x = leanX * (1 - f);
    this.lean.rotation.z = leanZ * (1 - f);

    this.grabRing.visible = holdRail;
    this.colorRing.visible = state.alive && !carried && !thrown;
    this.shadow.visible = !thrown;
    if (this.arrow) {
      this.arrow.visible = this.selfMarkers;
      this.arrow.position.y = CHAR_HEIGHT + 0.2 + Math.sin(t * 5) * 0.09;
    }

    // 透视下 Sprite 的世界尺寸会近大远小：做"部分补偿"，夹在 0.6~1.7 之间，
    // 既保证远处可读，又保留"谁近谁远"的深度线索。
    const dist = Math.hypot(
      camPos.x - state.pos.x,
      camPos.y - this.group.position.y,
      camPos.z - state.pos.z
    );
    const distK = Math.min(1.7, Math.max(0.6, dist / LABEL_REF_DIST));
    this.labelNear = Math.min(1, Math.max(0, (dist - LABEL_NEAR_HIDE) / (LABEL_NEAR_FULL - LABEL_NEAR_HIDE)));
    this.nameLabel.scale.set(this.labelBaseW * distK, this.labelBaseH * distK, 1);
    // 近的名字牌盖住远的。
    this.nameLabel.renderOrder = 900 + Math.round((LABEL_MAX_DIST - Math.min(dist, LABEL_MAX_DIST)) * 8);
  }

  /**
   * 摔下车：抛物线飞出车门，落在真实地面上弹一下，然后躺平淡出。
   *
   * 落点高度由 SceneryView 提供（车外的人行道比车厢地板低 0.82）；车在开的时候，
   * 落地的人会被地面摩擦带着往车尾方向滚远（车厢坐标系里地面在往 -z 走）。
   */
  private updateKnockout(k: NonNullable<Actor['ko']>, dt: number) {
    if (k.done) {
      this.group.visible = false;
      return;
    }
    k.t += dt;
    const tt = k.t;
    const g = this.ground;
    const travel = 2.6 * (1 - Math.exp(-3 * tt));
    const x = k.x0 + k.dx * travel;
    const zAir = k.z0 + k.dz * travel;
    const floor = g ? g.heightAt(x, zAir + k.slide) : 0;
    let y: number;
    this.lean.rotation.set(0, 0, 0);
    if (k.landT < 0) {
      y = 3.4 * tt - 5.5 * tt * tt;
      // 过了抛物线顶点、又低于地面，就算落地。
      if (tt > 0.31 && y <= floor) {
        k.landT = tt;
        y = floor;
      }
      // 翻滚 + 四肢摊开：ragdoll 的最廉价替代。
      this.flopG.rotation.z = tt * 8.2;
      this.flopG.rotation.x = Math.sin(tt * 9) * 0.5;
      this.flopG.position.y = PIVOT;
    } else {
      const tl = tt - k.landT;
      // 离开车厢后，地面摩擦把他的相对速度拉向"地面速度"：车在开，人就被甩在后面。
      const drift = g ? g.driftZ : 0;
      k.vz += (drift - k.vz) * ease(4, dt);
      k.slide += k.vz * dt;
      y = floor + Math.max(0, 1.3 * tl - 7 * tl * tl);
      // 躺平；滑得越快滚得越快。
      this.flopG.rotation.x = -Math.PI / 2;
      this.flopG.rotation.z += (Math.abs(k.vz) / 0.45) * dt;
      this.flopG.position.y = LIE_Y;
      const moving = Math.abs(drift) > 1.5;
      const rest = moving ? KO_REST_MOVING : KO_REST_STILL;
      this.koAlpha = Math.max(0, 1 - Math.max(0, tl - rest) / KO_FADE);
      if (this.koAlpha <= 0 || tt > KO_MAX) k.done = true;
    }
    this.group.position.set(x, y, zAir + k.slide);
    this.group.visible = !k.done;
  }

  /** 挡视线淡出：只在淡出过程中切透明，平时恢复每件材质本来的设定，免得多一轮排序。 */
  applyOcclusion(dt: number) {
    const target = (this.occluding ? OCCLUDER_ALPHA : 1) * this.koAlpha;
    if (Math.abs(this.bodyAlpha - target) < 1e-3) {
      if (this.bodyAlpha === target) return;
      this.bodyAlpha = target;
    } else {
      this.bodyAlpha += (target - this.bodyAlpha) * ease(10, dt);
    }
    const solid = this.bodyAlpha > 0.995;
    for (const b of this.bodyMats) {
      // 必须走 setMaterialTransparent：只改 transparent 标记，编译过的不透明着色器仍然输出实心。
      setMaterialTransparent(b.m, solid ? b.transparent : true);
      b.m.opacity = solid ? b.opacity : b.opacity * this.bodyAlpha;
    }
  }

  /** 名字牌精灵（给 ActorManager 做屏幕空间去重用）。 */
  get label(): THREE.Sprite {
    return this.nameLabel;
  }

  /** 名字牌淡入淡出：去重和近距淡出都走这里，避免名字牌一帧闪现一帧消失。 */
  applyLabelAlpha(dt: number) {
    const target = this.labelTarget * this.labelNear;
    this.labelAlpha += (target - this.labelAlpha) * ease(12, dt);
    this.labelMat.opacity = this.labelAlpha;
    if (this.labelAlpha < 0.02) this.nameLabel.visible = false;
  }

  /** 抓扶手那只手的世界坐标，用来画到扶手的连接线。 */
  handPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.body.hand(this.railHand).getWorldPosition(out);
  }

  dispose() {
    this.body.dispose();
    for (const m of this.materials) m.dispose();
  }
}

/**
 * 让区间 [c-h, c+h] 落进 [lo, hi] 需要平移多少。放不下（牌子比可用区域还宽）就不挪。
 */
function shiftInto(c: number, h: number, lo: number, hi: number): number {
  if (2 * h >= hi - lo) return 0;
  if (c - h < lo) return lo - (c - h);
  if (c + h > hi) return hi - (c + h);
  return 0;
}

/** 管理全部角色。 */
export class ActorManager {
  private actors = new Map<number, Actor>();
  private group = new THREE.Group();

  setRoster(characters: CharacterState[]) {
    // 旧的人偶必须 dispose：只 remove 会让每局重开都漏一份材质。
    for (const a of this.actors.values()) {
      this.group.remove(a.group);
      a.dispose();
    }
    this.actors.clear();
    for (const c of characters) {
      const a = new Actor(c.defId, c.color, c.name, c.isPlayer);
      this.actors.set(c.id, a);
      this.group.add(a.group);
    }
  }

  get(id: number): Actor | undefined {
    return this.actors.get(id);
  }

  private camera: THREE.PerspectiveCamera | null = null;
  private tmpV = new THREE.Vector3();

  /** 用来把名字牌投影到屏幕上做去重；不设置时只做近距淡出。 */
  setCamera(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  private ground: GroundInfo | null = null;

  /** 车外地面信息（摔下车的人落在哪、被甩多远）。不设置时按车厢地板高度处理。 */
  setGround(g: GroundInfo) {
    this.ground = g;
  }

  private railAnchorFn: (id: number) => THREE.Vector3 | null = () => null;

  /** 扶手握把在车厢坐标里的位置（抓扶手时手伸过去）。由 BusView 提供。 */
  setRailAnchor(fn: (id: number) => THREE.Vector3 | null) {
    this.railAnchorFn = fn;
  }

  update(characters: CharacterState[], t: number, dt: number, camPos: THREE.Vector3) {
    const world: ActorWorld = { characters, railAnchor: this.railAnchorFn };
    for (const c of characters) {
      const a = this.actors.get(c.id);
      if (!a) continue;
      a.ground = this.ground;
      a.update(c, t, dt, camPos, world);
    }
    this.declutterLabels(camPos);
    this.markOccluders(characters, camPos);
    for (const a of this.actors.values()) {
      a.applyLabelAlpha(dt);
      a.applyOcclusion(dt);
    }
  }

  private scrA = new THREE.Vector3();
  private scrB = new THREE.Vector3();

  /** 角色身体在屏幕上的包围框（NDC）和到镜头的深度；在镜头背后返回 null。 */
  private screenBox(x: number, z: number, cam: THREE.PerspectiveCamera) {
    const foot = this.scrA.set(x, 0, z).applyMatrix4(cam.matrixWorldInverse);
    const depth = -foot.z;
    if (depth < 0.1) return null;
    const P = cam.projectionMatrix.elements;
    const hw = (BODY_HALF_W * P[0]) / depth;
    const a = this.scrA.set(x, 0, z).project(cam);
    const b = this.scrB.set(x, BODY_TOP, z).project(cam);
    return { x0: a.x - hw, x1: a.x + hw, y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y), depth };
  }

  /** 找出在屏幕上盖住玩家的人，交给各自淡出。玩家不在场时全部恢复不透明。 */
  private markOccluders(characters: CharacterState[], _camPos: THREE.Vector3) {
    for (const a of this.actors.values()) a.occluding = false;
    const cam = this.camera;
    const me = characters.find((c) => c.isPlayer);
    if (!cam || !me || !me.alive) return;
    const pb = this.screenBox(me.pos.x, me.pos.z, cam);
    if (!pb) return;
    const pArea = (pb.x1 - pb.x0) * (pb.y1 - pb.y0);
    for (const c of characters) {
      if (c.isPlayer || !c.alive) continue;
      const a = this.actors.get(c.id);
      const ob = this.screenBox(c.pos.x, c.pos.z, cam);
      if (!a || !ob || ob.depth >= pb.depth - 0.3) continue;
      const ox = Math.max(0, Math.min(pb.x1, ob.x1) - Math.max(pb.x0, ob.x0));
      const oy = Math.max(0, Math.min(pb.y1, ob.y1) - Math.max(pb.y0, ob.y0));
      a.occluding = ox * oy > pArea * OCCLUDER_COVER;
    }
  }

  private zones: { x0: number; x1: number; y0: number; y1: number }[] = [];
  private zonesAge = Infinity;

  /**
   * 摇杆和动作按钮在屏幕上占的区域（NDC）。名字牌不能压在上面 —— 那是玩家拇指底下。
   *
   * 直接量 DOM：按钮尺寸随屏幕高度缩放（平板放大 1.4 倍），摇杆按下时还会跟着手指走，
   * 写死坐标一定会错。用 offsetLeft/offsetTop 累加到 #stage：这是舞台内的布局坐标，
   * 强制横屏把舞台 rotate(90°) 之后依然成立（getBoundingClientRect 就不行了）。
   * 每 0.5 秒量一次，布局变化（旋转、缩放）最多滞后半秒。
   */
  private controlZones() {
    if (this.zonesAge < 30) return this.zones;
    this.zonesAge = 0;
    const stage = document.getElementById('stage');
    const hud = document.getElementById('hud');
    if (!stage || !hud || hud.classList.contains('hidden')) return (this.zones = []);
    const W = stage.offsetWidth || 1;
    const H = stage.offsetHeight || 1;
    const PAD = 8;
    this.zones = ['#joystick-base', '#btn-push', '#btn-dash', '#btn-grab'].flatMap((sel) => {
      const el = hud.querySelector(sel) as HTMLElement | null;
      if (!el || !el.offsetWidth) return [];
      let x = 0;
      let y = 0;
      for (let n: HTMLElement | null = el; n && n !== stage; n = n.offsetParent as HTMLElement | null) {
        x += n.offsetLeft;
        y += n.offsetTop;
      }
      // 摇杆底座按下时用 transform 平移到手指下，offset 量不到这部分，额外留一圈。
      const extra = sel === '#joystick-base' ? el.offsetWidth * 0.5 : 0;
      const l = x - PAD - extra;
      const r = x + el.offsetWidth + PAD + extra;
      const t = y - PAD - extra;
      const b = y + el.offsetHeight + PAD + extra;
      return [{ x0: (l / W) * 2 - 1, x1: (r / W) * 2 - 1, y0: 1 - (b / H) * 2, y1: 1 - (t / H) * 2 }];
    });
    return this.zones;
  }

  /**
   * 名字牌去重。
   *
   * 上车时 8 个人排成一列冲向后门，从背后看 8 个名字牌竖着叠成一摞，一个都读不出。
   * 规则：玩家自己的最先放，其余按离镜头由近到远放；和已放下的重叠太多就淡出。
   * 人散开之后名字牌会自然回来，所以不会丢信息，只是不在挤成一团时硬塞。
   */
  private declutterLabels(camPos: THREE.Vector3) {
    this.zonesAge++;
    const cam = this.camera;
    const list: { a: Actor; x: number; y: number; hw: number; hh: number; d: number }[] = [];
    for (const a of this.actors.values()) {
      const sp = a.label;
      a.labelTarget = 1;
      if (!sp.visible || !cam) continue;
      const wp = sp.getWorldPosition(this.tmpV);
      const d = wp.distanceTo(camPos);
      const viewZ = -wp.clone().applyMatrix4(cam.matrixWorldInverse).z;
      if (viewZ <= 0.05) {
        a.labelTarget = 0;
        continue;
      }
      wp.project(cam);
      const P = cam.projectionMatrix.elements;
      const hw = (sp.scale.x / 2) * P[0] / viewZ;
      const hh = (sp.scale.y / 2) * P[5] / viewZ;
      // 头顶（锚点）已经出了屏幕：人都看不见了，名字牌不该贴在屏幕边上冒出来。
      if (Math.abs(wp.x) > 1 || Math.abs(wp.y) > 1) {
        a.labelTarget = 0;
        sp.center.set(0.5, 0.5);
        continue;
      }
      // 锚点在屏幕里、牌子越出边缘：把牌子往里收。用 Sprite.center 平移，不动世界坐标。
      // 着色器里是 position - (center - 0.5)，所以要往右挪 ox，center.x 就减 ox / 牌宽。
      const ox = shiftInto(wp.x, hw, -1 + LABEL_EDGE_SIDE, 1 - LABEL_EDGE_SIDE);
      let oy = shiftInto(wp.y, hh, -1 + LABEL_EDGE_BOTTOM, 1 - LABEL_EDGE_TOP);
      // 压到摇杆或动作按钮上：往上挪到操作区上沿之外；挪完顶到状态栏就不显示。
      const cx = wp.x + ox;
      for (const z of this.controlZones()) {
        const cy = wp.y + oy;
        if (cx + hw > z.x0 && cx - hw < z.x1 && cy + hh > z.y0 && cy - hh < z.y1) oy += z.y1 - (cy - hh);
      }
      if (wp.y + oy + hh > 1 - LABEL_EDGE_TOP + 1e-3) {
        a.labelTarget = 0;
        sp.center.set(0.5, 0.5);
        continue;
      }
      sp.center.set(0.5 - ox / (2 * hw), 0.5 - oy / (2 * hh));
      list.push({ a, x: cx, y: wp.y + oy, d, hw, hh });
    }
    list.sort((p, q) => (p.a.isPlayer ? -1 : q.a.isPlayer ? 1 : p.d - q.d));
    const placed: typeof list = [];
    for (const it of list) {
      const area = 4 * it.hw * it.hh;
      const clash = placed.some((o) => {
        const ox = Math.max(0, Math.min(it.x + it.hw, o.x + o.hw) - Math.max(it.x - it.hw, o.x - o.hw));
        const oy = Math.max(0, Math.min(it.y + it.hh, o.y + o.hh) - Math.max(it.y - it.hh, o.y - o.hh));
        return ox * oy > area * LABEL_OVERLAP;
      });
      if (clash) it.a.labelTarget = 0;
      else placed.push(it);
    }
  }

  get root(): THREE.Group {
    return this.group;
  }

  dispose() {
    for (const a of this.actors.values()) {
      this.group.remove(a.group);
      a.dispose();
    }
    this.actors.clear();
  }
}
