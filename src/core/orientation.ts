/**
 * 强制横屏。
 *
 * iOS 微信是 WKWebView，不跟随系统旋转，screen.orientation.lock 也不存在，
 * 所以"提示用户把手机转过来"在微信里永远无效。唯一可行的做法是：检测到竖屏时
 * 把整个舞台用 CSS 旋转 90°，宽高互换，由用户自己把手机横过来对齐。
 *
 * 旋转之后有两件事必须跟着一起换算：
 *  1. 安全区 —— env(safe-area-inset-*) 始终按设备方向给值，旋转后上下左右全错位；
 *     这里读出真实值再按旋转量重映射成 --sa-* 变量，布局只用 --sa-*。
 *  2. 指针坐标 —— clientX/clientY 是屏幕坐标，摇杆需要的是舞台内的局部坐标，
 *     由 toStageDelta() 负责反向旋转。
 */

type Listener = () => void;

let stage: HTMLElement | null = null;
let probe: HTMLElement | null = null;
let rotation: 0 | 90 = 0;
const listeners: Listener[] = [];

/** 当前舞台相对屏幕的旋转角度（度）。0 = 未旋转，90 = 强制横屏中。 */
export const getStageRotation = (): 0 | 90 => rotation;

/** 把屏幕坐标系下的位移换算成舞台局部坐标系下的位移。 */
export function toStageDelta(dxClient: number, dyClient: number): { x: number; y: number } {
  // rotate(90deg) 把局部 (x,y) 映射成屏幕 (-y, x)，这里做它的逆变换。
  if (rotation === 90) return { x: dyClient, y: -dxClient };
  return { x: dxClient, y: dyClient };
}

/**
 * 屏幕坐标 → 某个舞台内元素的局部坐标（相对该元素左上角，舞台像素）。
 *
 * 不能用 toStageDelta(clientX - rect.left, clientY - rect.top)：旋转 90° 后
 * getBoundingClientRect() 的左上角对应的是元素**左下角**，那样算出来的纵坐标恒为负，
 * 摇杆底座会被夹到区域顶边、永远不在拇指下面。
 */
export function toStageLocal(rect: DOMRect, clientX: number, clientY: number): { x: number; y: number } {
  // rotate(90deg)：局部 +x → 屏幕 +y，局部 +y → 屏幕 -x，
  // 所以局部左上角落在屏幕外框的右上角。
  if (rotation === 90) return { x: clientY - rect.top, y: rect.right - clientX };
  return { x: clientX - rect.left, y: clientY - rect.top };
}

/** 舞台尺寸/旋转发生变化时回调（渲染器需要据此重设画布尺寸）。 */
export function onStageChange(fn: Listener): void {
  listeners.push(fn);
}

function readInsets(): [number, number, number, number] {
  if (!probe) return [0, 0, 0, 0];
  const s = getComputedStyle(probe);
  return [
    parseFloat(s.paddingTop) || 0,
    parseFloat(s.paddingRight) || 0,
    parseFloat(s.paddingBottom) || 0,
    parseFloat(s.paddingLeft) || 0
  ];
}

function apply(): void {
  if (!stage) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const portrait = vh > vw;
  const next: 0 | 90 = portrait ? 90 : 0;
  rotation = next;

  const w = portrait ? vh : vw;
  const h = portrait ? vw : vh;
  stage.style.width = w + 'px';
  stage.style.height = h + 'px';
  stage.style.left = (vw - w) / 2 + 'px';
  stage.style.top = (vh - h) / 2 + 'px';
  stage.style.transform = portrait ? 'rotate(90deg)' : 'none';

  // 舞台自己的 1% 宽高。强制横屏时 vw/vh 指的仍是设备方向，直接用会让所有
  // 自适应尺寸算反（实测大厅会溢出，"开始上车"被挤出屏幕点不到）。
  const root = document.documentElement.style;
  root.setProperty('--sw', w / 100 + 'px');
  root.setProperty('--sh', h / 100 + 'px');

  // 安全区重映射：旋转 90° 后，设备的上/右/下/左分别落在舞台的左/上/右/下。
  const [t, r, b, l] = readInsets();
  if (portrait) {
    root.setProperty('--sa-top', r + 'px');
    root.setProperty('--sa-right', b + 'px');
    root.setProperty('--sa-bottom', l + 'px');
    root.setProperty('--sa-left', t + 'px');
  } else {
    root.setProperty('--sa-top', t + 'px');
    root.setProperty('--sa-right', r + 'px');
    root.setProperty('--sa-bottom', b + 'px');
    root.setProperty('--sa-left', l + 'px');
  }

  for (const fn of listeners) fn();
}

/** 安卓 Chrome/部分 X5 内核在全屏下可以真正锁定横屏；iOS 会直接抛错，忽略即可。 */
export function tryLockLandscape(): void {
  const o = screen.orientation as (ScreenOrientation & { lock?: (v: string) => Promise<void> }) | undefined;
  try {
    o?.lock?.('landscape')?.catch(() => { /* 平台不支持，走 CSS 旋转兜底 */ });
  } catch {
    /* 平台不支持 */
  }
}

export function initOrientation(): void {
  stage = document.getElementById('stage');
  probe = document.getElementById('safe-area-probe');
  apply();
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', () => {
    // iOS 旋转后视口尺寸要下一帧才稳定。
    apply();
    setTimeout(apply, 120);
    setTimeout(apply, 400);
  });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', apply);
}
