import * as THREE from 'three';
import type { AppearanceSpec } from '../config/appearance';

/**
 * 角色配件的程序化几何体。
 *
 * 全部用 three 内置图元拼，不引入模型文件。几何体按形状缓存复用（8 个角色共用
 * 同一批 BufferGeometry），只有材质按角色配色新建 —— 材质由调用方 push 进
 * Actor.materials，随 dispose 一起释放。
 */

const cache = new Map<string, THREE.BufferGeometry>();
function geo<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  const hit = cache.get(key);
  if (hit) return hit as T;
  const g = make();
  cache.set(key, g);
  return g;
}

export interface AccessoryTargets {
  /** 挂到头上（跟着头一起动）。 */
  head: THREE.Object3D;
  /** 挂到躯干上。 */
  hip: THREE.Object3D;
  /** 挂到左右手上。 */
  handL: THREE.Object3D;
  handR: THREE.Object3D;
}

/**
 * 按外观规格挂上配件。返回新建的材质，调用方要负责 dispose。
 */
export function buildAccessories(
  spec: AppearanceSpec,
  t: AccessoryTargets
): THREE.Material[] {
  const owned: THREE.Material[] = [];
  const mat = (color: number): THREE.MeshLambertMaterial => {
    const m = new THREE.MeshLambertMaterial({ color });
    owned.push(m);
    return m;
  };
  const add = (
    parent: THREE.Object3D, g: THREE.BufferGeometry, m: THREE.Material,
    x: number, y: number, z: number, rx = 0, ry = 0, rz = 0
  ) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, ry, rz);
    parent.add(mesh);
    return mesh;
  };

  const accentMat = mat(spec.accent);

  for (const kind of spec.accessories) {
    switch (kind) {
      case 'headband':
        // 阿强：一圈青色头带，是立绘里最醒目的一处。
        add(t.head, geo('band', () => new THREE.TorusGeometry(0.3, 0.045, 8, 20)),
          accentMat, 0, 0.06, 0, Math.PI / 2);
        break;

      case 'kerchief': {
        // 兰姐：粉头巾 + 后脑的蝴蝶结。
        const cap = add(t.head, geo('cap', () => new THREE.SphereGeometry(0.32, 14, 10)),
          accentMat, 0, 0.1, 0);
        cap.scale.set(1, 0.55, 1);
        add(t.head, geo('bow', () => new THREE.BoxGeometry(0.2, 0.1, 0.08)),
          accentMat, 0, 0.1, -0.3);
        break;
      }

      case 'neckPillow': {
        // 阿远：U 形颈枕，套在脖子上。
        const p = add(t.head, geo('pillow', () => new THREE.TorusGeometry(0.24, 0.09, 8, 16, Math.PI * 1.5)),
          accentMat, 0, -0.28, 0, Math.PI / 2, 0, Math.PI * 0.25);
        p.scale.set(1, 1, 1);
        break;
      }

      case 'backpack':
        // 书包/背包：挂在背后（模型正面朝 +z，所以背面是 -z）。
        add(t.hip, geo('pack', () => new THREE.BoxGeometry(0.42, 0.5, 0.22)),
          accentMat, 0, 0.66, -0.3);
        add(t.hip, geo('packTop', () => new THREE.BoxGeometry(0.3, 0.1, 0.16)),
          accentMat, 0, 0.93, -0.3);
        break;

      case 'selfieStick': {
        // 小麦：自拍杆 + 手机，立绘里最强的识别物。
        const stickMat = mat(0x2f3a48);
        add(t.handR, geo('stick', () => new THREE.CylinderGeometry(0.022, 0.022, 0.72, 6)),
          stickMat, 0, -0.3, 0.14, -0.5);
        add(t.handR, geo('phone', () => new THREE.BoxGeometry(0.13, 0.24, 0.03)),
          accentMat, 0, -0.56, 0.42, -0.5);
        break;
      }

      case 'headphones': {
        // 阿默/小夏：颈挂耳机。
        const hpMat = mat(spec.accent === 0x1b2029 ? 0x1b2029 : 0x2a2f3a);
        add(t.head, geo('hpBand', () => new THREE.TorusGeometry(0.26, 0.04, 8, 18, Math.PI)),
          hpMat, 0, -0.24, 0, Math.PI / 2, 0, Math.PI);
        for (const sx of [-1, 1]) {
          add(t.head, geo('hpCup', () => new THREE.CylinderGeometry(0.09, 0.09, 0.06, 12)),
            hpMat, sx * 0.26, -0.24, 0, 0, 0, Math.PI / 2);
        }
        break;
      }

      case 'sleepMask':
        // 老周：推在额头上的眼罩。
        add(t.head, geo('mask', () => new THREE.BoxGeometry(0.5, 0.13, 0.06)),
          accentMat, 0, 0.14, 0.24);
        break;

      case 'necktie':
        // 小李：红条纹领带。
        add(t.hip, geo('tie', () => new THREE.BoxGeometry(0.1, 0.34, 0.05)),
          accentMat, 0, 0.66, 0.3);
        break;

      case 'briefcase':
        // 小李：手提公文包。
        add(t.handR, geo('case', () => new THREE.BoxGeometry(0.34, 0.26, 0.1)),
          mat(0x8a5a3b), 0, -0.24, 0);
        break;

      case 'groceryBag': {
        // 兰姐：两手各拎一个菜袋，葱叶从袋口伸出来 —— 最有画面感的一处。
        const bagMat = mat(0xf0f0e8);
        const leekMat = mat(0x6fae55);
        for (const hand of [t.handL, t.handR]) {
          add(hand, geo('bag', () => new THREE.BoxGeometry(0.26, 0.3, 0.18)), bagMat, 0, -0.24, 0);
          add(hand, geo('leek', () => new THREE.CylinderGeometry(0.03, 0.03, 0.26, 6)),
            leekMat, 0.05, -0.06, 0.02, 0.25);
        }
        break;
      }
    }
  }

  return owned;
}
