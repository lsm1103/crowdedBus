import * as THREE from 'three';
import type { CharacterState } from '../domain/types';
import { BALANCE } from '../config/balance';
import { APPEARANCE, HAIR_SCALE } from '../config/appearance';
import { buildAccessories } from './accessories';
import { setMaterialTransparent } from './models';

/** 一步的世界距离。步频 = 速度 / 步长，这样慢走快走都不打滑。 */
const STRIDE = 0.62 * (BALANCE.characterRadius / 0.42);
/** 推挤动作时长。 */
const PUSH_DUR = 0.3;

/** 名字牌排序用的最大参考距离。 */
const LABEL_MAX_DIST = 18;
/** 名字牌尺寸补偿的参考距离：太近不放大到糊脸，太远不小到看不清。 */
const LABEL_REF_DIST = 4;

/** 人偶按碰撞半径等比放大：车厢收窄后光靠缩车厢还不够挤。 */
const MODEL_SCALE = BALANCE.characterRadius / 0.42;

/**
 * 坐姿对齐。座垫顶面在 y=0.46（scripts/blender/build_models.py 的座椅）。
 * 占位人偶是"豆子"体型：躯干胶囊的下端（未缩放 0.14）就是屁股，腿只是露在前面的短桩。
 * 以前整体下沉 0.5，躯干直接穿过座垫插进地板；现在让屁股落在座垫上、略陷进去一点。
 * 换正式角色模型时，只需要把 PELVIS_Y 换成新模型髋部的高度。
 */
const SEAT_TOP = 0.46;
const PELVIS_Y = 0.14;
const SEAT_SINK = 0.08;
const SIT_LIFT = SEAT_TOP - PELVIS_Y * MODEL_SCALE - SEAT_SINK;

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

/**
 * 挡视线淡出。越肩镜头从玩家背后斜着往下看，站在镜头和玩家之间的人会把玩家整个盖住。
 * 判定放在屏幕空间里做：离镜头更近、且在屏幕上盖住玩家身体超过 OCCLUDER_COVER 的人淡成虚影。
 * （三维里"离视线近"不行：镜头高，视线从挡路人的头顶上方一米多穿过，但画面上照样盖住了人。）
 */
const BODY_TOP = 1.9 * MODEL_SCALE;
const BODY_HALF_W = 0.42 * MODEL_SCALE;
const OCCLUDER_COVER = 0.25;
const OCCLUDER_ALPHA = 0.28;

/** 每个角色技能的标识色与图标，释放时用来做可区分的表现。 */
export const SKILL_LOOK: Record<string, { color: number; icon: string }> = {
  xiaoli: { color: 0x3b82f6, icon: '💼' },
  xiaoxia: { color: 0x22c1a6, icon: '💨' },
  aqiang: { color: 0xf59e0b, icon: '🛡️' },
  lanjie: { color: 0xef4444, icon: '🧺' },
  ayuan: { color: 0x8b5cf6, icon: '🧳' },
  xiaomai: { color: 0xec4899, icon: '📣' },
  amo: { color: 0x64748b, icon: '🌀' },
  laozhou: { color: 0x84cc16, icon: '💤' }
};

function darken(hex: string, f: number): number {
  const c = new THREE.Color(hex);
  c.multiplyScalar(f);
  return c.getHex();
}

/** 共享几何体：8 个人偶用同一批 geometry，只有材质按颜色分。 */
const GEO = {
  torso: new THREE.CapsuleGeometry(0.3, 0.36, 6, 12),
  arm: new THREE.CapsuleGeometry(0.1, 0.3, 5, 8),
  leg: new THREE.CapsuleGeometry(0.115, 0.22, 5, 8),
  head: new THREE.SphereGeometry(0.3, 16, 14),
  hair: new THREE.SphereGeometry(0.305, 16, 12),
  eye: new THREE.SphereGeometry(0.038, 8, 8),
  shadow: new THREE.CircleGeometry(0.46, 20),
  ring: new THREE.RingGeometry(0.44, 0.56, 26),
  grabRing: new THREE.TorusGeometry(0.6, 0.048, 8, 22),
  skillRing: new THREE.TorusGeometry(0.52, 0.045, 8, 24),
  arrow: new THREE.ConeGeometry(0.19, 0.34, 4)
};

const SHARED = {
  skin: new THREE.MeshLambertMaterial({ color: 0xf2c9a0 }),
  hair: new THREE.MeshLambertMaterial({ color: 0x263141 }),
  eye: new THREE.MeshLambertMaterial({ color: 0x1b2733 }),
  shadow: new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.24 }),
  grab: new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.9 }),
  playerArrow: new THREE.MeshBasicMaterial({ color: 0xffd23f })
};

const labelCache = new Map<string, THREE.CanvasTexture>();
const iconCache = new Map<string, THREE.CanvasTexture>();

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

/** 技能图标：释放瞬间在头顶弹出来，玩家才知道"我刚才放了什么"。 */
function iconTexture(icon: string): THREE.Texture {
  const hit = iconCache.get(icon);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.beginPath();
  ctx.arc(64, 64, 56, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = '68px "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(icon, 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  iconCache.set(icon, t);
  return t;
}

/** 单个人偶（含影子、配色地环、抓环、技能状态环、昵称、玩家指示箭头）。 */
export class Actor {
  group: THREE.Group;
  private rig = new THREE.Group();
  private materials: THREE.Material[] = [];
  private grabRing: THREE.Mesh;
  private colorRing: THREE.Mesh;
  private skillRing: THREE.Mesh;
  private skillRingMat: THREE.MeshBasicMaterial;
  private skillIcon: THREE.Sprite;
  private skillIconMat: THREE.SpriteMaterial;
  private iconTimer = 0;
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
  /** 两条手臂及其"手"锚点，用来抬手抓扶手并把连接线从手掌连出去。 */
  private armL: THREE.Mesh;
  private armR: THREE.Mesh;
  private legL: THREE.Mesh;
  private legR: THREE.Mesh;
  private head!: THREE.Group;
  /** 步态相位。步频跟实际速度成正比，否则慢走时脚会打滑。 */
  private gait = 0;
  private lastX = 0;
  private lastZ = 0;
  private speed01 = 0;
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
  private shadow!: THREE.Mesh;
  /** 由 ActorManager 在每帧 update 前设置。 */
  ground: GroundInfo | null = null;
  private sitBlend = 0;
  private handL = new THREE.Object3D();
  private handR = new THREE.Object3D();
  private armLift = 0;
  /** 离镜头太近时的名字牌淡出系数（0~1）。 */
  labelNear = 1;
  /** 身体材质（不含脚下的环、影子这类标记），挡视线时整体淡出。 */
  private bodyMats: THREE.Material[] = [];
  private bodyAlpha = 1;
  /** 由 ActorManager 每帧给出：这个人是否挡在镜头和玩家之间。 */
  occluding = false;
  private liftRight = true;

  constructor(defId: string, color: string, name: string, isPlayer: boolean) {
    this.isPlayer = isPlayer;
    this.group = new THREE.Group();
    this.rig.scale.setScalar(MODEL_SCALE);
    this.group.add(this.rig);

    // 外观规格：把大厅立绘里"隔几米一眼能认出"的特征做进对局模型。
    // 找不到规格时退回按角色配色（保证新增角色不会崩）。
    const look = APPEARANCE[defId] ?? {
      top: new THREE.Color(color).getHex(), bottom: darken(color, 0.6),
      hair: 0x263141, hairStyle: 'short' as const,
      accent: new THREE.Color(color).getHex(), accessories: []
    };
    const mainMat = new THREE.MeshLambertMaterial({ color: look.top });
    const legMat = new THREE.MeshLambertMaterial({ color: look.bottom });
    const hairMat = new THREE.MeshLambertMaterial({ color: look.hair });
    this.materials.push(mainMat, legMat, hairMat);

    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, rz = 0) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.rotation.z = rz;
      this.rig.add(mesh);
      return mesh;
    };

    // 模型正面朝 +z：rotation.y = facing 时，脸正好朝着移动方向。
    add(GEO.torso, mainMat, 0, 0.62, 0);
    this.armL = add(GEO.arm, mainMat, -0.36, 0.62, 0, -0.2);
    this.armR = add(GEO.arm, mainMat, 0.36, 0.62, 0, 0.2);
    // 手在胶囊远离肩膀的那一端；挂成子节点后，手臂怎么转它都跟着，
    // getWorldPosition 拿到的就是真实手掌位置。
    this.handL.position.set(0, -0.26, 0);
    this.handR.position.set(0, -0.26, 0);
    this.armL.add(this.handL);
    this.armR.add(this.handR);
    this.legL = add(GEO.leg, legMat, -0.14, 0.2, 0);
    this.legR = add(GEO.leg, legMat, 0.14, 0.2, 0);
    // 头做成独立节点：配件（头带/头巾/颈枕/耳机/眼罩）挂在它下面才会跟着头动。
    const head = new THREE.Group();
    head.position.set(0, 1.16, 0);
    this.rig.add(head);
    this.head = head;
    head.add(new THREE.Mesh(GEO.head, SHARED.skin));
    const hairMesh = new THREE.Mesh(GEO.hair, hairMat);
    hairMesh.position.set(0, 0.08, -0.03);
    hairMesh.scale.set(...HAIR_SCALE[look.hairStyle]);
    head.add(hairMesh);
    for (const sx of [-0.11, 0.11]) {
      const eye = new THREE.Mesh(GEO.eye, SHARED.eye);
      eye.position.set(sx, 0.01, 0.265);
      head.add(eye);
    }

    const shadow = new THREE.Mesh(GEO.shadow, SHARED.shadow);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.012;
    this.rig.add(shadow);
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
    this.rig.add(this.colorRing);

    this.grabRing = new THREE.Mesh(GEO.grabRing, SHARED.grab);
    this.grabRing.rotation.x = Math.PI / 2;
    this.grabRing.position.y = 0.05;
    this.grabRing.visible = false;
    this.rig.add(this.grabRing);

    // 持续型技能的状态环：技能还在生效时一直挂着，不是闪一下就没。
    this.skillRingMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide
    });
    this.materials.push(this.skillRingMat);
    this.skillRing = new THREE.Mesh(GEO.skillRing, this.skillRingMat);
    this.skillRing.rotation.x = Math.PI / 2;
    this.skillRing.position.y = 0.9;
    this.skillRing.visible = false;
    this.rig.add(this.skillRing);

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
    this.nameLabel.position.y = (isPlayer ? 1.88 : 1.66) * MODEL_SCALE + 0.22;
    this.group.add(this.nameLabel);

    this.skillIconMat = new THREE.SpriteMaterial({
      map: iconTexture('💼'), transparent: true, depthTest: false, depthWrite: false
    });
    this.materials.push(this.skillIconMat);
    this.skillIcon = new THREE.Sprite(this.skillIconMat);
    this.skillIcon.scale.set(0.72, 0.72, 1);
    this.skillIcon.visible = false;
    this.group.add(this.skillIcon);

    // 配件必须在头部节点建好之后挂 —— 放在手臂那一段会拿到 undefined 的 head。
    // 材质由 buildAccessories 新建，push 进 materials 随 dispose 一起释放。
    this.materials.push(...buildAccessories(look, {
      head: this.head, hip: this.rig, handL: this.handL, handR: this.handR
    }));

    this.collectBodyMaterials([shadow, this.colorRing, this.grabRing, this.skillRing]);

    if (isPlayer) {
      // 玩家头顶的跳动箭头：8 个同款人偶里一眼找到自己。
      this.arrow = new THREE.Mesh(GEO.arrow, SHARED.playerArrow);
      this.arrow.rotation.x = Math.PI;
      this.arrow.position.y = 1.5 * MODEL_SCALE + 0.2;
      this.group.add(this.arrow);
    }
  }

  /**
   * 推挤动作。
   * simulation 里 status='pushing' 下一 tick 就被覆盖回 walking/idle，
   * 所以读 status 根本抓不到推挤 —— 必须由 session 消费 push 事件来触发。
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

  /** 技能释放瞬间：头顶弹出该角色专属的技能图标。 */
  playSkill(defId: string) {
    const look = SKILL_LOOK[defId];
    if (!look) return;
    this.skillIconMat.map = iconTexture(look.icon);
    this.skillIconMat.needsUpdate = true;
    this.skillRingMat.color.setHex(look.color);
    this.iconTimer = 1.15;
  }

  /**
   * 越肩贴身时隐藏玩家自己的名字牌和头顶箭头。
   * 镜头本身已经回答了"哪个是我"，这两个标记是正交远机位时代的遗留，
   * 挂在屏幕正中央反而挡视线。
   */
  setSelfMarkersVisible(v: boolean) {
    this.selfMarkers = v;
  }

  update(state: CharacterState, t: number, dt: number, camPos: THREE.Vector3) {
    this.group.position.x = state.pos.x;
    this.group.position.z = state.pos.z;
    this.group.rotation.y = state.facing;

    // 被挤下车：最终淘汰和"下一站返场"都要演完摔飞再消失。
    // 以前返场的人当场凭空消失，看起来像 bug 而不是"被挤下去了"。
    const falling = state.status === 'eliminated' || (state.status === 'returning' && this.ko !== null);
    if (falling) {
      this.nameLabel.visible = false;
      this.skillIcon.visible = false;
      this.skillRing.visible = false;
      if (this.arrow) this.arrow.visible = false;
      if (!this.ko) this.playEliminate(1, 0, state.pos.x, state.pos.z);
      this.colorRing.visible = false;
      this.grabRing.visible = false;
      this.shadow.visible = false;
      this.updateKnockout(this.ko!, dt);
      return;
    }
    if (this.ko) {
      // 返场了：把摔飞演出的残留变换清干净。
      this.ko = null;
      this.koAlpha = 1;
      this.rig.rotation.set(0, 0, 0);
      this.shadow.visible = true;
    }

    if (state.status === 'returning') {
      this.group.visible = false;
      return;
    }

    // 受击保护期间闪烁，被推到了一眼能看出来。
    this.group.visible = state.hitProtect <= 0 || Math.floor(t * 14) % 2 === 0;
    this.group.scale.set(1, 1, 1);
    this.nameLabel.visible = this.selfMarkers;

    // 坐姿：整体下沉 + 大腿前伸。没有这个的话坐着的人看起来像站在椅子上。
    const sitting = state.status === 'sitting';
    this.sitBlend += ((sitting ? 1 : 0) - this.sitBlend) * (1 - Math.exp(-12 * dt));
    this.rig.position.y = SIT_LIFT * this.sitBlend;
    // 大腿放平搭在座垫上：腿的胶囊绕自身中心转，所以要同时往上、往前挪一点。
    this.legL.rotation.x = 1.35 * this.sitBlend;
    this.legR.rotation.x = 1.35 * this.sitBlend;
    this.legL.position.y = 0.2 + 0.06 * this.sitBlend;
    this.legR.position.y = 0.2 + 0.06 * this.sitBlend;
    this.legL.position.z = 0.16 * MODEL_SCALE * this.sitBlend;
    this.legR.position.z = 0.16 * MODEL_SCALE * this.sitBlend;

    // 步频跟实际位移速度成正比。原来是固定增量 `bobPhase += 0.35`，
    // 所以慢走时脚在"飘"；用真实速度驱动才不打滑。
    const moved = Math.hypot(state.pos.x - this.lastX, state.pos.z - this.lastZ);
    this.lastX = state.pos.x;
    this.lastZ = state.pos.z;
    const speed = dt > 1e-4 ? moved / dt : 0;
    this.speed01 += (Math.min(1, speed / BALANCE.walkSpeed) - this.speed01) * (1 - Math.exp(-14 * dt));
    if (!sitting) this.gait += (speed / STRIDE) * dt * Math.PI * 2;

    const walk = sitting ? 0 : this.speed01;
    this.group.position.y = sitting
      ? 0
      : Math.abs(Math.sin(this.gait)) * 0.06 * walk + Math.sin(t * 2) * 0.015 * (1 - walk);

    // 抓扶手时把靠近扶手那只手举起来；不抓时缓缓放下。
    const grabbing = state.grabHandrail !== null && state.alive;
    this.armLift += ((grabbing ? 1 : 0) - this.armLift) * (1 - Math.exp(-11 * dt));
    const baseL = -0.2;
    const baseR = 0.2;
    this.armL.rotation.z = baseL + (this.liftRight ? 0 : (-2.5 - baseL)) * this.armLift;
    this.armR.rotation.z = baseR + (this.liftRight ? (2.5 - baseR) : 0) * this.armLift;

    // ---- 摆腿 / 摆臂 / 推挤 / 踉跄。优先级：坐 > 推挤 > 踉跄 > 走路 ----
    const swing = Math.sin(this.gait);
    let legSwing = swing * 0.55 * walk;
    let armSwingL = -swing * 0.42 * walk;
    let armSwingR = swing * 0.42 * walk;
    let leanX = 0.1 * walk;
    let leanZ = 0;

    if (this.pushTimer > 0) {
      this.pushTimer -= dt;
      // 蓄力(0~0.08) → 爆发(0.08~0.16) → 回弹。
      const e = PUSH_DUR - this.pushTimer;
      const thrust = e < 0.08
        ? 0.55 * (e / 0.08)
        : e < 0.16
          ? 0.55 - 1.9 * ((e - 0.08) / 0.08)
          : -1.35 * Math.max(0, 1 - (e - 0.16) / 0.14);
      armSwingL = thrust;
      armSwingR = thrust;
      leanX = e < 0.08 ? -0.18 : 0.3;
    } else if (state.stunTimer > 0 || state.hitProtect > 0) {
      // 踉跄：往被推的反方向后仰，双臂上举失衡，叠一层高频抖动。
      const k = Math.min(1, Math.max(state.stunTimer, state.hitProtect * 0.6) / BALANCE.stunDuration);
      const localAngle = Math.atan2(state.vel.x, state.vel.z) - state.facing;
      leanX = -0.38 * k * Math.cos(localAngle);
      leanZ = 0.38 * k * Math.sin(localAngle);
      armSwingL = -1.15;
      armSwingR = -1.15;
      legSwing = 0.42 * k;
      this.group.position.y += Math.sin(t * 38) * 0.02 * k;
    }

    if (!sitting) {
      this.legL.rotation.x = legSwing;
      this.legR.rotation.x = -legSwing;
    }
    this.armL.rotation.x = armSwingL;
    this.armR.rotation.x = armSwingR;
    this.rig.rotation.x = leanX;
    this.rig.rotation.z = leanZ;

    this.grabRing.visible = grabbing;
    this.colorRing.visible = state.alive;
    if (this.arrow) {
      this.arrow.visible = this.selfMarkers;
      this.arrow.position.y = 1.5 * MODEL_SCALE + 0.2 + Math.sin(t * 5) * 0.09;
    }

    // 持续型技能：环一直转着，玩家知道自己还在增益里。
    const active = state.skillRemaining > 0;
    this.skillRing.visible = active;
    if (active) {
      this.skillRing.rotation.z = t * 2.4;
      this.skillRingMat.opacity = 0.38 + Math.sin(t * 8) * 0.16;
    }

    // 透视下 Sprite 的世界尺寸会近大远小：8 米外的人小到看不清，2 米外的自己
    // 占掉半个屏幕。这里做"部分补偿"——夹在 0.6~1.7 之间，既保证远处可读，
    // 又保留"谁近谁远"的深度线索（完全恒定屏幕尺寸会让人挤成一团时糊掉）。
    const dist = Math.hypot(
      camPos.x - state.pos.x,
      camPos.y - this.group.position.y,
      camPos.z - state.pos.z
    );
    const distK = Math.min(1.7, Math.max(0.6, dist / LABEL_REF_DIST));
    this.labelNear = Math.min(1, Math.max(0, (dist - LABEL_NEAR_HIDE) / (LABEL_NEAR_FULL - LABEL_NEAR_HIDE)));
    this.nameLabel.scale.set(this.labelBaseW * distK, this.labelBaseH * distK, 1);
    // 近的名字牌盖住远的。透视下必须用真实距离，固定方位角那套已经不成立。
    this.nameLabel.renderOrder = 900 + Math.round((LABEL_MAX_DIST - Math.min(dist, LABEL_MAX_DIST)) * 8);

    if (this.iconTimer > 0) {
      this.iconTimer -= dt;
      const life = Math.max(0, this.iconTimer / 1.15);
      this.skillIcon.visible = true;
      // 贴身镜头下上浮量要收一半，否则图标会飞出画面。
      this.skillIcon.position.y = 1.55 * MODEL_SCALE + 0.5 + (1 - life) * 0.25;
      this.skillIconMat.opacity = Math.min(1, life * 2.2);
      const sc = 0.72 * distK * (0.7 + (1 - life) * 0.5);
      this.skillIcon.scale.set(sc, sc, 1);
    } else {
      this.skillIcon.visible = false;
    }
  }

  /**
   * 摔下车：抛物线飞出车门，落在真实地面上弹一下，然后躺平淡出。
   *
   * 以前落点写死在 y=0（车厢地板），车外的人行道比它低 0.82，于是人悬在半空，
   * 再整个沉进地里"退场"。现在地面高度由 SceneryView 提供；车在开的时候，
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
    if (k.landT < 0) {
      y = 3.4 * tt - 5.5 * tt * tt;
      // 过了抛物线顶点、又低于地面，就算落地。
      if (tt > 0.31 && y <= floor) {
        k.landT = tt;
        y = floor;
      }
      // 翻滚 + 四肢摊开：ragdoll 的最廉价替代。
      this.rig.rotation.z = tt * 8.2;
      this.rig.rotation.x = Math.sin(tt * 9) * 0.5;
    } else {
      const tl = tt - k.landT;
      // 离开车厢后，地面摩擦把他的相对速度拉向"地面速度"：车在开，人就被甩在后面。
      const drift = g ? g.driftZ : 0;
      k.vz += (drift - k.vz) * (1 - Math.exp(-4 * dt));
      k.slide += k.vz * dt;
      y = floor + Math.max(0, 1.3 * tl - 7 * tl * tl);
      // 躺平；滑得越快滚得越快。
      this.rig.rotation.x = -1.4;
      this.rig.rotation.z += (Math.abs(k.vz) / 0.45) * dt;
      const moving = Math.abs(drift) > 1.5;
      const rest = moving ? KO_REST_MOVING : KO_REST_STILL;
      this.koAlpha = Math.max(0, 1 - Math.max(0, tl - rest) / KO_FADE);
      if (this.koAlpha <= 0 || tt > KO_MAX) k.done = true;
    }
    this.group.position.set(x, y, zAir + k.slide);
    this.armL.rotation.x = -1.6 + Math.sin(tt * 11) * 0.3;
    this.armR.rotation.x = -1.6 + Math.sin(tt * 13 + 1) * 0.3;
    this.legL.rotation.x = 0.7 + Math.sin(tt * 10) * 0.4;
    this.legR.rotation.x = -0.7 + Math.sin(tt * 12) * 0.4;
    this.group.visible = !k.done;
  }

  /**
   * 收集身体上的所有材质，共享材质就地换成这个人自己的一份。
   * 按网格遍历而不是点名，换成正式角色模型后这段不用改。
   */
  private collectBodyMaterials(markers: THREE.Object3D[]) {
    const skip = new Set<THREE.Object3D>(markers);
    const own = new Map<THREE.Material, THREE.Material>();
    const shared = new Set<THREE.Material>(Object.values(SHARED));
    this.rig.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || skip.has(mesh)) return;
      const src = mesh.material as THREE.Material;
      let m = own.get(src);
      if (!m) {
        m = shared.has(src) ? src.clone() : src;
        if (m !== src) this.materials.push(m);
        own.set(src, m);
      }
      mesh.material = m;
    });
    this.bodyMats = [...own.values()];
  }

  /** 挡视线淡出：只在淡出过程中切透明，平时保持不透明，免得多一轮排序。 */
  applyOcclusion(dt: number) {
    const target = (this.occluding ? OCCLUDER_ALPHA : 1) * this.koAlpha;
    if (Math.abs(this.bodyAlpha - target) < 1e-3) {
      if (this.bodyAlpha === target) return;
      this.bodyAlpha = target;
    } else {
      this.bodyAlpha += (target - this.bodyAlpha) * (1 - Math.exp(-10 * dt));
    }
    const solid = this.bodyAlpha > 0.995;
    for (const m of this.bodyMats) {
      // 必须走 setMaterialTransparent：只改 transparent 标记，编译过的不透明着色器仍然输出实心。
      setMaterialTransparent(m, !solid);
      m.opacity = solid ? 1 : this.bodyAlpha;
    }
  }

  /** 名字牌精灵（给 ActorManager 做屏幕空间去重用）。 */
  get label(): THREE.Sprite {
    return this.nameLabel;
  }

  /** 名字牌淡入淡出：去重和近距淡出都走这里，避免名字牌一帧闪现一帧消失。 */
  applyLabelAlpha(dt: number) {
    const target = this.labelTarget * this.labelNear;
    this.labelAlpha += (target - this.labelAlpha) * (1 - Math.exp(-12 * dt));
    this.labelMat.opacity = this.labelAlpha;
    if (this.labelAlpha < 0.02) this.nameLabel.visible = false;
  }

  /**
   * 手掌的世界坐标，用来画到扶手的连接线。
   * towards 给定时挑靠近它的那只手；以前这里返回的是身体中心 + 固定高度，
   * 越肩贴近之后那条黄线是从肚子里穿出来的。
   */
  handPosition(out: THREE.Vector3, towards?: THREE.Vector3): THREE.Vector3 {
    if (towards) {
      const f = this.group.rotation.y;
      // 角色的局部 +x 在世界里的方向（rotation.y = f 时）。
      const rx = Math.cos(f);
      const rz = -Math.sin(f);
      const dot = (towards.x - this.group.position.x) * rx + (towards.z - this.group.position.z) * rz;
      this.liftRight = dot >= 0;
    }
    return (this.liftRight ? this.handR : this.handL).getWorldPosition(out);
  }

  dispose() {
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

/** 管理全部角色人偶。 */
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

  update(characters: CharacterState[], t: number, dt: number, camPos: THREE.Vector3) {
    for (const c of characters) {
      const a = this.actors.get(c.id);
      if (!a) continue;
      a.ground = this.ground;
      a.update(c, t, dt, camPos);
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
    this.zones = ['#joystick-base', '#btn-push', '#btn-dash', '#btn-skill', '#btn-grab'].flatMap((sel) => {
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
