import type { Snapshot, BannerPrio } from '../domain/types';

interface BannerItem {
  text: string;
  prio: BannerPrio;
  /** 进队列的时刻（HUD 自己的时钟），排太久的低优先级直接丢掉。 */
  at: number;
}

/** 顶栏回合框里的一个人。 */
export interface RoundPlayer {
  id: number;
  name: string;
  color: string;
  /** 本场已赢的回合数。 */
  wins: number;
  /** 本回合还在车上。 */
  alive: boolean;
  isPlayer: boolean;
}

export interface RoundInfo {
  /** 第几回合（从 1 开始）。 */
  round: number;
  /** 先赢几回合拿下整场。 */
  winsNeeded: number;
  players: RoundPlayer[];
}

/** 单条横幅显示时长。 */
const BANNER_DUR = 1.6;
/** 后面有人排队时，当前这条至少显示多久再让位。 */
const BANNER_MIN = 0.8;
/** 排队超过这么久还没轮到就作废（信息已经过时）。 */
const BANNER_STALE = 2.4;
/** 队列上限：好挤模式里摇摆横幅很密，不设上限会越积越多。 */
const BANNER_QUEUE_MAX = 3;

const fmt = (s: number): string => {
  const v = Math.max(0, s);
  const m = Math.floor(v / 60);
  const r = Math.floor(v % 60);
  return `${m}:${r.toString().padStart(2, '0')}`;
};

/** "抓"键这一下做什么：图标 + 文案一起换，只换字在拇指底下看不见。 */
const GRAB_FACE: Record<Snapshot['interactHint'], { ico: string; lbl: string }> = {
  grab: { ico: '✋', lbl: '抓' },
  none: { ico: '✋', lbl: '抓' },
  sit: { ico: '🪑', lbl: '坐下' },
  stand: { ico: '⬆', lbl: '起身' },
  release: { ico: '🖐', lbl: '松手' }
};

const PHASE_LABEL: Record<Snapshot['phase'], string> = {
  boarding: '上车中',
  ignition: '发车中',
  driving: '行驶中',
  finale: '好挤模式',
  ended: '到站'
};

/**
 * 名字里挑一个字放进小圆：玩家是"你"，其余取名字最后一个字（"兰姐"取"兰"，"阿强"取"强"）。
 * 8 个人只靠颜色分不清，一个字就够认人。
 */
export function nameGlyph(name: string, isPlayer: boolean): string {
  if (isPlayer) return '你';
  const chars = Array.from(name.trim().replace(/[姐哥]$/, ''));
  return chars[chars.length - 1] ?? '?';
}

/** 只在内容变了时才写 DOM：update() 每帧都会调，同值重写也会触发重排。 */
function setText(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

interface PipView {
  el: HTMLElement;
  pips: HTMLElement[];
}

/**
 * 对局 HUD：回合与胜场、阶段、离终点时间、车上人数、横幅、飘字、3 个动作键（抓 / 推·扔 / 冲）与暂停。
 * 没有积分、没有技能（docs/08 第 3.7 节）。
 */
export class HUD {
  private root: HTMLElement;
  private phaseChip: HTMLElement;
  private timeLabel: HTMLElement;
  private time: HTMLElement;
  private alive: HTMLElement;
  private roundEl: HTMLElement;
  private goalEl: HTMLElement;
  private pipsBox: HTMLElement;
  private bannerEl: HTMLElement;
  private statusEl: HTMLElement;
  private grabBtn: HTMLElement;
  private grabIco: HTMLElement;
  private grabName: HTMLElement;
  private pushIco: HTMLElement;
  private pushName: HTMLElement;
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
  /** 回合框的结构签名（人、颜色、先赢几回合），变了才重建小圆。 */
  private pipSig = '';
  private pipViews = new Map<number, PipView>();

  private btns: Record<'dash' | 'push', HTMLElement>;
  private cdEls: Record<'dash' | 'push', HTMLElement>;

  constructor(root: HTMLElement) {
    this.root = root;
    this.phaseChip = must(root, '#phase-chip');
    this.timeLabel = must(root, '#hud-time-label');
    this.time = must(root, '#hud-time');
    this.alive = must(root, '#hud-alive');
    this.roundEl = must(root, '#hud-round');
    this.goalEl = must(root, '#hud-goal');
    this.pipsBox = must(root, '#round-pips');
    this.bannerEl = must(root, '#event-banner');
    this.statusEl = must(root, '#status-chip');
    this.grabBtn = must(root, '#btn-grab');
    this.grabIco = must(root, '#grab-ico');
    this.grabName = must(root, '#grab-name');
    this.pushIco = must(root, '#push-ico');
    this.pushName = must(root, '#push-name');
    this.grabState = must(root, '#grab-state');
    this.seatGuide = must(root, '#seat-guide');
    this.seatArrow = must(root, '#seat-arrow');
    this.toast = must(root, '#hud-toast');

    this.btns = {
      dash: must(root, '#btn-dash'),
      push: must(root, '#btn-push')
    };
    const mkCd = (btn: HTMLElement): HTMLElement => {
      const cd = document.createElement('div');
      cd.className = 'cd';
      btn.appendChild(cd);
      return cd;
    };
    this.cdEls = {
      dash: mkCd(this.btns.dash),
      push: mkCd(this.btns.push)
    };
  }

  show() {
    this.root.classList.remove('hidden');
  }

  hide() {
    this.root.classList.add('hidden');
  }

  /**
   * 开新回合前清空所有瞬态显示。
   * 回合结束时循环停了，上一回合最后一条横幅/飘字的计时停在半路，
   * 不清的话会在下一回合开场再闪一次。回合框（胜场）不清：它跨回合，由 setRoundInfo 刷新。
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
    this.grabState.classList.remove('show', 'hot', 'seat');
    this.seatGuide.classList.remove('show', 'ready', 'full');
    this.setSeatArrow(null);
    this.grabBtn.classList.remove('on', 'sit');
    this.btns.push.classList.remove('throw', 'hot', 'off');
    this.btns.dash.classList.remove('off');
    setText(this.grabIco, GRAB_FACE.grab.ico);
    setText(this.grabName, GRAB_FACE.grab.lbl);
    setText(this.pushIco, '💥');
    setText(this.pushName, '推');
    this.root.classList.remove('out');
    this.setStunned(false);
    this.setCooldowns(0, 0);
  }

  /** 硬直中按键不会立刻生效（只缓冲 0.15 秒），按钮要看得出来"现在按不动"。 */
  setStunned(on: boolean) {
    this.root.classList.toggle('stunned', on);
  }

  /**
   * 回合框：第几回合、先赢几回合，每人一颗小圆 + 胜场小点；已淘汰的变灰，玩家描黄边。
   * 可以每帧调：结构没变时只切 class。
   */
  setRoundInfo(info: RoundInfo) {
    setText(this.roundEl, `第 ${info.round} 回合`);
    setText(this.goalEl, `先赢 ${info.winsNeeded} 回合`);
    const need = Math.max(1, info.winsNeeded);
    const sig = need + '|' + info.players
      .map((p) => `${p.id}:${p.name}:${p.color}:${p.isPlayer ? 1 : 0}`).join(',');
    if (sig !== this.pipSig) {
      this.pipSig = sig;
      this.pipViews.clear();
      this.pipsBox.innerHTML = '';
      for (const p of info.players) {
        const el = document.createElement('div');
        el.className = 'rp' + (p.isPlayer ? ' me' : '');
        el.title = p.name;
        const dot = document.createElement('i');
        dot.className = 'rp-dot';
        dot.style.setProperty('--c', p.color);
        dot.textContent = nameGlyph(p.name, p.isPlayer);
        const wins = document.createElement('b');
        wins.className = 'rp-wins';
        const pips: HTMLElement[] = [];
        for (let i = 0; i < need; i++) {
          const pip = document.createElement('i');
          wins.appendChild(pip);
          pips.push(pip);
        }
        el.append(dot, wins);
        this.pipsBox.appendChild(el);
        this.pipViews.set(p.id, { el, pips });
      }
    }
    for (const p of info.players) {
      const v = this.pipViews.get(p.id);
      if (!v) continue;
      v.el.classList.toggle('out', !p.alive);
      v.pips.forEach((pip, i) => pip.classList.toggle('on', i < p.wins));
    }
  }

  /** 屏幕中部的操作飘字。 */
  toastText(text: string, tone: 'ok' | 'fail' = 'ok') {
    this.toast.textContent = text;
    this.toast.classList.toggle('fail', tone === 'fail');
    this.toast.classList.add('show');
    this.toastTimer = tone === 'fail' ? 0.9 : 1.3;
  }

  update(s: Snapshot) {
    // 车门开着的那几秒是全车的击杀窗口：阶段牌直接喊出来。
    const doorAlert = s.phase === 'driving' && s.doorsOpen;
    setText(this.phaseChip, doorAlert ? '车门开着' : PHASE_LABEL[s.phase]);
    this.phaseChip.classList.toggle('alert', doorAlert || s.phase === 'finale');
    if (s.phase === 'boarding') {
      setText(this.timeLabel, '发车');
      setText(this.time, Math.ceil(Math.max(0, s.boardTimer)) + 's');
    } else {
      setText(this.timeLabel, '到终点');
      setText(this.time, fmt(s.roundTimeLeft));
    }
    setText(this.alive, s.aliveCount + '人');
    this.root.classList.toggle('out', !s.playerAlive);
    this.updateButtons(s);
    this.updateGrabState(s);
    this.updateSeatGuide(s);
  }

  /**
   * 三个动作键跟着局面换脸：
   * - 抓：文案随 interactHint（抓 / 坐下 / 起身 / 松手）；抓着东西变黄，够得着空座变绿并脉冲；
   * - 推：抓着已摔倒的人时变成"扔"（黄），车门开着再加脉冲；
   * - 坐着时推、冲都用不了，直接压暗。
   */
  private updateButtons(s: Snapshot) {
    const face = GRAB_FACE[s.interactHint] ?? GRAB_FACE.grab;
    setText(this.grabIco, face.ico);
    setText(this.grabName, face.lbl);
    this.grabBtn.classList.toggle('on', s.playerHold !== 'none');
    this.grabBtn.classList.toggle('sit', s.interactHint === 'sit');

    const throwing = s.playerHold === 'char' && s.playerHoldingDown;
    const push = this.btns.push;
    setText(this.pushIco, throwing ? '🤾' : '💥');
    setText(this.pushName, throwing ? '扔' : '推');
    push.classList.toggle('throw', throwing);
    push.classList.toggle('hot', throwing && s.doorsOpen);
    push.classList.toggle('off', s.playerSeated);
    this.btns.dash.classList.toggle('off', s.playerSeated);
  }

  /**
   * 手上状态常驻显示（底部档 0）。每一条都给出**下一步动作**，不只报告状态：
   * 拖着摔倒的人时最要紧 —— 车门开着就是"拖到门口按扔"。
   */
  private updateGrabState(s: Snapshot) {
    let text = '';
    let tone: '' | 'hot' | 'seat' = '';
    if (s.playerAlive && s.phase !== 'ended') {
      if (s.playerSeated) {
        text = '🪑 坐着最稳 · 推不了也冲不了';
        tone = 'seat';
      } else if (s.playerHold === 'rail') {
        text = '✋ 抓着扶手 · 晃不倒';
      } else if (s.playerHold === 'char' && s.playerHoldingDown) {
        if (s.doorsOpen) {
          text = '🚪 车门开着 · 拖到门口按【扔】';
          tone = 'hot';
        } else {
          text = '✋ 拖着他 · 等车门开了扔出去';
        }
      } else if (s.playerHold === 'char') {
        text = '✋ 扯住了 · 推倒了才能扔';
      }
    }
    const el = this.grabState;
    el.classList.toggle('show', text !== '');
    el.classList.toggle('hot', tone === 'hot');
    el.classList.toggle('seat', tone === 'seat');
    if (text) setText(el, text);
  }

  /**
   * 座位提示：只在够得着空座时出现。
   * 新玩法里坐下是"龟缩还是出手"的取舍，不该一直引导玩家去找座 —— 那会把新手教成只会坐着。
   */
  private updateSeatGuide(s: Snapshot) {
    const g = s.seatGuide;
    const active = !!g?.inReach && s.playerAlive && !s.playerSeated && s.playerHold === 'none'
      && (s.phase === 'ignition' || s.phase === 'driving');
    this.seatGuide.classList.toggle('show', active);
    if (!active) return;
    this.seatGuide.classList.add('ready');
    this.seatGuide.classList.remove('full');
    setText(this.seatGuide, '🪑 按【坐下】坐着最稳 · 但不能出手');
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

  /** 顶部的短暂状态提示（如"走进后门上车！"）。 */
  status(text: string, seconds = 1.6) {
    this.statusEl.textContent = text;
    this.statusEl.classList.add('show');
    this.statusTimer = seconds;
  }

  /**
   * 横幅：一个显示位 + 带优先级的队列。
   *
   * 单槽直接覆盖的话，同一帧里"你把兰姐扔下车"会被紧跟着的"兰姐 被扔下车"盖掉，
   * "好挤模式"会被下一帧的"车身左摆"盖掉 —— 最要紧的反馈玩家都看不到。
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
    // 只给同级或更高优先级的让位；低优先级（摆动等）必须等当前这条放满。
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

  /** 冲 / 推的冷却剩余秒数（<=0 表示可以按）。 */
  setCooldowns(dash: number, push: number) {
    this.renderCd('dash', dash);
    this.renderCd('push', push);
  }

  private renderCd(key: 'dash' | 'push', sec: number) {
    const btn = this.btns[key];
    const el = this.cdEls[key];
    // 阈值必须和模拟一致（cd <= 0 才能放），否则显示可按、按下去被吞。
    if (!(sec > 0)) {
      btn.classList.remove('cooling');
      setText(el, '');
      return;
    }
    btn.classList.add('cooling');
    // 用 ceil：0.4 秒剩余显示 "1"，不会出现读秒读到 "0" 还按不动。
    setText(el, String(Math.ceil(sec)));
  }

  /** 每帧推进横幅/状态条/飘字的淡出。 */
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
