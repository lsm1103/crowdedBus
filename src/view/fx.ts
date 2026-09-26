import * as THREE from 'three';
import type { Vec2 } from '../core/math';

interface Live {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
  from: number;
  to: number;
  rise: number;
}

const RING = new THREE.RingGeometry(0.42, 0.62, 28);

/**
 * 打击感的最低成本实现：地面冲击环。
 * 推挤 / 冲刺 / 技能 / 淘汰各给一次，玩家才知道自己刚才那一下有没有生效。
 */
export class EffectManager {
  root = new THREE.Group();
  private pool: Live[] = [];
  private active: Live[] = [];

  private take(): Live {
    const hit = this.pool.pop();
    if (hit) return hit;
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: false
    });
    const mesh = new THREE.Mesh(RING, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 5;
    return { mesh, mat, life: 0, maxLife: 1, from: 1, to: 2, rise: 0 };
  }

  private emit(pos: Vec2, color: number, from: number, to: number, life: number, y = 0.06, rise = 0) {
    const l = this.take();
    l.mat.color.setHex(color);
    l.mat.opacity = 0.95;
    l.mesh.position.set(pos.x, y, pos.z);
    l.mesh.scale.set(from, from, 1);
    l.life = 0;
    l.maxLife = life;
    l.from = from;
    l.to = to;
    l.rise = rise;
    l.mesh.visible = true;
    this.root.add(l.mesh);
    this.active.push(l);
  }

  push(pos: Vec2) {
    this.emit(pos, 0xFF7A6B, 0.5, 2.9, 0.36);
  }

  dash(pos: Vec2) {
    this.emit(pos, 0xBFE6F5, 0.4, 2.1, 0.3);
  }

  skill(pos: Vec2, color: string) {
    this.emit(pos, new THREE.Color(color).getHex(), 0.4, 3.4, 0.5);
  }

  grab(pos: Vec2) {
    this.emit(pos, 0xffd23f, 1.6, 0.7, 0.28, 0.08);
  }

  eliminate(pos: Vec2) {
    this.emit(pos, 0xffffff, 0.4, 4.2, 0.6);
    this.emit(pos, 0xFF5F5A, 0.3, 2.6, 0.45, 0.5, 1.6);
  }

  respawn(pos: Vec2) {
    this.emit(pos, 0x4ECEB6, 2.6, 0.5, 0.45);
  }

  update(dt: number) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const l = this.active[i];
      l.life += dt;
      const t = Math.min(1, l.life / l.maxLife);
      const s = l.from + (l.to - l.from) * (1 - (1 - t) * (1 - t));
      l.mesh.scale.set(s, s, 1);
      l.mesh.position.y += l.rise * dt;
      l.mat.opacity = 0.95 * (1 - t);
      if (t >= 1) {
        l.mesh.visible = false;
        this.root.remove(l.mesh);
        this.active.splice(i, 1);
        this.pool.push(l);
      }
    }
  }

  dispose() {
    for (const l of [...this.active, ...this.pool]) l.mat.dispose();
    this.active = [];
    this.pool = [];
  }
}
