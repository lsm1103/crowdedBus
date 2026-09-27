import { V2, v2Len, v2Norm, screenToWorld, type Vec2 } from './math';
import { CAMERA_YAW_DEFAULT } from '../config/view';
import { toStageDelta, toStageLocal } from './orientation';

/** 三个动作键（docs/08 第 3.1 节）：抓（按住）、推 / 扔、冲。 */
export type Button = 'grab' | 'push' | 'dash';

/**
 * 每帧输入。
 * - move：归一化的**世界**方向；
 * - pressed：这一帧"按下"的键（边沿触发）；
 * - held：这一帧仍按着的键（"抓"是按住生效、松手放开）。
 */
export interface InputFrame {
  move: Vec2;
  pressed: Set<Button>;
  held: Set<Button>;
}

/** 键盘键位：E/F 抓（按住），J/K 推，空格 冲。 */
const KEYS: Record<Button, string[]> = { grab: ['e', 'f'], push: ['j', 'k'], dash: [' '] };

const DEADZONE = 0.16;

/**
 * 统一管理触屏虚拟摇杆/按钮与桌面键盘。
 * 摇杆为动态摇杆：手指按在左半屏任意位置，底座就挪到手指下方，避免贴边起按或误触满舵。
 */
export class InputManager {
  private move = V2();
  private pressed = new Set<Button>();
  /** 触屏按钮当前按着的集合（键盘的按住状态从 _keys 里算）。 */
  private touchHeld = new Set<Button>();
  /**
   * 触屏的"抓"是锁定式：点一下锁住（相当于一直按着），再点一下松开。
   * 规则层的"抓"是按住生效，但手机上左手推摇杆、右手要腾出来点"扔"，
   * 不可能一直按着抓键 —— 两个拇指做不到"抓着人、走到门口、再按扔"。
   * 手里空了（没抓到东西 / 扔出去了 / 被挣脱）由 syncGrab() 自动解锁。
   */
  private grabLatch = false;
  private latchIdle = 0;
  /** 同一次点按会先后触发 pointerdown 和 touchstart，切换式按键要去重，否则连切两次等于没按。 */
  private lastPress = new Map<Button, number>();
  private joystickId = -1;
  private radius = 0;
  private originX = 0;
  private originY = 0;

  private _keys = new Set<string>();
  /**
   * 摇杆换算用的相机偏航。越肩相机每帧都在转，这个值由 Scene3D 实时喂进来；
   * 写死常量的话，玩家一转身摇杆方向就和画面脱节。
   */
  private basisYaw = CAMERA_YAW_DEFAULT;

  /** 本帧累计的环顾位移，单位是「舞台宽度的比例」。 */
  private lookDx = 0;
  private lookId = -1;
  private lookX = 0;
  private lookY = 0;
  private lookEnded = false;
  /** 摇杆的复位函数（bindJoystick 里闭包持有 DOM），reset() 要调它。 */
  private resetJoystick: () => void = () => {};
  /** 按钮按下态的清理（视觉），reset() 要调它。 */
  private releaseButtons: () => void = () => {};

  constructor(
    private zone: HTMLElement,
    private base: HTMLElement,
    private knob: HTMLElement,
    buttonMap: Partial<Record<Button, HTMLElement>>,
    lookZone?: HTMLElement
  ) {
    this.bindJoystick();
    this.bindButtons(buttonMap);
    this.bindKeyboard();
    if (lookZone) this.bindLook(lookZone);
  }

  /**
   * 环顾拖动。
   *
   * 这一层铺满全屏但放在 HUD 的**最底层**：摇杆区和动作按钮都是它的后继兄弟，
   * 命中测试天然优先落在它们身上，所以不需要任何手动的区域排除或事件拦截 ——
   * 手指落在摇杆/按钮上就走原来的路径，落在别处（上半屏、按钮之间的空隙）才算环顾。
   */
  private bindLook(el: HTMLElement) {
    el.addEventListener('pointerdown', (e) => {
      if (this.lookId !== -1) return;
      this.lookId = e.pointerId;
      try { el.setPointerCapture(e.pointerId); } catch { /* noop */ }
      this.lookX = e.clientX;
      this.lookY = e.clientY;
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookId) return;
      // 强制横屏下 stage 被 rotate(90deg)，client 的 dx 不是舞台的 dx。
      const d = toStageDelta(e.clientX - this.lookX, e.clientY - this.lookY);
      this.lookX = e.clientX;
      this.lookY = e.clientY;
      const w = el.getBoundingClientRect().width || 1;
      // 旋转后 el 的 client 宽度是舞台的高度，用 offsetWidth 才是舞台自身的宽。
      this.lookDx += d.x / (el.offsetWidth || w);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.lookId) return;
      this.lookId = -1;
      this.lookEnded = true;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  /** 取走本帧的环顾位移（舞台宽度比例）与「手指刚抬起」的边沿。 */
  takeLook(): { dx: number; ended: boolean } {
    const r = { dx: this.lookDx, ended: this.lookEnded };
    this.lookDx = 0;
    this.lookEnded = false;
    return r;
  }

  /** 由 session 每帧从 Scene3D.cameraYaw 喂入。 */
  setBasisYaw(yaw: number) {
    this.basisYaw = yaw;
  }

  /**
   * 摇杆可移动半径。
   * 必须在按下时才量：构造时 HUD 还是 display:none，offsetWidth 恒为 0，
   * 用兜底常量会让摇杆头跑出底座。
   */
  private syncRadius() {
    const baseR = this.base.getBoundingClientRect().width / 2;
    const knobR = this.knob.getBoundingClientRect().width / 2;
    this.radius = baseR > 0 && knobR > 0 ? Math.max(20, baseR - knobR) : 40;
  }

  private bindJoystick() {
    const zone = this.zone;
    const base = this.base;
    const knob = this.knob;

    /** 把底座挪到手指按下的位置（夹在区域内，保证整个底座可见）。 */
    const placeBase = (clientX: number, clientY: number) => {
      // 手指在区域内的舞台局部坐标（强制横屏时同样正确，见 toStageLocal）。
      const d = toStageLocal(zone.getBoundingClientRect(), clientX, clientY);
      const half = base.offsetWidth / 2 || 56;
      const clampAxis = (v: number, span: number) =>
        span < half * 2 ? span / 2 : Math.min(Math.max(v, half + 6), span - half - 6);
      base.style.left = clampAxis(d.x, zone.offsetWidth) + 'px';
      base.style.top = clampAxis(d.y, zone.offsetHeight) + 'px';
      base.style.bottom = 'auto';
      base.style.transform = 'translate(-50%,-50%)';
    };

    const setFromPoint = (clientX: number, clientY: number) => {
      const d = toStageDelta(clientX - this.originX, clientY - this.originY);
      let dx = d.x;
      let dy = d.y;
      const len = Math.hypot(dx, dy);
      if (len > this.radius) {
        dx = (dx / len) * this.radius;
        dy = (dy / len) * this.radius;
      }
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      const nx = dx / this.radius;
      const nz = dy / this.radius;
      this.move = Math.hypot(nx, nz) < DEADZONE ? V2() : screenToWorld(nx, nz, this.basisYaw);
    };

    const reset = () => {
      if (this.joystickId !== -1) {
        try { zone.releasePointerCapture(this.joystickId); } catch { /* noop */ }
      }
      this.move = V2();
      this.joystickId = -1;
      knob.style.transform = 'translate(-50%,-50%)';
      base.classList.remove('active');
      // 回到 CSS 里的静默位置，避免底座停在上一次的手指处挡视野。
      base.style.left = '';
      base.style.top = '';
      base.style.bottom = '';
      base.style.transform = '';
    };

    zone.addEventListener('pointerdown', (e) => {
      if (this.joystickId !== -1) return;
      this.joystickId = e.pointerId;
      try { zone.setPointerCapture(e.pointerId); } catch { /* noop */ }
      this.originX = e.clientX;
      this.originY = e.clientY;
      placeBase(e.clientX, e.clientY);
      this.syncRadius();
      base.classList.add('active');
      setFromPoint(e.clientX, e.clientY);
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.joystickId) return;
      setFromPoint(e.clientX, e.clientY);
    });
    const up = (e: PointerEvent) => {
      if (e.pointerId === this.joystickId) reset();
    };
    zone.addEventListener('pointerup', up);
    zone.addEventListener('pointercancel', up);
    zone.addEventListener('lostpointercapture', up);
    this.resetJoystick = reset;
  }

  private bindButtons(map: Partial<Record<Button, HTMLElement>>) {
    const els: HTMLElement[] = [];
    for (const [key, el] of Object.entries(map) as [Button, HTMLElement][]) {
      if (!el) continue;
      els.push(el);
      const press = (e: Event) => {
        e.preventDefault();
        const now = performance.now();
        if (now - (this.lastPress.get(key) ?? -1e9) < 80) return;
        this.lastPress.set(key, now);
        el.classList.add('active');
        if (key === 'grab') {
          if (this.grabLatch) {
            this.grabLatch = false; // 再点一下：松手
          } else {
            this.grabLatch = true;
            this.latchIdle = 0;
            this.pressed.add('grab');
          }
          return;
        }
        // 冷却中也照样上报：是否执行、要不要提示"冷却中"、差一点就缓冲，都由模拟层决定。
        this.pressed.add(key);
        this.touchHeld.add(key);
        // 捕获指针：推、冲按住时手指在按钮上稍微滑出一点不能算松手。
        if (e instanceof PointerEvent) {
          try { el.setPointerCapture(e.pointerId); } catch { /* noop */ }
        }
      };
      const release = () => {
        this.touchHeld.delete(key);
        el.classList.remove('active');
      };
      el.addEventListener('pointerdown', press);
      el.addEventListener('touchstart', press, { passive: false });
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('pointerleave', release);
      el.addEventListener('touchend', release);
    }
    this.releaseButtons = () => {
      this.touchHeld.clear();
      this.grabLatch = false;
      els.forEach((el) => el.classList.remove('active'));
    };
  }

  private bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      const k = e.key.toLowerCase();
      this._keys.add(k);
      // 按下边沿只认第一次：长按时系统的自动重复不能算成连按。按住状态在 takeFrame 里从 _keys 算。
      if (e.repeat) return;
      for (const b of Object.keys(KEYS) as Button[]) if (KEYS[b].includes(k)) this.pressed.add(b);
    });
    window.addEventListener('keyup', (e) => {
      this._keys.delete(e.key.toLowerCase());
    });
    // 切走窗口时 keyup 收不到，不清的话回来后角色会自己一直走。
    window.addEventListener('blur', () => this._keys.clear());
  }

  /**
   * 开新局前清空全部输入状态：大厅/结算页里按过的键、上一局没收到抬起的摇杆指针、
   * 环顾拖动的残留。没有它，上一局结束时按着摇杆的话，下一局摇杆可能失灵或自己走。
   */
  reset() {
    this.pressed = new Set();
    this._keys.clear();
    this.resetJoystick();
    this.releaseButtons();
    this.lookDx = 0;
    this.lookId = -1;
    this.lookEnded = true;
  }

  /**
   * 每个模拟步由会话层调用：触屏锁住了"抓"、但手里空了超过 0.3 秒，就自动解锁。
   * 否则扔完人、或者对方挣脱之后，抓键还锁着，下一次点它反而变成"松手"。
   * 留 0.3 秒是为了让"锁住后走到扶手/人旁边自动抓上"还能生效。
   */
  syncGrab(holding: boolean, dt: number) {
    if (!this.grabLatch) return;
    if (holding) {
      this.latchIdle = 0;
      return;
    }
    this.latchIdle += dt;
    if (this.latchIdle > 0.3) this.grabLatch = false;
  }

  /** 取走本帧输入并清空边沿。 */
  takeFrame(): InputFrame {
    let move = this.move;
    if (this.joystickId === -1) {
      let x = 0;
      let z = 0;
      if (this._keys.has('a') || this._keys.has('arrowleft')) x -= 1;
      if (this._keys.has('d') || this._keys.has('arrowright')) x += 1;
      if (this._keys.has('w') || this._keys.has('arrowup')) z -= 1;
      if (this._keys.has('s') || this._keys.has('arrowdown')) z += 1;
      if (Math.hypot(x, z) > 0.01) move = v2Norm(screenToWorld(x, z, this.basisYaw));
    }
    if (v2Len(move) > 1) move = v2Norm(move);
    const held = new Set<Button>(this.touchHeld);
    if (this.grabLatch) held.add('grab');
    for (const b of Object.keys(KEYS) as Button[]) if (KEYS[b].some((k) => this._keys.has(k))) held.add(b);
    const frame: InputFrame = { move, pressed: this.pressed, held };
    this.pressed = new Set();
    return frame;
  }
}
