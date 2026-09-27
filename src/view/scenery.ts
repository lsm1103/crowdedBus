import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { roadTexture, sidewalkTexture, stationBoardTexture, ROAD_TILE, SIDEWALK_TILE } from './textures';
import { getModel, meshesOf, toLambert } from './models';
import { WORLD } from '../config/world';
import type { Phase } from '../domain/types';

/**
 * 车外世界。
 *
 * 一切都是真 3D、世界锚定的：路面、人行道、始发站、两侧楼房和行道树。
 * "车在开"的表现方式是**车不动、世界朝 -z 走**：
 * - 路面/人行道滚贴图（v 偏移），
 * - 楼、树、路灯是 InstancedMesh，按行驶距离平移并在 wrapLen 内循环，
 * - 始发站跟着世界一起往后退，退出雾外就隐藏，
 * - 中途到站时在人行道上弹出一个候车亭，刹停时正好停在车旁。
 *
 * 以前的做法是把一张俯拍的透视插画竖起来当背景板，再在车两侧立两块会滚动的
 * 平面街景 —— 画自带的透视和越肩相机冲突，所以怎么调都"歪"。
 */


/**
 * 镜头附近要让开的道具（水平半径，世界格）。
 * 观战机位不夹在车厢里，会退到人行道上空，镜头会直接扎进树冠和路灯里。
 * 楼房不在表里：它们离路缘至少 9.6 格，任何机位都够不着。
 */
const CAMERA_CLEAR: Record<string, number> = { tree: 2.4, lamp: 2.0, bush: 1.4 };

/** 始发站在世界里的 z 范围（含两端台阶），近侧行道树要给它让位。 */
const STATION_BAND: [number, number] = [-19, 15];

interface PropKind {
  name: string;
  /** 每个图元一个 InstancedMesh。 */
  meshes: THREE.InstancedMesh[];
  /** 实例在"道路坐标"里的摆放（z 是行驶距离为 0 时的位置）。 */
  items: { x: number; y: number; z: number; rotY: number; s: number }[];
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrapZ = (z: number, len: number) => ((((z + len / 2) % len) + len) % len) - len / 2;

/**
 * 候车亭里等车的路人：一个合并网格 + 顶点色，每人一次 draw call。
 * 身材比可玩角色小一号、颜色偏灰，一眼能分清"这是背景，不是对手"。
 */
export function makeNpc(body: number, hair: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const paint = (g: THREE.BufferGeometry, hex: number) => {
    const c = new THREE.Color(hex);
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    g.deleteAttribute('uv');
    parts.push(g);
  };
  const torso = new THREE.CapsuleGeometry(0.25, 0.34, 4, 10);
  torso.translate(0, 0.72, 0);
  paint(torso, body);
  for (const sx of [-0.11, 0.11]) {
    const leg = new THREE.CapsuleGeometry(0.09, 0.26, 3, 8);
    leg.translate(sx, 0.22, 0);
    paint(leg, 0x4a5360);
  }
  const head = new THREE.SphereGeometry(0.22, 12, 10);
  head.translate(0, 1.2, 0);
  paint(head, 0xf2c9a0);
  const cap = new THREE.SphereGeometry(0.228, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55);
  cap.translate(0, 1.23, -0.02);
  paint(cap, hair);
  const g = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return g;
}

/** 候车亭里路人的站位（候车亭自身坐标，开口朝 -x 马路）。 */
const NPC_SPOTS: { x: number; z: number; rot: number; body: number; hair: number }[] = [
  { x: 0.55, z: -0.9, rot: -Math.PI / 2, body: 0x8fa7bf, hair: 0x2b2f36 },
  { x: 0.5, z: 0.55, rot: -Math.PI / 2 - 0.4, body: 0xc9a27a, hair: 0x5a3b2a },
  { x: 0.95, z: 1.15, rot: -Math.PI / 2 + 0.3, body: 0x9c8fb8, hair: 0x2b2f36 },
  { x: -0.25, z: -2.55, rot: -Math.PI / 2 + 0.2, body: 0x7fae9a, hair: 0x6b6b6b }
];

export class SceneryView {
  root = new THREE.Group();

  private owned: { dispose: () => void }[] = [];
  private roadTex: THREE.Texture;
  private walkTex: THREE.Texture;
  private props: PropKind[] = [];
  private station: THREE.Group | null = null;
  private stop: THREE.Object3D | null = null;
  private stopZ0 = 0;
  private stopAge = 0;
  private npcs: { mesh: THREE.Mesh; home: THREE.Vector3; rot: number }[] = [];


  private distance = 0;
  private busSpeed = 0;
  /** 模拟层给的剩余刹车路程（世界格）；> 0 表示正在进站。 */
  private stopAhead = 0;
  private phase: Phase = 'boarding';
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private up = new THREE.Vector3(0, 1, 0);
  private v3 = new THREE.Vector3();
  private s3 = new THREE.Vector3();
  private camera: THREE.Camera | null = null;

  constructor() {
    const L = WORLD.stripLen;

    // ---------- 路面
    this.roadTex = roadTexture();
    this.roadTex.repeat.set(1, L / ROAD_TILE);
    const roadW = WORLD.curbNearX - WORLD.curbFarX;
    const roadGeo = new THREE.PlaneGeometry(roadW, L);
    const roadMat = new THREE.MeshLambertMaterial({ map: this.roadTex });
    this.owned.push(this.roadTex, roadGeo, roadMat);
    const road = new THREE.Mesh(roadGeo, roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.set((WORLD.curbNearX + WORLD.curbFarX) / 2, WORLD.groundY, 0);
    this.root.add(road);

    // ---------- 人行道 + 路缘 + 广场：合并成两个网格（两次 draw call）
    // 以前两条人行道各是一个带 6 组材质的 BoxGeometry，每组一次 draw call，光地面就 14 次。
    // 看得见的只有人行道顶面和朝马路那一面路缘，底面和背面画了也白画。
    this.walkTex = sidewalkTexture();
    this.walkTex.repeat.set(1, L / SIDEWALK_TILE);
    const walkMat = new THREE.MeshLambertMaterial({ map: this.walkTex });
    const groundMat = new THREE.MeshLambertMaterial({ color: 0xcfc6b5 });
    this.owned.push(this.walkTex, walkMat, groundMat);
    const h = WORLD.sidewalkY - WORLD.groundY;
    const flat = (x0: number, x1: number, y: number) => {
      const g = new THREE.PlaneGeometry(x1 - x0, L);
      g.rotateX(-Math.PI / 2);
      g.translate((x0 + x1) / 2, y, 0);
      return g;
    };
    /** 路缘立面：face = -1 朝 -x（近侧，马路在它的 -x 方向），+1 朝 +x。 */
    const curb = (x: number, face: 1 | -1) => {
      const g = new THREE.PlaneGeometry(L, h);
      g.rotateY(face * Math.PI / 2);
      g.translate(x, WORLD.groundY + h / 2, 0);
      return g;
    };
    const walks = [
      flat(WORLD.curbNearX, WORLD.curbNearX + WORLD.sidewalkW, WORLD.sidewalkY),
      flat(WORLD.curbFarX - WORLD.sidewalkW, WORLD.curbFarX, WORLD.sidewalkY)
    ];
    const grounds = [
      curb(WORLD.curbNearX, -1),
      curb(WORLD.curbFarX, 1),
      flat(WORLD.curbNearX + WORLD.sidewalkW, 80, WORLD.sidewalkY - 0.004),
      flat(-80, WORLD.curbFarX - WORLD.sidewalkW, WORLD.sidewalkY - 0.004)
    ];
    for (const [parts, mat] of [[walks, walkMat], [grounds, groundMat]] as const) {
      const merged = mergeGeometries(parts as THREE.BufferGeometry[]);
      for (const g of parts) g.dispose();
      this.owned.push(merged);
      this.root.add(new THREE.Mesh(merged, mat));
    }

    this.buildProps();
    this.buildStation();
    this.buildStop();
    this.applyProps();
  }

  private buildProps() {
    const city = getModel('city');
    if (!city) {
      console.error('[scenery] 城市模型未加载，街景只剩路面');
      return;
    }
    const rnd = mulberry(20260922);
    const W = WORLD.wrapLen;
    const inStation = (z: number, pad: number) => z > STATION_BAND[0] - pad && z < STATION_BAND[1] + pad;
    const plan = new Map<string, PropKind['items']>();
    const add = (name: string, item: PropKind['items'][number]) => {
      if (!plan.has(name)) plan.set(name, []);
      plan.get(name)!.push(item);
    };

    // 楼：临街面对齐一条线，宽度随款式。近侧楼在始发站背后，站台最宽到 x=11.5。
    const BLD: Record<string, { w: number; d: number }> = {
      bld_0: { w: 6, d: 6 }, bld_1: { w: 5, d: 5 }, bld_2: { w: 7, d: 6 }, bld_3: { w: 5, d: 5 }
    };
    const names = Object.keys(BLD);
    for (const side of [1, -1] as const) {
      const front = side > 0 ? 13.0 : WORLD.curbFarX - WORLD.sidewalkW - 1.2;
      for (let z = -W / 2; z < W / 2 - 4; ) {
        const n = names[Math.floor(rnd() * names.length)];
        const b = BLD[n];
        const gap = 0.6 + rnd() * 1.6;
        const x = front + side * b.d / 2;
        add(n, { x, y: WORLD.sidewalkY, z: z + b.w / 2, rotY: side > 0 ? Math.PI : 0, s: 1 });
        z += b.w + gap;
      }
    }
    // 行道树、路灯：近侧放在人行道内侧，给中途站的候车亭留出路缘那一条。
    for (let z = -W / 2; z < W / 2; z += 7 + rnd() * 2.5) {
      if (!inStation(z, 1.5)) add('tree', { x: WORLD.curbNearX + 2.9, y: WORLD.sidewalkY, z, rotY: rnd() * 6.28, s: 0.9 + rnd() * 0.3 });
    }
    for (let z = -W / 2 + 3; z < W / 2; z += 7.5 + rnd() * 2.5) {
      add('tree', { x: WORLD.curbFarX - 1.2, y: WORLD.sidewalkY, z, rotY: rnd() * 6.28, s: 0.9 + rnd() * 0.3 });
    }
    for (let z = -W / 2 + 5; z < W / 2; z += 16) {
      if (!inStation(z, 1)) add('lamp', { x: WORLD.curbNearX + 3.8, y: WORLD.sidewalkY, z, rotY: 0, s: 1 });
      add('lamp', { x: WORLD.curbFarX - 3.4, y: WORLD.sidewalkY, z: z + 8, rotY: Math.PI, s: 1 });
    }
    for (let z = -W / 2; z < W / 2; z += 3 + rnd() * 4) {
      if (!inStation(z, 0)) add('bush', { x: 8.6 + rnd() * 2.5, y: WORLD.sidewalkY, z, rotY: rnd() * 6.28, s: 0.7 + rnd() * 0.5 });
      add('bush', { x: WORLD.curbFarX - WORLD.sidewalkW - 0.4 - rnd() * 0.6, y: WORLD.sidewalkY, z: z + 1.5, rotY: rnd() * 6.28, s: 0.7 + rnd() * 0.5 });
    }

    for (const [name, items] of plan) {
      const src = city.getObjectByName(name);
      if (!src) continue;
      const tmp = src.clone(true);
      this.owned.push(...toLambert(tmp));
      const meshes = meshesOf(tmp).map((mesh) => {
        const im = new THREE.InstancedMesh(mesh.geometry, mesh.material as THREE.Material, items.length);
        // 实例每帧都在挪，包围球跟不上，直接关掉视锥剔除（总共一百来个实例）。
        im.frustumCulled = false;
        this.root.add(im);
        return im;
      });
      this.props.push({ name, meshes, items });
    }
  }

  private buildStation() {
    const city = getModel('city');
    const st = city?.getObjectByName('station');
    if (!city || !st) return;
    const g = new THREE.Group();
    const body = st.clone(true);
    this.owned.push(...toLambert(body));
    g.add(body);
    const board = city.getObjectByName('station_board');
    if (board) {
      const b = board.clone(true);
      const tex = stationBoardTexture('幸福路', '5路 · 12路 · 快1');
      tex.flipY = false; // glTF 的 UV 原点在左上
      const m = new THREE.MeshBasicMaterial({ map: tex });
      this.owned.push(tex, m);
      for (const mesh of meshesOf(b)) mesh.material = m;
      g.add(b);
    }
    this.station = g;
    this.root.add(g);
  }

  private buildStop() {
    const src = getModel('city')?.getObjectByName('stop');
    if (!src) return;
    const s = src.clone(true);
    this.owned.push(...toLambert(s));
    s.visible = false;
    this.stop = s;
    this.root.add(s);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.owned.push(mat);
    for (const sp of NPC_SPOTS) {
      const geo = makeNpc(sp.body, sp.hair);
      this.owned.push(geo);
      const mesh = new THREE.Mesh(geo, mat);
      const home = new THREE.Vector3(sp.x, 0, sp.z);
      mesh.position.copy(home);
      mesh.rotation.y = sp.rot;
      s.add(mesh);
      this.npcs.push({ mesh, home, rot: sp.rot });
    }
  }

  /** 路人全部回到候车亭里站好（每次新到一站都重置）。 */
  private resetNpcs() {
    for (const n of this.npcs) n.mesh.visible = true;
  }

  /**
   * 上客潮：候车亭里等车的人"上车了"，把他们藏起来。
   * 真正上车的路人由规则层生成、画在车厢里（view/npcs.ts）。
   */
  hideWaiting() {
    for (const n of this.npcs) n.mesh.visible = false;
  }

  /** 用来让开镜头附近的树和路灯；不设置时不做处理。 */
  setCamera(camera: THREE.Camera) {
    this.camera = camera;
  }

  /**
   * 车厢坐标系下某一点的地面高度：车厢地板、始发站站台 0，人行道 sidewalkY，马路 groundY。
   * 被挤下车的人要落在这上面 —— 以前一律落在 y=0，出了车就悬在人行道上方 0.8。
   */
  heightAt(x: number, z: number): number {
    if (Math.abs(x) <= 2.65 && z >= -6.95 && z <= 7.75) return 0;
    const st = this.station;
    const P = WORLD.stationPlatform;
    if (st && st.visible) {
      const lz = z - st.position.z;
      if (x >= P.minX && x <= P.maxX && lz >= P.minZ && lz <= P.maxZ) return 0;
    }
    if (x >= WORLD.curbNearX || x <= WORLD.curbFarX) return WORLD.sidewalkY;
    return WORLD.groundY;
  }

  /** 地面相对车厢沿 z 的速度（车往 +z 开，地面往 -z 走）。 */
  get driftZ(): number {
    return -this.busSpeed * WORLD.scrollSpeed;
  }

  /**
   * 剩余刹车路程（车速·秒，来自 Simulation.stoppingDistance）。
   * 以前这里按固定刹车速率自己推算，急刹站点刹得更猛，候车亭会摆到 2.7 倍远的地方。
   */
  setStoppingDistance(d: number) {
    this.stopAhead = d * WORLD.scrollSpeed;
  }

  setBusSpeed(v: number) {
    this.busSpeed = v;
  }

  setPhase(phase: Phase) {
    // 每局开场回到始发站：行驶距离清零，站台回到原位。
    if (phase === 'boarding') this.reset();
    this.phase = phase;
  }

  private reset() {
    this.distance = 0;
    if (this.stop) this.stop.visible = false;
    this.resetNpcs();
    this.applyProps();
  }

  update(dt: number) {
    const dz = this.busSpeed * WORLD.scrollSpeed * dt;
    this.distance += dz;

    // 贴图偏移取模，避免跑久了浮点精度把地砖抖花。
    this.roadTex.offset.y = -((this.distance / ROAD_TILE) % 1);
    this.walkTex.offset.y = -((this.distance / SIDEWALK_TILE) % 1);
    this.applyProps();

    if (this.station) {
      const z = -this.distance;
      this.station.position.z = z;
      this.station.visible = z > -110;
    }
    this.updateStop(dt);
  }

  /**
   * 中途到站：检测到"满速开始刹车"的那一刻，把候车亭放在"刹停时正好在车旁"的位置。
   * 刹车是指数衰减，剩余距离 = v × 滚动速度 / 刹车速率。离得太近会凭空出现，
   * 所以配一个弹出动画 —— 卡通世界里站牌"蹦"出来是可以接受的，突然闪现不行。
   */
  private updateStop(dt: number) {
    const s = this.stop;
    if (!s) return;
    // 一进站（到站或终点）就把候车亭放到刹停点；刹车路程由模拟层精确给出。
    const arriving = (this.phase === 'driving' || this.phase === 'finale') && this.stopAhead > 0.05;
    if (arriving && !s.visible) {
      this.stopZ0 = this.distance + this.stopAhead;
      this.stopAge = 0;
      s.visible = true;
      this.resetNpcs();
    }
    if (!s.visible) return;
    this.stopAge += dt;
    const z = this.stopZ0 - this.distance;
    const t = Math.min(1, this.stopAge / 0.4);
    const c = 1.70158;
    const pop = t >= 1 ? 1 : 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
    s.scale.setScalar(Math.max(0.001, pop));
    s.position.set(WORLD.curbNearX + 0.5, WORLD.sidewalkY, z);
    // 镜头落进候车亭（观战机位退到人行道上时）就先藏起来，别让顶棚糊满屏。
    const cam = this.camera?.position;
    if (cam && Math.abs(cam.x - (WORLD.curbNearX + 1.2)) < 1.6 && Math.abs(cam.z - z) < 2.4 && cam.y < WORLD.sidewalkY + 3.2) {
      s.scale.setScalar(0.001);
    }
    if (z < -110) {
      s.visible = false;
      this.resetNpcs();
    }
  }

  private applyProps() {
    const W = WORLD.wrapLen;
    const cam = this.camera?.position;
    for (const p of this.props) {
      const clear = CAMERA_CLEAR[p.name] ?? 0;
      p.items.forEach((it, i) => {
        const z = wrapZ(it.z - this.distance, W);
        const inTheWay = !!cam && clear > 0 && Math.hypot(cam.x - it.x, cam.z - z) < clear * it.s;
        this.q.setFromAxisAngle(this.up, it.rotY);
        this.m4.compose(this.v3.set(it.x, it.y, z), this.q, this.s3.setScalar(inTheWay ? 0 : it.s));
        for (const im of p.meshes) im.setMatrixAt(i, this.m4);
      });
      for (const im of p.meshes) im.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    for (const o of this.owned) o.dispose();
  }
}
