import * as THREE from 'three';
import { WORLD } from '../config/world';

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function canvasTexture(c: HTMLCanvasElement, repeat = false): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  return t;
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

/**
 * 车厢地板：灰蓝防滑胶 + 圆点纹。
 * 贴在 floor_surface 上（u 沿车宽、v 沿车长），代码里按车厢尺寸设 repeat，
 * 让圆点间距在世界里约 0.3 格 —— 这是贴身镜头下判断"离墙多远"的尺度线索。
 */
export function floorTexture(): THREE.Texture {
  const S = 128;
  const [c, ctx] = makeCanvas(S, S);
  ctx.fillStyle = '#9AA6B4';
  ctx.fillRect(0, 0, S, S);
  const rnd = mulberry(7);
  for (let i = 0; i < 500; i++) {
    const v = 150 + Math.floor(rnd() * 25);
    ctx.fillStyle = `rgba(${v},${v + 6},${v + 14},0.18)`;
    ctx.fillRect(rnd() * S, rnd() * S, 2, 2);
  }
  ctx.fillStyle = 'rgba(70,82,98,0.35)';
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      ctx.beginPath();
      ctx.arc((x + 0.5 + (y % 2) * 0.5) * (S / 4), (y + 0.5) * (S / 4), 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return canvasTexture(c, true);
}

/**
 * 路面（u 横跨马路、v 沿行驶方向平铺）。
 *
 * 车道从近侧路缘（+x）排到远侧：公交专用道（黄实线 + 地面字）→ 普通车道 →
 * 双黄线 → 对向两车道。行驶时滚的是这张图的 v 偏移，地面终于和街景一起动了。
 */
export const ROAD_TILE = 12;
export function roadTexture(): THREE.Texture {
  const W = 512;
  const H = 256;
  const [c, ctx] = makeCanvas(W, H);
  const x0 = WORLD.curbFarX;
  const x1 = WORLD.curbNearX;
  const px = (x: number) => ((x - x0) / (x1 - x0)) * W;
  const pz = (z: number) => (z / ROAD_TILE) * H;
  ctx.fillStyle = '#7C838C';
  ctx.fillRect(0, 0, W, H);
  const rnd = mulberry(20260922);
  for (let i = 0; i < 1800; i++) {
    const v = 110 + Math.floor(rnd() * 40);
    ctx.fillStyle = `rgba(${v},${v + 2},${v + 8},0.16)`;
    ctx.fillRect(rnd() * W, rnd() * H, 2, 2);
  }
  // 公交专用道略偏暖，和普通车道区分开
  ctx.fillStyle = 'rgba(180,110,90,0.12)';
  ctx.fillRect(px(-2.95), 0, px(x1) - px(-2.95), H);
  const line = (x: number, w: number, color: string, dash?: [number, number]) => {
    ctx.fillStyle = color;
    const a = px(x - w / 2);
    const b = px(x + w / 2);
    if (!dash) {
      ctx.fillRect(a, 0, b - a, H);
      return;
    }
    for (let z = 0; z < ROAD_TILE; z += dash[0] + dash[1]) ctx.fillRect(a, pz(z), b - a, pz(dash[0]));
  };
  line(-2.95, 0.16, '#F2C230');
  line(-6.65, 0.14, '#F2C230');
  line(-6.95, 0.14, '#F2C230');
  line(-10.5, 0.14, 'rgba(255,255,255,0.85)', [3, 3]);
  line(x1 - 0.25, 0.14, 'rgba(255,255,255,0.8)');
  // 地面字：canvas 的"上"在世界里是 -z，要转 180° 才是朝行驶方向读。
  ctx.save();
  ctx.translate(px(0.25), pz(ROAD_TILE / 2));
  ctx.rotate(Math.PI);
  ctx.fillStyle = 'rgba(242,194,48,0.9)';
  ctx.font = `bold ${Math.round(pz(1.1))}px "PingFang SC", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.scale(1.2, 1);
  ctx.fillText('公交专用', 0, 0);
  ctx.restore();
  const t = canvasTexture(c, true);
  t.wrapS = THREE.ClampToEdgeWrapping;
  return t;
}

/** 人行道地砖：一格贴图 = 世界里 4×4 格。 */
export const SIDEWALK_TILE = 4;
export function sidewalkTexture(): THREE.Texture {
  const S = 256;
  const [c, ctx] = makeCanvas(S, S);
  ctx.fillStyle = '#DCD2C3';
  ctx.fillRect(0, 0, S, S);
  const rnd = mulberry(99);
  const n = 8;
  const cell = S / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = 212 + Math.floor(rnd() * 16);
      ctx.fillStyle = `rgb(${v},${v - 8},${v - 22})`;
      ctx.fillRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
    }
  }
  ctx.strokeStyle = 'rgba(150,132,110,0.5)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= n; i++) {
    ctx.beginPath(); ctx.moveTo(i * cell, 0); ctx.lineTo(i * cell, S); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i * cell); ctx.lineTo(S, i * cell); ctx.stroke();
  }
  return canvasTexture(c, true);
}

/**
 * 线路牌（LED 点阵风）。w/h 要和模型里那块面板的宽高比一致，否则字会被拉扁。
 * 车厢前后完全对称是"分不清车头车尾"的主因之一，写上字之后前后立刻不对称。
 */
export function routeSignTexture(text: string, w: number, h: number): THREE.Texture {
  const [c, ctx] = makeCanvas(w, h);
  ctx.fillStyle = '#0E1420';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  for (let y = 5; y < h; y += 8) for (let x = 5; x < w; x += 8) ctx.fillRect(x, y, 3, 3);
  ctx.font = `bold ${Math.round(h * 0.62)}px "PingFang SC", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFB13B';
  ctx.shadowColor = '#FF8A00';
  ctx.shadowBlur = h * 0.12;
  ctx.fillText(text, w / 2, h / 2 + 2);
  return canvasTexture(c);
}

/** 始发站站牌：站名 + 途经线路。 */
export function stationBoardTexture(name: string, routes: string): THREE.Texture {
  const W = 256;
  const H = 260;
  const [c, ctx] = makeCanvas(W, H);
  ctx.fillStyle = '#1F7A70';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#F7F4EE';
  ctx.fillRect(10, 10, W - 20, 84);
  ctx.fillStyle = '#1F7A70';
  ctx.font = 'bold 50px "PingFang SC", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, W / 2, 54);
  ctx.fillStyle = '#FFC933';
  ctx.font = 'bold 30px "PingFang SC", sans-serif';
  ctx.fillText(routes, W / 2, 140);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '22px "PingFang SC", sans-serif';
  ctx.fillText('首 06:00 · 末 22:30', W / 2, 196);
  ctx.fillText('↑ 往 终点站', W / 2, 232);
  return canvasTexture(c);
}

/** 车底的软阴影：没有实时阴影时，这一块决定车"压在地上"还是"飘着"。 */
export function softShadowTexture(): THREE.Texture {
  const W = 64;
  const H = 128;
  const [c, ctx] = makeCanvas(W, H);
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // 圆角矩形的有符号距离，边缘 12px 羽化
      const dx = Math.max(0, Math.abs(x + 0.5 - W / 2) - (W / 2 - 14));
      const dy = Math.max(0, Math.abs(y + 0.5 - H / 2) - (H / 2 - 14));
      const d = Math.hypot(dx, dy);
      const a = Math.max(0, Math.min(1, 1 - d / 12));
      const i = (y * W + x) * 4;
      img.data[i] = 0;
      img.data[i + 1] = 0;
      img.data[i + 2] = 0;
      img.data[i + 3] = Math.round(a * a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  return t;
}
