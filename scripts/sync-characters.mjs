/**
 * 把角色工程（blender_char）产出的移动版 GLB 同步进游戏，并做 meshopt 压缩。
 *
 * 角色在另一个工程里用 Blender 制作（见那边的 角色制作计划.md），游戏只取成品：
 * 源文件不进这个仓库，重做角色后重跑一次即可。
 *
 *   npm run chars:sync                         # 默认从 ../../blender_char 读取
 *   CHAR_SRC=/path/to/blender_char npm run chars:sync
 *
 * gltfpack 不带 -kn：同一材质的部件合并成一次 draw call（小夏 4 → 1），骨骼和动作不受影响。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, process.env.CHAR_SRC ?? '../../blender_char');
const OUT = join(ROOT, 'public/models/characters');

/** 游戏角色 id → 角色工程里的移动版文件。阿强是旧流程做的，路径不同。 */
const FILES = {
  xiaoli: 'characters/xiaoli/mobile.glb',
  xiaoxia: 'characters/xiaoxia/mobile.glb',
  aqiang: 'refined/fitness_guy_mobile_v2.glb',
  lanjie: 'characters/lanjie/mobile.glb',
  ayuan: 'characters/ayuan/mobile.glb',
  ajia: 'characters/ajia/mobile.glb',
  amo: 'characters/amo/mobile.glb',
  laozhou: 'characters/laozhou/mobile.glb'
};

const bin = join(ROOT, 'node_modules/.bin/gltfpack');
if (!existsSync(bin)) {
  console.error('缺少 gltfpack：先运行 npm install');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

let failed = 0;
let total = 0;
for (const [id, rel] of Object.entries(FILES)) {
  const src = join(SRC, rel);
  const dst = join(OUT, `${id}.glb`);
  if (!existsSync(src)) {
    console.error(`✗ ${id}：找不到 ${src}`);
    failed++;
    continue;
  }
  execFileSync(bin, ['-i', src, '-o', dst, '-cc'], { stdio: ['ignore', 'ignore', 'inherit'] });
  const kb = statSync(dst).size / 1024;
  total += kb;
  console.log(`✓ ${id.padEnd(8)} ${(statSync(src).size / 1024).toFixed(0).padStart(4)}KB → ${kb.toFixed(0)}KB`);
}
console.log(`合计 ${total.toFixed(0)}KB → ${OUT}`);
if (failed) process.exit(1);
