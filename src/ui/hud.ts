import type { Snapshot, BannerPrio } from '../domain/types';
import { BALANCE } from '../config/balance';

interface BannerItem {
  text: string;
  prio: BannerPrio;
  /** 进队列的时刻（HUD 自己的时钟），排太久的低优先级直接丢掉。 */
  at: number;
}

/** 单条横幅显示时长。 */
const BANNER_DUR = 1.6;
/** 后面有人排队时，当前这条至少显示多久再让位。 */
const BANNER_MIN = 0.8;
/** 排队超过这么久还没轮到就作废（信息已经过时）。 */
const BANNER_STALE = 2.4;
/** 队列上限：终局每 1.7 秒一条摆动，不设上限会越积越多。 */
const BANNER_QUEUE_MAX = 3;

const fmt = (s: number): string => {
  const v = Math.max(0, s);
  const m = Math.floor(v / 60);
  const r = Math.floor(v % 60);
  return `${m}:${r.toString().padStart(2, '0')}`;
};

const INTERACT_LABEL: Record<Snapshot['interactHint'], string> = {
  sit: '坐下', stand: '起身', grab: '抓住', release: '松手', none: '抓住'
};

const PHASE_LABEL: Record<Snapshot['phase'], string> = {
  boarding: '上车中',
  ignition: '发车中',
  driving: '行驶中',
  finale: '终点摇摆',
  ended: '到站'
};

/** 对局 HUD：拥挤度、时间、存活数、阶段、事件横幅、技能冷却与暂停。 */
export class HUD {
  private root: HTMLElement;
  private crowdBox: HTMLElement;
  private crowdFill: HTMLElement;
  private crowdPct: HTMLElement;
  private phaseChip: HTMLElement;
  private time: HTMLElement;
  private alive: HTMLElement;
  private bannerEl: HTMLElement;
  private statusEl: HTMLElement;
  private grabBtn: HTMLElement;
  private skillLabel: HTMLElement;
  private interactLabel: HTMLElement;
  private scoreEl: HTMLElement;
  private sitBar: HTMLElement;
  private sitFill: HTMLElement;
  private grabState: HTMLElement;
  private seatGuide: HTMLElement;
  private seatArrow: HTMLElement;
  private toast: HTMLElement;
  private bannerTimer = 0;
  private bannerShown = 0;
  private bannerCur: BannerItem | null = null;
  private bannerQueue: BannerItem[] = [];
  private clock = 0;
  private statusTimer = 0;
  private toastTimer = 0;

  private btns: Record<'dash' | 'push' | 'skill', HTMLElement>;
  private cdEls: Record<'dash' | 'push' | 'skill', HTMLElement>;

  constructor(root: HTMLElement) {
    this.root = root;
    this.crowdBox = must(root, '#crowd-box');
    this.crowdFill = must(root, '#crowd-fill');
    this.crowdPct = must(root, '#crowd-pct');
    this.phaseChip = must(root, '#phase-chip');
    this.time = must(root, '#hud-time');
    this.alive = must(root, '#hud-alive');
    this.bannerEl = must(root, '#event-banner');
    this.statusEl = must(root, '#status-chip');
    this.grabBtn = must(root, '#btn-grab');
    this.skillLabel = must(root, '#skill-name');
    this.interactLabel = must(root, '#interact-name');
    this.scoreEl = must(root, '#hud-score');
    this.sitBar = must(root, '#sit-bar');
    this.sitFill = must(root, '#sit-fill');
    this.grabState = must(root, '#grab-state');
    this.seatGuide = must(root, '#seat-guide');
    this.seatArrow = must(root, '#seat-arrow');
    this.toast = must(root, '#skill-toast');

    this.btns = {
      dash: must(root, '#btn-dash'),
      push: must(root, '#btn-push'),
      skill: must(root, '#btn-skill')
    };
    const mkCd = (btn: HTMLElement): HTMLElement => {
      const cd = document.createElement('div');
      cd.className = 'cd';
      btn.appendChild(cd);
      return cd;
    };
    this.cdEls = {
      dash: mkCd(this.btns.dash),
      push: mkCd(this.btns.push),
      skill: mkCd(this.btns.skill)
    };
  }

  show() {
    this.root.classList.remove('hidden');
  }

  /**
   * 开新局前清空所有瞬态显示。
   * 结算时循环直接停了，上一局最后一条横幅/飘字的计时停在半路，
   * 不清的话会在下一局开场再闪一次（比如上车时冒出"车身甩向车门"）。
   */
  reset() {
    this.bannerTimer = 0;
    this.bannerShown = 0;
    this.bannerCur = null;
    this.bannerQueue = [];
    this.bannerEl.classList.remove('show');
    this.bannerEl.textContent = '';
    this.statusTimer = 0;
    this.statusEl.classList.remove('show');
    this.toastTimer = 0;
    this.toast.classList.remove('show', 'fail');
    this.setGrabState(null);
    this.setGrab(false);
    this.sitBar.classList.remove('show');
    this.seatGuide.classList.remove('show', 'ready', 'full', 'locked');
    this.grabBtn.classList.remove('sit');
    this.setStunned(false);
    this.setCooldowns(0, 0, 0);
  }

  /** 硬直中按键不会立刻生效（只缓冲 0.15 秒），按钮要看得出来"现在按不动"。 */
  setStunned(on: boolean) {
    this.root.classList.toggle('stunned', on);
  }

  /** 技能按钮上直接写角色的技能名，玩家不用去记自己选了谁。 */
  setSkillName(name: string) {
    this.skillLabel.textContent = name;
  }

  /**
   * 抓住状态常驻显示。
   * 以前按下"抓住"只有按钮变个色，玩家既不知道抓没抓上、也不知道抓的是哪根。
   */
  setGrabState(railId: number | null) {
    if (railId === null) {
      this.grabState.classList.remove('show');
      this.grabState.textContent = '';
      return;
    }
    this.grabState.textContent = `✋ 抓住 ${railId + 1} 号扶手 · 受力 -70%`;
    this.grabState.classList.add('show');
  }

  /** 屏幕中部的技能/操作飘字。 */
  toastText(text: string, tone: 'ok' | 'fail' = 'ok') {
    this.toast.textContent = text;
    this.toast.classList.toggle('fail', tone === 'fail');
    this.toast.classList.add('show');
    this.toastTimer = tone === 'fail' ? 0.9 : 1.3;
  }

  hide() {
    this.root.classList.add('hidden');
  }

  update(s: Snapshot) {
    const pct = Math.round(s.crowd);
    this.crowdFill.style.width = pct + '%';
    this.crowdPct.textContent = pct + '%';
    this.crowdBox.classList.toggle('high', pct >= BALANCE.crowdHigh);
    this.phaseChip.textContent = PHASE_LABEL[s.phase];
    this.time.textContent =
      s.phase === 'boarding' || s.phase === 'ignition'
        ? Math.ceil(s.boardTimer) + 's'
        : fmt(BALANCE.matchDuration - s.time);
    this.alive.textContent = String(s.aliveCount);
    this.scoreEl.textContent = String(s.playerScore);
    // 交互键这一下到底做什么，直接写在按钮上；共用一个键但语义必须可见。
    this.interactLabel.textContent = INTERACT_LABEL[s.interactHint];
    this.grabBtn.classList.toggle('on', s.playerSeat !== null || s.playerRail !== null);
    // 可坐时按钮整体换色 + 脉冲。只换两个字在 42px 的按钮上是看不见的。
    this.grabBtn.classList.toggle('sit', s.interactHint === 'sit');
    // 坐姿稳定度：被推三下就会被拽起来，这条不显示玩家不知道自己快掉了。
    const seated = s.playerSeat !== null;
    this.sitBar.classList.toggle('show', seated);
    if (seated) this.sitFill.style.width = Math.round(s.playerSitStability * 100) + '%';
    this.updateSeatGuide(s);
  }

  /**
   * 座位导航。
   *
   * 三段式，每一段都必须给出**下一步动作**，不能只报告状态：
   * - 有空座、还没走到 → 告诉他往哪看（绿光柱）和还剩几个；
   * - 已就位 → 告诉他按哪个键；
   * - 全满 → 这才是关键一条：告诉他"推坐着的人"，
   *   否则玩家会认为座位系统对自己关闭了，从此再也不看它。
   */
  private updateSeatGuide(s: Snapshot) {
    // 人不在场（返场途中/已出局）时不给找座提示：以前会显示粉色"座位满了"。
    const active = s.playerAlive
      && (s.phase === 'ignition' || s.phase === 'driving') && s.playerSeat === null;
    this.seatGuide.classList.toggle('show', active);
    if (!active) return;
    const free = s.seats.filter((x) => x.free).length;
    const g = s.seatGuide;
    const locked = !!g && g.lockLeft > 0;
    this.seatGuide.classList.toggle('ready', !!g?.inReach);
    this.seatGuide.classList.toggle('full', free === 0);
    this.seatGuide.classList.toggle('locked', locked);
    if (locked) this.seatGuide.textContent = `🪑 刚被拽起 · ${Math.ceil(g!.lockLeft)} 秒后才能再坐`;
    else if (g?.inReach) this.seatGuide.textContent = '🪑 就位了 · 按【坐下】占座';
    else if (g) this.seatGuide.textContent = `🪑 还有 ${free} 个空座 · 走到绿色光柱跟前`;
    else this.seatGuide.textContent = '🪑 座位满了 · 连推 💥 三下把坐着的人拽起来';
  }

  /**
   * 找座箭头。leftPct/topPct 是舞台百分比坐标，angle 是屏幕上的指向（弧度，0 = 朝右，顺时针为正）。
   * 传 null 收起。
   */
  setSeatArrow(pos: { leftPct: number; topPct: number; angle: number } | null) {
    this.seatArrow.classList.toggle('show', !!pos);
    if (!pos) return;
    this.seatArrow.style.left = pos.leftPct.toFixed(2) + '%';
    this.seatArrow.style.top = pos.topPct.toFixed(2) + '%';
    this.seatArrow.style.setProperty('--rot', pos.angle.toFixed(3) + 'rad');
  }

  /** 玩家状态提示（抓住扶手 / 返场保护已用完 等）。 */
  status(text: string, seconds = 1.6) {
    this.statusEl.textContent = text;
    this.statusEl.classList.add('show');
    this.statusTimer = seconds;
  }

  setGrab(on: boolean) {
    this.grabBtn.classList.toggle('on', on);
  }

  /**
   * 横幅：一个显示位 + 带优先级的队列。
   *
   * 以前是单槽直接覆盖：同一帧里"你把兰姐挤下车 +70"被紧跟着的"兰姐 被挤下车"盖掉，
   * "终点前：好挤模式"被下一帧的"车身左摆"盖掉 —— 最要紧的两条反馈玩家都看不到。
   * 规则：更高优先级立即顶掉当前这条；同级的排队，前一条至少显示 BANNER_MIN 再让位；
   * 更低的排队等当前这条放满；排太久的作废；同文案不重复入队。
   */
  banner(text: string, prio: BannerPrio = 2) {
    if (this.bannerCur?.text === text || this.bannerQueue.some((b) => b.text === text)) return;
    const item: BannerItem = { text, prio, at: this.clock };
    if (!this.bannerCur || prio > this.bannerCur.prio) {
      this.showBanner(item);
      return;
    }
    this.bannerQueue.push(item);
    // 高优先级在前，同级按先来后到。
    this.bannerQueue.sort((a, b) => b.prio - a.prio || a.at - b.at);
    if (this.bannerQueue.length > BANNER_QUEUE_MAX) this.bannerQueue.length = BANNER_QUEUE_MAX;
  }

  private showBanner(item: BannerItem) {
    this.bannerCur = item;
    this.bannerEl.textContent = item.text;
    this.bannerEl.classList.add('show');
    this.bannerTimer = BANNER_DUR;
    this.bannerShown = 0;
  }

  private advanceBanner(dt: number) {
    this.bannerQueue = this.bannerQueue.filter((b) => this.clock - b.at <= BANNER_STALE);
    if (!this.bannerCur) {
      const next = this.bannerQueue.shift();
      if (next) this.showBanner(next);
      return;
    }
    this.bannerTimer -= dt;
    this.bannerShown += dt;
    // 只给同级或更高优先级的让位；低优先级（摆动等）必须等当前这条放满，
    // 否则每 1.7 秒一条的摆动会把"终点前：好挤模式"压到 0.8 秒。
    const head = this.bannerQueue[0];
    const yieldNow = !!head && head.prio >= this.bannerCur.prio && this.bannerShown >= BANNER_MIN;
    if (this.bannerTimer > 0 && !yieldNow) return;
    const next = this.bannerQueue.shift();
    if (next) {
      this.showBanner(next);
    } else {
      this.bannerCur = null;
      this.bannerEl.classList.remove('show');
    }
  }

  setCooldowns(dash: number, push: number, skill: number) {
    this.renderCd('dash', dash);
    this.renderCd('push', push);
    this.renderCd('skill', skill);
  }

  private renderCd(key: 'dash' | 'push' | 'skill', sec: number) {
    const btn = this.btns[key];
    const el = this.cdEls[key];
    // 用 ceil：0.4 秒剩余显示 "1"，不会出现读秒读到 "0" 还按不动的尴尬。
    // 阈值必须和模拟一致（cd <= 0 才能放）；以前 0.05 秒时就显示可按，按下去被吞。
    if (sec <= 0) {
      btn.classList.remove('cooling');
      el.textContent = '';
      return;
    }
    btn.classList.add('cooling');
    el.textContent = String(Math.ceil(sec));
  }

  /** 每帧推进横幅/状态条淡出。 */
  frame(dt: number) {
    this.clock += dt;
    this.advanceBanner(dt);
    if (this.statusTimer > 0) {
      this.statusTimer -= dt;
      if (this.statusTimer <= 0) this.statusEl.classList.remove('show');
    }
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.classList.remove('show');
    }
  }
}

function must(root: HTMLElement, sel: string): HTMLElement {
  const el = root.querySelector(sel) as HTMLElement | null;
  if (!el) throw new Error('HUD 元素缺失: ' + sel);
  return el;
}
