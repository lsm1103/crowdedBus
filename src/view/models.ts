import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { asset } from '../core/assets';
import { CHARACTERS } from '../config/characters';

/**
 * Blender 产出的模型。
 * - 车身、街景：scripts/blender/build_models.py → public/models/*.glb；
 * - 8 名角色：在角色工程里制作，npm run chars:sync 压缩后放进 public/models/characters/。
 *
 * 在加载页一次性预载，之后 buildBus() / SceneryView / 角色同步取用 ——
 * 这样 Game 的构造流程和以前一样是同步的，不用把 async 传染到 session。
 */
const FILES = { bus: 'models/bus.glb', city: 'models/city.glb' } as const;
export type ModelName = keyof typeof FILES;

/** 角色资产：场景（带骨骼）+ 动作。每个人上场时各自克隆一份。 */
export interface CharacterAsset {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

const cache = new Map<ModelName, THREE.Group>();
const characters = new Map<string, CharacterAsset>();

export function loadModels(onProgress?: (v: number) => void): Promise<void> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const jobs: { url: string; label: string; done: (gltf: GLTF) => void }[] = [
    ...(Object.keys(FILES) as ModelName[]).map((name) => ({
      url: FILES[name], label: name, done: (gltf: GLTF) => void cache.set(name, gltf.scene)
    })),
    ...CHARACTERS.map((c) => ({
      url: `models/characters/${c.id}.glb`, label: c.id,
      done: (gltf: GLTF) => void characters.set(c.id, { scene: gltf.scene, animations: gltf.animations })
    }))
  ];
  const progress = new Array<number>(jobs.length).fill(0);
  const report = () => onProgress?.(progress.reduce((a, b) => a + b, 0) / jobs.length);
  return Promise.all(jobs.map((job, i) => new Promise<void>((resolve) => {
    loader.load(
      asset(job.url),
      (gltf) => {
        job.done(gltf);
        progress[i] = 1;
        report();
        resolve();
      },
      (e) => {
        if (e.lengthComputable) {
          progress[i] = e.loaded / e.total;
          report();
        }
      },
      (err) => {
        // 失败不阻塞进游戏：缺了的模型会在控制台报错（角色退回成占位胶囊），但不会白屏卡死在加载页。
        console.error(`[models] ${job.label} 加载失败`, err);
        progress[i] = 1;
        report();
        resolve();
      }
    );
  }))).then(() => undefined);
}

export function getModel(name: ModelName): THREE.Group | null {
  return cache.get(name) ?? null;
}

export function getCharacterAsset(id: string): CharacterAsset | null {
  return characters.get(id) ?? null;
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
