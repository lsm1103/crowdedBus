import * as THREE from 'three';
import { LAYOUT, INTERIOR, type Door } from '../domain/layout';
import { floorTexture, routeSignTexture, softShadowTexture } from './textures';
import { getModel, meshesOf, setMaterialTransparent, toLambert } from './models';
import { PALETTE as P } from '../config/palette';
import { WORLD } from '../config/world';

/**
 * 车身视图。
 *
 * 几何全部来自 Blender（scripts/blender/build_models.py → public/models/bus.glb），
 * 这里只按节点名取部件、做动画和状态表现：
 * - door_{front|back}_{a|b}：车门扇，原点在铰链上，开门时向车外摆开；
 * - axle_front / axle_rear：车轮，按车速滚动；
 * - 扶手立杆和握把已并进 bus_interior（省 12 次 draw call），被抓住的那根由代码套一层发光外壳；
 * - bus_{near|far|nose|tail}_upper：腰线以上的车壳，相机在它外侧时淡成虚影；
 * - floor_surface / sign_front / sign_back：代码贴图的平面。
 * 门洞、座位、扶手、障碍物的位置在建模时就从碰撞数据读取，和玩法严格对齐。
 */

const WHEEL_R = 0.46;
/** 车门扇向外摆开的角度（弧度）。不到 90°，开着的门一眼能看出"是门开了"而不是墙没了。 */
const DOOR_SWING = 1.42;
/** 相机在车壳外侧时，车壳淡到的不透明度。完全隐藏会让车"突然少一面墙"。 */
const GHOST_OPACITY = 0.14;

const HOT_RAIL = 0xfff3a8;
/** 扶手几何（和 scripts/blender/build_models.py 的立杆、握把一致）。 */
const RAIL_TOP = 2.24;
const GRIP_Y0 = 1.30;
const GRIP_Y1 = 1.62;


export interface BusView {
  /** 车身（连同车里的人一起跟着 CabinPose 点头、侧倾）。 */
  group: THREE.Group;
  /** 车轮 + 车底阴影：留在地面上，不跟车身倾斜（相当于悬挂）。session 要把它加到场景里。 */
  chassis: THREE.Group;
  /** speed：车速（0~1.15，满速 = 1），驱动车轮滚动。 */
  update: (doors: Door[], dt: number, speed?: number) => void;
  /** 高亮玩家正抓着的那根扶手（null = 取消高亮）。 */
  highlightRail: (railId: number | null) => void;
  /** 扶手握把在世界里的位置，用于画玩家到扶手的连接线。 */
  railAnchor: (railId: number) => THREE.Vector3 | null;
  /** 按相机位置把挡在镜头和车厢之间的车壳（只有腰线以上）淡成虚影。 */
  setShellOcclusion: (camX: number, camZ: number) => void;
  dispose: () => void;
}

interface FadeGroup {
  mats: THREE.Material[];
  base: number[];
  opacity: number;
  target: number;
}

interface DoorLeaf {
  node: THREE.Object3D;
  sign: 1 | -1;
  mats: THREE.MeshLambertMaterial[];
}

export function buildBus(): BusView {
  const group = new THREE.Group();
  const chassis = new THREE.Group();
  const owned: { dispose: () => void }[] = [];
  const src = getModel('bus');
  if (!src) {
    console.error('[bus] 模型未加载，车厢不会显示');
    return {
      group, chassis, update: () => {}, highlightRail: () => {}, railAnchor: () => null,
      setShellOcclusion: () => {}, dispose: () => {}
    };
  }
  const root = src;
  group.add(root);
  owned.push(...toLambert(root));
  const node = (name: string): THREE.Object3D | null => root.getObjectByName(name) ?? null;

  // ---------- 地板、线路牌：代码贴图
  const floor = node('floor_surface');
  if (floor) {
    const tex = floorTexture();
    tex.flipY = false; // glTF 的 UV 原点在左上，canvas 贴图默认会再翻一次
    // floor_surface 的 UV：u 沿车宽 4.8 格、v 沿车长 12.8 格；一格贴图约 1.2 格世界。
    tex.repeat.set(4, 10.5);
    const m = new THREE.MeshLambertMaterial({ map: tex });
    owned.push(tex, m);
    for (const mesh of meshesOf(floor)) mesh.material = m;
  }
  const signs: [string, string, number, number][] = [
    ['sign_front', '5路 · 终点站', 1024, 114],
    ['sign_back', '5', 256, 54]
  ];
  for (const [name, text, w, h] of signs) {
    const n = node(name);
    if (!n) continue;
    const tex = routeSignTexture(text, w, h);
    tex.flipY = false;
    const m = new THREE.MeshBasicMaterial({ map: tex });
    owned.push(tex, m);
    for (const mesh of meshesOf(n)) mesh.material = m;
  }

  // ---------- 车底软阴影：没有实时阴影，车"压在地上"全靠它
  {
    const tex = softShadowTexture();
    const geo = new THREE.PlaneGeometry(6.4, 16.2);
    const m = new THREE.MeshBasicMaterial({ map: tex, color: 0x1a2230, transparent: true, opacity: 0.55, depthWrite: false });
    owned.push(tex, geo, m);
    const shadow = new THREE.Mesh(geo, m);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(0, WORLD.groundY + 0.012, 0.4);
    shadow.renderOrder = -1;
    chassis.add(shadow);
  }

  // ---------- 车壳淡出分组：每组一份材质，免得淡近侧时远侧也跟着透明
  const fadeGroup = (name: string): FadeGroup | null => {
    const n = node(name);
    if (!n) return null;
    const mats: THREE.Material[] = [];
    for (const mesh of meshesOf(n)) {
      const m = (mesh.material as THREE.Material).clone();
      owned.push(m);
      mesh.material = m;
      mats.push(m);
    }
    return { mats, base: mats.map((m) => m.opacity), opacity: 1, target: 1 };
  };
  const shells = {
    near: fadeGroup('bus_near_upper'),
    far: fadeGroup('bus_far_upper'),
    nose: fadeGroup('bus_nose_upper'),
    tail: fadeGroup('bus_tail_upper')
  };

  // ---------- 车门：每扇门一份材质，开门时整扇门染成危险色
  const leaves = new Map<Door['id'], DoorLeaf[]>();
  for (const d of LAYOUT.doors) {
    const list: DoorLeaf[] = [];
    for (const [suffix, sign] of [['a', 1], ['b', -1]] as const) {
      const n = node(`door_${d.id}_${suffix}`);
      if (!n) continue;
      const mats: THREE.MeshLambertMaterial[] = [];
      for (const mesh of meshesOf(n)) {
        const m = (mesh.material as THREE.MeshLambertMaterial).clone();
        owned.push(m);
        mesh.material = m;
        if (m.vertexColors) mats.push(m);
      }
      list.push({ node: n, sign, mats });
      // 模型和碰撞数据对不上时立刻喊出来：旧版的穿模就是这么悄悄产生的。
      const hinge = suffix === 'a' ? d.zMin + 0.02 : d.zMax - 0.02;
      if (Math.abs(n.position.z - hinge) > 0.02) {
        console.warn(`[bus] 车门 ${d.id}_${suffix} 与布局不符（模型 z=${n.position.z.toFixed(2)}，布局 ${hinge.toFixed(2)}），请 npm run model:build`);
      }
    }
    leaves.set(d.id, list);
  }
  // 开门时门板底下的地面危险区（碰撞层面的"会掉下去"必须在地上画出来）
  const dangerMeshes = new Map<string, THREE.Mesh>();
  for (const d of LAYOUT.doors) {
    const geo = new THREE.PlaneGeometry(0.62, d.zMax - d.zMin);
    const m = new THREE.MeshBasicMaterial({ color: P.lemon, transparent: true, opacity: 0.26, depthWrite: false });
    owned.push(geo, m);
    const mesh = new THREE.Mesh(geo, m);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(INTERIOR.maxX - 0.31, 0.02, (d.zMin + d.zMax) / 2);
    mesh.renderOrder = 1;
    group.add(mesh);
    dangerMeshes.set(d.id, mesh);
  }

  // ---------- 车轮
  const axles = ['axle_front', 'axle_rear'].map(node).filter((n): n is THREE.Object3D => !!n);
  // 车轮挪进 chassis：车身点头、侧倾时轮子仍然压在路面上。车身此刻还没有任何变换，attach 等价于 add。
  for (const a of axles) chassis.attach(a);

  // ---------- 扶手高亮：一层略粗的发光外壳，平时隐藏，抓住哪根就挪到哪根上
  const hot = new THREE.Group();
  hot.visible = false;
  group.add(hot);
  const hotMat = new THREE.MeshBasicMaterial({ color: HOT_RAIL });
  const hotPoleGeo = new THREE.CylinderGeometry(0.052, 0.052, RAIL_TOP, 12);
  const hotGripGeo = new THREE.CylinderGeometry(0.078, 0.078, GRIP_Y1 - GRIP_Y0, 14);
  owned.push(hotMat, hotPoleGeo, hotGripGeo);
  const hotPole = new THREE.Mesh(hotPoleGeo, hotMat);
  hotPole.position.y = RAIL_TOP / 2;
  const hotGrip = new THREE.Mesh(hotGripGeo, hotMat);
  hotGrip.position.y = (GRIP_Y0 + GRIP_Y1) / 2;
  hot.add(hotPole, hotGrip);
  const anchors = new Map<number, THREE.Vector3>();
  for (const h of LAYOUT.handrails) anchors.set(h.id, new THREE.Vector3(h.x, (GRIP_Y0 + GRIP_Y1) / 2, h.z));

  let hotRail: number | null = null;
  const openColor = new THREE.Color(P.coral);
  const white = new THREE.Color(0xffffff);
  const dangerOpen = new THREE.Color(0xff5f6d);
  const dangerIdle = new THREE.Color(P.lemon);
  const doorOpen = new Map<Door['id'], number>();

  const update = (doors: Door[], dt: number, speed = 0) => {
    const k = 1 - Math.exp(-9 * Math.max(dt, 1e-3));
    for (const d of doors) {
      const cur = doorOpen.get(d.id) ?? 0;
      const next = cur + ((d.open ? 1 : 0) - cur) * k;
      doorOpen.set(d.id, next);
      for (const leaf of leaves.get(d.id) ?? []) {
        leaf.node.rotation.y = leaf.sign * DOOR_SWING * next;
        for (const m of leaf.mats) m.color.copy(white).lerp(openColor, next * 0.85);
      }
      const dm = dangerMeshes.get(d.id);
      if (dm) {
        const m = dm.material as THREE.MeshBasicMaterial;
        m.opacity = 0.26 + (0.9 - 0.26) * next;
        m.color.copy(dangerIdle).lerp(dangerOpen, next);
      }
    }
    // 车轮：线速度 = 车速 × 世界滚动速度，角速度 = 线速度 / 半径。
    const spin = (speed * WORLD.scrollSpeed * dt) / WHEEL_R;
    for (const a of axles) a.rotation.x += spin;

    // 车壳淡入淡出
    const kf = 1 - Math.exp(-10 * Math.max(dt, 1e-3));
    for (const g of Object.values(shells)) {
      if (!g) continue;
      const prev = g.opacity;
      g.opacity += (g.target - g.opacity) * kf;
      if (Math.abs(g.opacity - prev) < 1e-4 && Math.abs(g.opacity - g.target) < 1e-3) g.opacity = g.target;
      const solid = g.opacity > 0.995;
      g.mats.forEach((m, i) => {
        m.opacity = g.base[i] * g.opacity;
        // 原本就透明的玻璃保持透明；不透明件只在淡出时切透明，免得平时多一轮排序。
        if (g.base[i] >= 1) setMaterialTransparent(m, !solid);
      });
    }

    // 被抓住的扶手握把轻微脉动，玩家一眼看得出"我正抓着这根"。
    if (hotRail !== null) {
      const s = 1 + Math.sin(performance.now() * 0.008) * 0.12;
      hotGrip.scale.set(s, 1, s);
    }
  };

  const highlightRail = (railId: number | null) => {
    if (hotRail === railId) return;
    hotRail = railId;
    const a = railId !== null ? anchors.get(railId) : undefined;
    hot.visible = !!a;
    if (a) hot.position.set(a.x, 0, a.z);
    hotGrip.scale.set(1, 1, 1);
  };

  const railAnchor = (railId: number) => anchors.get(railId) ?? null;

  /**
   * 相机跑到某片车壳外侧时，把那片腰线以上的部分淡成虚影。
   * 用淡出而不是 visible=false：相机贴着墙线来回时，整面墙闪现闪灭非常扎眼。
   */
  const X_EDGE = 2.55;
  const setShellOcclusion = (camX: number, camZ: number) => {
    if (shells.near) shells.near.target = camX > X_EDGE ? GHOST_OPACITY : 1;
    if (shells.far) shells.far.target = camX < -X_EDGE ? GHOST_OPACITY : 1;
    if (shells.nose) shells.nose.target = camZ > INTERIOR.maxZ ? GHOST_OPACITY : 1;
    if (shells.tail) shells.tail.target = camZ < INTERIOR.minZ - 0.1 ? GHOST_OPACITY : 1;
  };

  const dispose = () => {
    for (const o of owned) o.dispose();
  };

  return { group, chassis, update, highlightRail, railAnchor, setShellOcclusion, dispose };
}
