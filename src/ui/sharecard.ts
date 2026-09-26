import { CHARACTERS } from '../config/characters';
import { rolePortrait } from '../core/assets';

/**
 * 结算战绩图。
 *
 * 三个微信里必踩的坑，设计阶段就得处理：
 *
 * 1. **竖版 1080×1920**。游戏是强制横屏的，但玩家保存下来是要发微信聊天/朋友圈
 *    的，那边是竖屏语境。做成横版是最容易犯的错。
 * 2. **微信里不能用 `<a download>` 保存图片**（iOS WKWebView 对 blob/data URL 的
 *    download 属性支持很差）。正确路径是把图显示成 `<img>`，让用户长按调起原生菜单。
 *    但 body 上写了 `user-select:none; -webkit-touch-callout:none`，会直接让长按
 *    菜单失效，所以这张 img 必须单独覆盖回去。
 * 3. **浮层必须挂在 `#stage` 外面**。强制横屏时 stage 被 rotate(90deg)，
 *    放进去玩家看到的会是转了 90° 的图；放外面正好是竖屏观感，
 *    而此时玩家本来就要把手机转回竖屏去发微信，交互是自洽的。
 *
 * 不用 WebGL 截图：renderer 没开 preserveDrawingBuffer，直接 toDataURL 会拿到全黑；
 * 纯 2D 合成可控、好看，而且不受渲染状态影响。
 */

const W = 1080;
const H = 1920;

export interface ShareStats {
  charId: string;
  rank: number;
  total: number;
  score: number;
  knockouts: number;
  seatSeconds: number;
  survived: boolean;
}

/** 梗文案。中文名自带梗（"买菜阿姨兰姐"），不需要额外设计。 */
export function memeFor(s: ShareStats, victimName?: string): string {
  if (s.rank === 1 && s.knockouts > 0) return `我一个人把 ${s.knockouts} 个人挤下了车`;
  if (s.rank === 1) return '全程抱着扶手不撒手，赢了';
  if (victimName) return `我把${victimName}挤下了车`;
  if (!s.survived && s.rank >= s.total - 1) return '车门刚开，我人没了';
  if (!s.survived) return '不是我菜，是这车太颠';
  if (s.seatSeconds > 15) return `抢到座位坐了 ${s.seatSeconds} 秒，值了`;
  return '这趟车是真的挤';
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = src;
  });
}

function roundRect(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number
) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

export async function renderShareCard(s: ShareStats, meme: string): Promise<string> {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d')!;

  // 底：暖调渐变，和游戏内色板同源
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#12253C');
  bg.addColorStop(0.55, '#1B3A57');
  bg.addColorStop(1, '#0C1930');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center';

  // 标题
  ctx.fillStyle = '#FFF4E2';
  ctx.font = 'bold 92px "PingFang SC", sans-serif';
  ctx.fillText('好挤的大巴', W / 2, 190);
  ctx.fillStyle = '#8FB6D8';
  ctx.font = '40px "PingFang SC", sans-serif';
  ctx.fillText('抢位置 · 抓扶手 · 把对手挤下车', W / 2, 256);

  // 角色立绘
  const def = CHARACTERS.find((x) => x.id === s.charId) ?? CHARACTERS[0];
  const img = await loadImage(rolePortrait(s.charId));
  const px = W / 2 - 230;
  const py = 330;
  ctx.save();
  roundRect(ctx, px, py, 460, 560, 40);
  ctx.clip();
  if (img) {
    // cover 裁切，再往上提一点让脸更靠中间。缩放时就把这段上提量算进去，
    // 并把偏移夹在"始终盖满相框"的范围里 —— 以前直接上移 30px，图片刚好铺满时底部会露一条空白。
    const lift = 30;
    const scale = Math.max(460 / img.width, (560 + lift) / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    const dy = Math.min(py, Math.max(py + 560 - dh, py + (560 - dh) / 2 - lift));
    ctx.drawImage(img, px + (460 - dw) / 2, dy, dw, dh);
  } else {
    ctx.fillStyle = def.color;
    ctx.fillRect(px, py, 460, 560);
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 5;
  roundRect(ctx, px, py, 460, 560, 40);
  ctx.stroke();

  // 名次大字
  ctx.fillStyle = s.rank === 1 ? '#FFD23F' : '#FFF4E2';
  ctx.font = 'bold 150px "PingFang SC", sans-serif';
  ctx.fillText(`第 ${s.rank} 名`, W / 2, 1070);
  ctx.fillStyle = '#8FB6D8';
  ctx.font = '44px "PingFang SC", sans-serif';
  ctx.fillText(`${def.name} · ${s.total} 人同车`, W / 2, 1136);

  // 战绩行
  const stats: [string, string][] = [
    ['得分', String(s.score)],
    ['挤下', `${s.knockouts} 人`],
    ['坐了', `${s.seatSeconds}s`]
  ];
  const bw = 300;
  stats.forEach(([label, val], i) => {
    const bx = W / 2 - (bw * 3) / 2 + i * bw;
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    roundRect(ctx, bx + 14, 1200, bw - 28, 170, 26);
    ctx.fill();
    ctx.fillStyle = '#8FB6D8';
    ctx.font = '36px "PingFang SC", sans-serif';
    ctx.fillText(label, bx + bw / 2, 1258);
    ctx.fillStyle = '#FFD23F';
    ctx.font = 'bold 60px "PingFang SC", sans-serif';
    ctx.fillText(val, bx + bw / 2, 1332);
  });

  // 梗文案
  ctx.fillStyle = '#FFF4E2';
  ctx.font = 'bold 56px "PingFang SC", sans-serif';
  ctx.fillText(`「${meme}」`, W / 2, 1500);

  // 底部召唤。这张图是发给朋友看的，看图的人不需要"长按保存"——那句提示
  // 只留在图外的浮层里（给保存的人看），图里只放号召语和网址。
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  roundRect(ctx, W / 2 - 380, 1630, 760, 130, 40);
  ctx.fill();
  drawCallToAction(ctx, '来挤我 👉 ', gameUrl(), W / 2, 1695, 700);

  return c.toDataURL('image/png');
}

/**
 * 朋友照着能打开的网址：host + 路径，去掉 index.html、查询串和锚点。
 * 只写 host 的话，部署在子路径下（如 xxx.github.io/crowdedBus/）朋友就找不到了；
 * 查询串去掉是因为微信分享回流会带上 from=singlemessage 之类的尾巴。
 */
function gameUrl(): string {
  const path = location.pathname.replace(/index\.html$/, '').replace(/\/+$/, '');
  return (location.host || 'crowded-bus') + path;
}

/**
 * 号召语 + 网址排成一行居中：号召语用米白，网址用柠檬黄突出。
 * 网址长度不可控，整行超宽就整体缩字号，而不是让网址被裁掉。
 * y 是这一行的垂直中线（缩字号后仍在底框里居中）。
 */
function drawCallToAction(
  ctx: CanvasRenderingContext2D, lead: string, url: string, cx: number, y: number, maxW: number
) {
  let size = 50;
  const fontAt = (px: number) => `bold ${px}px "PingFang SC", sans-serif`;
  const widthAt = (px: number) => {
    ctx.font = fontAt(px);
    return ctx.measureText(lead).width + ctx.measureText(url).width;
  };
  while (size > 26 && widthAt(size) > maxW) size -= 2;
  ctx.font = fontAt(size);
  const leadW = ctx.measureText(lead).width;
  const x0 = cx - (leadW + ctx.measureText(url).width) / 2;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFF4E2';
  ctx.fillText(lead, x0, y);
  ctx.fillStyle = '#FFD23F';
  ctx.fillText(url, x0 + leadW, y);
  ctx.restore();
}
