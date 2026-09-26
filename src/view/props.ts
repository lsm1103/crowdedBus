import * as THREE from 'three';
import type { Vec2 } from '../core/math';

/** 模拟层里的行李/路障，只取渲染需要的字段。 */
export interface LuggageLike {
  pos: Vec2;
  rect: { minX: number; maxX: number; minZ: number; maxZ: number };
  slow: boolean;
}

const BOX = new THREE.BoxGeometry(1, 1, 1);

/**
 * 技能放出来的行李箱 / 菜篮路障。
 *
 * 之前这些东西只存在于碰撞里，视图完全没画 —— 玩家放了路障看不见任何东西，
 * 这也是"释放技能没反馈"的主要来源之一。
 */
export class PropView {
  root = new THREE.Group();
  private pool: THREE.Mesh[] = [];
  private bagMat = new THREE.MeshLambertMaterial({ color: 0x8a5a3b });
  private basketMat = new THREE.MeshLambertMaterial({ color: 0x4fae5c });

  update(items: readonly LuggageLike[]) {
    while (this.pool.length < items.length) {
      const m = new THREE.Mesh(BOX, this.bagMat);
      m.visible = false;
      this.root.add(m);
      this.pool.push(m);
    }
    for (let i = 0; i < this.pool.length; i++) {
      const m = this.pool[i];
      const it = items[i];
      if (!it) {
        m.visible = false;
        continue;
      }
      const w = it.rect.maxX - it.rect.minX;
      const d = it.rect.maxZ - it.rect.minZ;
      const h = it.slow ? 0.5 : 0.66;
      m.visible = true;
      m.material = it.slow ? this.basketMat : this.bagMat;
      m.scale.set(w, h, d);
      m.position.set(it.pos.x, h / 2, it.pos.z);
    }
  }

  dispose() {
    this.bagMat.dispose();
    this.basketMat.dispose();
  }
}

/**
 * 热区地面圈。
 * 机制看不见就等于不存在 —— 站在圈里每秒得分、人越多分越少，
 * 必须画出来玩家才会去抢。
 */
export class HotZoneView {
  root = new THREE.Group();
  private mesh: THREE.Mesh;
  private mat = new THREE.MeshBasicMaterial({
    color: 0xFFD23F, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false
  });
  private geo = new THREE.RingGeometry(0.86, 1, 40);
  private t = 0;

  constructor() {
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = 0.03;
    this.mesh.renderOrder = 2;
    this.root.add(this.mesh);
  }

  update(x: number, z: number, r: number, active: boolean, playerInside: boolean, dt: number) {
    this.mesh.visible = active;
    if (!active) return;
    this.t += dt;
    this.mesh.position.set(x, 0.03, z);
    // 呼吸一下，和地面上其他静态元素区分开。
    const pulse = 1 + Math.sin(this.t * 3) * 0.06;
    this.mesh.scale.set(r * pulse, r * pulse, 1);
    this.mat.color.setHex(playerInside ? 0x6BE59A : 0xFFD23F);
    this.mat.opacity = playerInside ? 0.75 : 0.45;
  }

  dispose() {
    this.mat.dispose();
    this.geo.dispose();
  }
}

/**
 * 座位标记。
 *
 * "AI 都会坐、我不知道怎么坐"的根因：空座和满座在画面上完全一样，
 * 玩家没有任何理由走过去；唯一的提示是按钮上两个字在贴到 0.85m 内才变。
 * bot 直接读 seatFree()，不需要看画面 —— 信息不对称必须在这里补上。
 *
 * 三种状态一眼可分：
 * - 空座：薄荷绿呼吸圈 + 一根竖光柱。**光柱是关键** —— 座位在远侧车壁，
 *   越肩视角下经常被人和障碍物挡住，只画地面圈的话根本看不见。
 * - 自己坐着：金色静止圈，不再呼吸（已经到手的东西不该继续抢注意力）。
 * - 别人坐着：暗红扁圈，明确"这个没戏"，而不是干脆不画 ——
 *   不画的话玩家会以为那儿根本不是座位。
 */
export class SeatMarkerView {
  root = new THREE.Group();
  private ringGeo = new THREE.RingGeometry(0.3, 0.42, 28);
  private colGeo = new THREE.CylinderGeometry(0.085, 0.085, 1, 10, 1, true);
  private items: { ring: THREE.Mesh; col: THREE.Mesh; rm: THREE.MeshBasicMaterial; cm: THREE.MeshBasicMaterial }[] = [];
  private t = 0;

  private ensure(n: number) {
    while (this.items.length < n) {
      const rm = new THREE.MeshBasicMaterial({
        color: 0x6BE59A, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false
      });
      const cm = new THREE.MeshBasicMaterial({
        color: 0x6BE59A, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false
      });
      const ring = new THREE.Mesh(this.ringGeo, rm);
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 3;
      const col = new THREE.Mesh(this.colGeo, cm);
      col.renderOrder = 3;
      this.root.add(ring, col);
      this.items.push({ ring, col, rm, cm });
    }
  }

  /** seats 来自 snapshot；guideId 是最近的空座，给它更亮的高亮。 */
  update(
    seats: readonly { id: number; x: number; z: number; free: boolean; mine: boolean }[],
    guideId: number | null, inReach: boolean, visible: boolean, dt: number
  ) {
    this.ensure(seats.length);
    this.t += dt;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      const s = seats[i];
      if (!s || !visible) {
        it.ring.visible = false;
        it.col.visible = false;
        continue;
      }
      it.ring.visible = true;
      // 座面高 0.44，圈贴在坐垫上方一点，避免和坐垫共面闪烁。
      it.ring.position.set(s.x, 0.5, s.z);

      if (s.mine) {
        it.rm.color.setHex(0xFFD23F);
        it.rm.opacity = 0.85;
        it.ring.scale.set(1, 1, 1);
        it.col.visible = false;
      } else if (!s.free) {
        it.rm.color.setHex(0xE8728A);
        it.rm.opacity = 0.3;
        it.ring.scale.set(0.8, 0.8, 1);
        it.col.visible = false;
      } else {
        const target = s.id === guideId;
        // 就位时圈变金并停止呼吸：这是"现在按下去就能坐"的确定信号。
        const pulse = target && inReach ? 1.18 : 1 + Math.sin(this.t * (target ? 5 : 2.6)) * 0.09;
        it.rm.color.setHex(target && inReach ? 0xFFD23F : 0x6BE59A);
        it.rm.opacity = target ? 0.95 : 0.6;
        it.ring.scale.set(pulse, pulse, 1);
        it.col.visible = true;
        it.col.position.set(s.x, 1.2, s.z);
        it.col.scale.set(1, 1.4, 1);
        it.cm.color.setHex(target && inReach ? 0xFFD23F : 0x6BE59A);
        it.cm.opacity = target ? 0.4 : 0.22;
      }
    }
  }

  dispose() {
    for (const it of this.items) {
      it.rm.dispose();
      it.cm.dispose();
    }
    this.ringGeo.dispose();
    this.colGeo.dispose();
  }
}

/**
 * 玩家 → 扶手的连接线。
 * "抓住"以前按下去只有一个小圆环，玩家不知道抓到了什么；
 * 一条实际连到那根杆子的手臂线是最直接的答案。
 */
export class GrabLink {
  root = new THREE.Group();
  private mesh: THREE.Mesh;
  private mat = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.92 });
  // 靠手粗、靠扶手细，读起来像小臂；6 面在透视 2 米内棱角很明显，加到 8 面。
  private geo = new THREE.CylinderGeometry(0.028, 0.045, 1, 8);
  private up = new THREE.Vector3(0, 1, 0);

  constructor() {
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.visible = false;
    this.root.add(this.mesh);
  }

  hide() {
    this.mesh.visible = false;
  }

  /** from = 玩家手部位置，to = 扶手抓环位置。 */
  show(from: THREE.Vector3, to: THREE.Vector3) {
    const dir = to.clone().sub(from);
    const len = dir.length();
    if (len < 1e-3) {
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    this.mesh.position.copy(from).addScaledVector(dir, 0.5);
    this.mesh.scale.set(1, len, 1);
    this.mesh.quaternion.setFromUnitVectors(this.up, dir.normalize());
  }

  dispose() {
    this.mat.dispose();
    this.geo.dispose();
  }
}
