import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { asset } from '../core/assets';

/**
 * Blender 产出的模型（scripts/blender/build_models.py → public/models/*.glb）。
 *
 * 在加载页一次性预载，之后 buildBus() / SceneryView 同步取用 ——
 * 这样 Game 的构造流程和以前一样是同步的，不用把 async 传染到 session。
 */
const FILES = { bus: 'models/bus.glb', city: 'models/city.glb' } as const;
export type ModelName = keyof typeof FILES;

const cache = new Map<ModelName, THREE.Group>();

export function loadModels(onProgress?: (v: number) => void): Promise<void> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const names = Object.keys(FILES) as ModelName[];
  const progress = new Map<ModelName, number>();
  const report = () => {
    let sum = 0;
    for (const n of names) sum += progress.get(n) ?? 0;
    onProgress?.(sum / names.length);
  };
  return Promise.all(names.map((name) => new Promise<void>((resolve) => {
    loader.load(
      asset(FILES[name]),
      (gltf) => {
        cache.set(name, gltf.scene);
        progress.set(name, 1);
        report();
        resolve();
      },
      (e) => {
        if (e.lengthComputable) {
          progress.set(name, e.loaded / e.total);
          report();
        }
      },
      (err) => {
        // 失败不阻塞进游戏：车/街景缺了会在控制台报错，但不会白屏卡死在加载页。
        console.error(`[models] ${name} 加载失败`, err);
        progress.set(name, 1);
        report();
        resolve();
      }
    );
  }))).then(() => undefined);
}

export function getModel(name: ModelName): THREE.Group | null {
  return cache.get(name) ?? null;
}

/**
 * 把 glTF 的 PBR 材质换成和角色一致的 Lambert。
 *
 * 模型里只有三种材质：
 * - `vc`：纯色件烘成了顶点色，一个节点一次 draw call；
 * - `glass`：半透明；
 * - `emit_*`：车灯、尾灯这类不受光的发光件。
 * 同名材质在一次调用里共用同一份实例，返回值交给调用方统一 dispose。
 */
export function toLambert(root: THREE.Object3D): THREE.Material[] {
  const made = new Map<string, THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.material as THREE.MeshStandardMaterial;
    const name = src.name || 'vc';
    let m = made.get(name);
    if (!m) {
      if (name === 'glass') {
        m = new THREE.MeshLambertMaterial({
          color: src.color, transparent: true, opacity: 0.3, depthWrite: false
        });
      } else if (name.startsWith('emit_')) {
        m = new THREE.MeshBasicMaterial({ color: src.color });
      } else {
        m = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
      }
      m.name = name;
      made.set(name, m);
    }
    mesh.material = m;
    src.dispose();
  });
  return [...made.values()];
}

/** 节点下所有 Mesh（节点本身可能就是 Mesh，也可能是多图元的 Group）。 */
export function meshesOf(node: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  node.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

/**
 * 切换材质的透明标记。
 * three.js 编译不透明材质时会把 alpha 写死成 1（OPAQUE 宏）；之后只改 transparent 标记，
 * 画面仍然是实心的 —— 必须同时 needsUpdate 让它换一套着色器。
 */
export function setMaterialTransparent(m: THREE.Material, transparent: boolean) {
  if (m.transparent !== transparent) {
    m.transparent = transparent;
    m.needsUpdate = true;
  }
  m.depthWrite = !transparent;
}
