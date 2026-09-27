import * as THREE from 'three';
import type { NpcState } from '../domain/types';
import type { GroundInfo } from './actors';
import { makeNpc } from './scenery';

/**
 * 车厢里的路人乘客（docs/08 第 3.4 节"上客潮 / 下客潮"）。
 *
 * 他们是场景机关，不是对手：造型比可玩角色小一号、颜色偏灰，没有名字牌。
 * 一人一个合并网格（顶点色），每人一次 draw call。
 * 规则层把下了车的路人从列表里删掉；这里让他继续往外走一小段、缩小消失，而不是凭空不见。
 */

/** 外观：身体色 / 头发色，按 NpcState.look 取模。 */
const LOOKS: [number, number][] = [
  [0x8fa7bf, 0x2b2f36], [0xc9a27a, 0x5a3b2a], [0x9c8fb8, 0x2b2f36],
  [0x7fae9a, 0x6b6b6b], [0xb88c8c, 0x2b2f36], [0x8c9fb0, 0x4a3524]
];
/** 坐下时身体下沉到座垫上（座垫顶面 0.46，路人躯干底端离脚底约 0.3）。 */
const SIT_Y = 0.16;
/** 下车后继续往外走多久再消失（秒）。 */
const EXIT_TIME = 0.9;

interface Live {
  mesh: THREE.Mesh;
  lastX: number;
  lastZ: number;
  gait: number;
  y: number;
  vx: number;
  vz: number;
}

interface Exiting {
  mesh: THREE.Mesh;
  vx: number;
  vz: number;
  y: number;
  t: number;
}

export class NpcView {
  readonly root = new THREE.Group();
  private mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private geos = LOOKS.map(([b, h]) => makeNpc(b, h));
  private live = new Map<number, Live>();
  private exiting: Exiting[] = [];
  private ground: GroundInfo | null = null;

  setGround(g: GroundInfo) {
    this.ground = g;
  }

  /** 新回合：清掉所有路人。 */
  reset() {
    for (const l of this.live.values()) this.root.remove(l.mesh);
    for (const e of this.exiting) this.root.remove(e.mesh);
    this.live.clear();
    this.exiting = [];
  }

  update(npcs: readonly NpcState[], t: number, dt: number) {
    const seen = new Set<number>();
    for (const n of npcs) {
      seen.add(n.id);
      let l = this.live.get(n.id);
      if (!l) {
        const mesh = new THREE.Mesh(this.geos[((n.look % LOOKS.length) + LOOKS.length) % LOOKS.length], this.mat);
        this.root.add(mesh);
        l = { mesh, lastX: n.pos.x, lastZ: n.pos.z, gait: Math.random() * 6, y: this.floorAt(n.pos.x, n.pos.z), vx: 0, vz: 0 };
        this.live.set(n.id, l);
      }
      const moved = Math.hypot(n.pos.x - l.lastX, n.pos.z - l.lastZ);
      const speed = dt > 1e-4 ? moved / dt : 0;
      if (dt > 1e-4) {
        l.vx = (n.pos.x - l.lastX) / dt;
        l.vz = (n.pos.z - l.lastZ) / dt;
      }
      l.lastX = n.pos.x;
      l.lastZ = n.pos.z;
      l.gait += speed * dt * 9;
      const sitting = n.status === 'sitting';
      // 车外（上下车途中）贴着人行道 / 马路的真实高度；跨门槛时平滑过渡，像跨了一步。
      const floor = sitting ? SIT_Y : this.floorAt(n.pos.x, n.pos.z);
      l.y += (floor - l.y) * (1 - Math.exp(-14 * dt));
      const walking = !sitting && speed > 0.2;
      const bob = walking ? Math.abs(Math.sin(l.gait)) * 0.05 : Math.sin(t * 2 + n.id) * 0.01;
      const m = l.mesh;
      m.position.set(n.pos.x, l.y + bob, n.pos.z);
      m.rotation.set(walking ? 0.08 : 0, n.facing, walking ? Math.sin(l.gait) * 0.06 : 0);
    }
    // 下车的：从列表里消失的那一刻开始往外走一小段，再缩小消失。
    for (const [id, l] of this.live) {
      if (seen.has(id)) continue;
      this.live.delete(id);
      const v = Math.hypot(l.vx, l.vz);
      const k = v > 0.3 ? 1.6 / v : 0;
      this.exiting.push({ mesh: l.mesh, vx: v > 0.3 ? l.vx * k : 1.6, vz: v > 0.3 ? l.vz * k : 0, y: l.y, t: 0 });
    }
    for (let i = this.exiting.length - 1; i >= 0; i--) {
      const e = this.exiting[i];
      e.t += dt;
      const m = e.mesh;
      m.position.x += e.vx * dt;
      m.position.z += e.vz * dt;
      e.y += (this.floorAt(m.position.x, m.position.z) - e.y) * (1 - Math.exp(-10 * dt));
      m.position.y = e.y;
      m.scale.setScalar(Math.max(0.001, 1 - Math.max(0, e.t - EXIT_TIME * 0.6) / (EXIT_TIME * 0.4)));
      if (e.t >= EXIT_TIME) {
        this.root.remove(m);
        this.exiting.splice(i, 1);
      }
    }
  }

  private floorAt(x: number, z: number): number {
    return this.ground ? this.ground.heightAt(x, z) : 0;
  }

  dispose() {
    this.reset();
    this.mat.dispose();
    for (const g of this.geos) g.dispose();
  }
}
