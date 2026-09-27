/**
 * 把车厢布局导出成 JSON，交给 Blender 建模脚本使用。
 *
 * 车模的门洞、座位、障碍物、扶手位置必须和碰撞数据逐一对齐，
 * 所以 Blender 不自己写死任何坐标，一律从这里读。
 * 用法见 package.json 的 model:build。
 */
import { LAYOUT, INTERIOR, PLATFORM_FENCE, boardingFence, baseWalls } from '../src/domain/layout';

const out = {
  interior: INTERIOR,
  doors: LAYOUT.doors.map((d) => ({ id: d.id, zMin: d.zMin, zMax: d.zMax })),
  seats: LAYOUT.seats.map((s) => ({ id: s.id, kind: s.kind, x: s.x, z: s.z, facing: s.facing, front: s.front, cushion: s.cushion, backRect: s.backRect })),
  handrails: LAYOUT.handrails,
  obstacles: LAYOUT.obstacles,
  platform: LAYOUT.platform,
  platformFence: PLATFORM_FENCE,
  boardingFence: boardingFence(),
  walls: baseWalls()
};

process.stdout.write(JSON.stringify(out, null, 2) + '\n');
