import type { GameEvent, Snapshot } from '../domain/types';
import { skipTutorial } from '../core/storage';

/**
 * 首局引导（docs/08 第 6.5 节）：第一回合里依次教会
 * 上车 → 抓扶手 → 推人 → 把摔倒的人拖到车门扔出去 → 坐下与拽人。
 *
 * 三条设计约束：
 * 1. **不做全屏遮罩**。摇杆是"左半屏任意位置动态起按"，任何盖在上面的遮罩都会
 *    吃掉 pointerdown，玩家会发现"教程让我走但我走不动"。改用底部气泡 +
 *    目标按钮加脉冲光环，遮罩零覆盖。
 * 2. **不暂停游戏**、不做独立教学关。微信场景第一屏必须是真实对局。
 * 3. 每条都能被玩家的动作**提前结束**，不是干等超时。
 *
 * 两类步骤：
 * - **顺序步骤**：一条接一条。每条都有等待上限，等不到触发条件就跳过，
 *   不能让一条等不到的条件把后面的步骤全卡死。
 * - **插队步骤**：条件一满足就立刻打断当前气泡。"车门开着"是全车的击杀窗口、
 *   "好挤模式"两门全开，都是保命信息，不能排在后面等。
 *
 * 按钮只在"按了一定有用"时才闪（pulseIf），闪了按不出东西，玩家第一次尝试就学到错误结论。
 * 触发条件全部挂在 Snapshot / GameEvent 上，不新增任何模拟逻辑。
 *
 * 一回合没讲完（比如玩家早早被扔下车）会接着在下一回合讲；session 想只教第一回合，
 * 在第一回合结束时调 stop() 即可。
 */

interface Ctx {
  /** 玩家的角色 id。 */
  pid: number;
  t: number;
  /** 玩家累计推 / 撞中别人的次数。 */
  hits: number;
  /** 当前这一条出现时的 hits，用来数"出现之后推中了几下"。 */
  hitsAtShow: number;
  /** 最近一次有人摔倒的时刻。 */
  lastDownAt: number;
}

interface Step {
  id: string;
  /** 文案可以跟着局面变（比如车门开没开）。 */
  text: string | ((s: Snapshot) => string);
  /** 要高亮的按钮选择器。 */
  pulse?: string;
  /** 只有这时才闪（缺省一直闪）。 */
  pulseIf?(s: Snapshot): boolean;
  /** 什么时候该出这一条。 */
  when(s: Snapshot, c: Ctx): boolean;
  /** 什么时候算学会了。 */
  done(s: Snapshot, ev: GameEvent[], c: Ctx): boolean;
  /** 条件满足时这一条已经没意义，直接跳过。 */
  skip?(s: Snapshot): boolean;
  /** 显示后的兜底超时（秒）。 */
  timeout: number;
  /** 等 when() 的上限（秒），超时跳过。顺序步骤必须有，否则会卡死整条链。 */
  waitLimit: number;
}

const riding = (s: Snapshot) => s.phase === 'ignition' || s.phase === 'driving';
/** 站着、空手、能出手。 */
const freeHands = (s: Snapshot) => !s.playerSeated && s.playerHold === 'none';
/** "抓"这一下能抓到东西（伸手范围里有人或扶手）。 */
const canGrab = (s: Snapshot) => s.interactHint === 'grab';

const SEQUENCE: Step[] = [
  {
    id: 'move',
    text: '推动左边的摇杆，走进后门上车',
    pulse: '#joystick-base',
    when: (s) => s.phase === 'boarding',
    done: (s) => s.phase !== 'boarding',
    timeout: 6,
    waitLimit: 3
  },
  {
    id: 'rail',
    text: '车要晃了！靠近扶手点【抓】· 抓着就晃不倒，再点一下松手',
    pulse: '#btn-grab',
    pulseIf: canGrab,
    when: (s) => riding(s) && freeHands(s),
    // 抓住人也算学会了"抓"。
    done: (s) => s.playerHold !== 'none',
    skip: (s) => s.playerSeated,
    timeout: 7,
    waitLimit: 5
  },
  {
    id: 'push',
    text: '按【推】撞人 · 连推几下就能把人推倒',
    pulse: '#btn-push',
    pulseIf: (s) => !s.playerSeated,
    when: (s) => s.phase === 'driving' && !s.playerSeated,
    done: (_s, ev, c) =>
      ev.some((e) => e.type === 'knockdown' && e.byId === c.pid) || c.hits - c.hitsAtShow >= 3,
    timeout: 8,
    waitLimit: 6
  },
  {
    id: 'drag',
    text: '有人摔倒了！趁他瘫着，点【抓】把他拎起来',
    pulse: '#btn-grab',
    pulseIf: canGrab,
    // 摔倒只瘫 1.6 秒，这条只在有人刚摔倒时出。
    when: (s, c) => s.phase === 'driving' && freeHands(s) && c.t - c.lastDownAt < 1.6,
    done: (s) => s.playerHoldingDown,
    skip: (s) => s.playerHoldingDown && s.playerHold === 'char',
    timeout: 6,
    waitLimit: 12
  },
  {
    id: 'throw',
    text: (s) => s.doorsOpen
      ? '车门开着！拖到门口按【扔】，把他扔下车'
      : '拖着他等车门打开，到门口按【扔】',
    pulse: '#btn-push',
    // 车门开着才闪：关着门扔只会把人甩到墙上。
    pulseIf: (s) => s.doorsOpen,
    when: (s) => s.playerHold === 'char' && s.playerHoldingDown,
    done: (_s, ev, c) => ev.some((e) => e.type === 'throw' && e.byId === c.pid),
    timeout: 10,
    // 上一条被跳过（没人摔倒 / 没抓起来）时，这条再等 4 秒就算了。
    waitLimit: 4
  },
  {
    id: 'seat',
    text: (s) => s.playerSeated
      ? '坐着最稳，但推不了也冲不了 · 小心被人拽起来'
      : '坐下最稳但不能出手 · 抓住坐着的人不放，能把他拽起来',
    pulse: '#btn-grab',
    pulseIf: (s) => s.interactHint === 'sit',
    when: (s) => s.phase === 'driving' && (s.playerSeated || s.playerHold === 'none'),
    done: (_s, ev, c) => ev.some((e) =>
      (e.type === 'sit' && e.charId === c.pid) || (e.type === 'yank' && e.byId === c.pid)),
    timeout: 8,
    waitLimit: 8
  }
];

/** 插队步骤：各自最多出一次。 */
const URGENT: Step[] = [
  {
    id: 'door',
    text: '车门开了！这时能把人扔出去 · 你也离门口远点',
    // 电平触发：只要行驶中有门开着就出，不依赖"到站那一帧"的事件。
    // 已经拖着摔倒的人时让给"扔"那一条，它讲的正是这件事。
    when: (s) => s.phase === 'driving' && s.doorsOpen && !s.playerHoldingDown,
    done: (s) => !s.doorsOpen || s.playerHoldingDown,
    timeout: 4,
    waitLimit: Infinity
  },
  {
    id: 'finale',
    text: '好挤模式！两扇门全开 · 抓紧扶手别被甩出去',
    pulse: '#btn-grab',
    pulseIf: canGrab,
    when: (s) => s.phase === 'finale',
    done: (s) => s.playerHold === 'rail' || s.playerSeated,
    timeout: 5,
    waitLimit: Infinity
  }
];

export class Tutorial {
  private bubble: HTMLElement;
  private skipBtn: HTMLElement;
  private idx = 0;
  private shownAt = -1;
  private pendingSince = -1;
  private pulsing: HTMLElement | null = null;
  private finished = false;
  /** 正在显示的插队步骤（null = 当前是顺序步骤或空闲）。 */
  private urgent: Step | null = null;
  private urgentAt = 0;
  private urgentDone = new Set<string>();
  private ctx: Ctx;

  /** playerId：玩家角色的 id（session 里玩家固定是 0）。 */
  constructor(private root: HTMLElement, playerId = 0) {
    this.ctx = { pid: playerId, t: 0, hits: 0, hitsAtShow: 0, lastDownAt: -Infinity };
    this.bubble = root.querySelector('#tut-bubble') as HTMLElement;
    this.skipBtn = root.querySelector('#tut-skip') as HTMLElement;
    this.skipBtn.classList.remove('hidden');
    this.skipBtn.onclick = () => {
      skipTutorial();
      this.stop();
    };
  }

  /** 每个模拟步喂快照和本步事件。 */
  update(s: Snapshot, ev: GameEvent[], t: number) {
    if (this.finished) return;
    const c = this.ctx;
    c.t = t;
    for (const e of ev) {
      if (e.type === 'hit' && e.byId === c.pid) c.hits++;
      else if (e.type === 'knockdown' && e.charId !== c.pid) c.lastDownAt = t;
    }

    // 人不在场（已被扔下车）或回合已结束：先收起气泡，别对着观战画面讲操作。
    if (!s.playerAlive || s.phase === 'ended') {
      this.hideBubble();
      if (this.urgent) this.finishUrgent();
      this.shownAt = -1;
      this.pendingSince = t;
      return;
    }

    // 1) 插队步骤优先。
    if (this.urgent) {
      if (this.urgent.done(s, ev, c) || t - this.urgentAt > this.urgent.timeout) {
        this.finishUrgent();
        // 插队期间不计顺序步骤的等待时间。
        this.pendingSince = t;
      } else {
        this.paint(this.urgent, s);
      }
      return;
    }
    const hot = URGENT.find((u) => !this.urgentDone.has(u.id) && u.when(s, c));
    // 玩家已经做到了（比如好挤模式开始时本来就坐着）：记为讲过，不闪一帧气泡。
    if (hot && hot.done(s, ev, c)) {
      this.urgentDone.add(hot.id);
    } else if (hot) {
      this.urgent = hot;
      this.urgentAt = t;
      // 被打断的顺序步骤：已经讲了一半以上就算讲过，否则等插队讲完再完整出一次。
      const cur = SEQUENCE[this.idx];
      if (cur && this.shownAt >= 0 && t - this.shownAt > cur.timeout / 2) this.idx++;
      this.shownAt = -1;
      this.pendingSince = t;
      this.paint(hot, s);
      return;
    }

    // 2) 顺序步骤。
    const step = SEQUENCE[this.idx];
    if (!step) {
      // 顺序步骤讲完了：剩下的插队步骤都很短，"跳过教学"不必再挂着。
      this.skipBtn.classList.add('hidden');
      if (this.urgentDone.size >= URGENT.length) this.stop();
      return;
    }
    if (this.pendingSince < 0) this.pendingSince = t;
    if (step.skip?.(s)) return this.next(t);
    if (this.shownAt < 0) {
      if (!step.when(s, c)) {
        // 玩家自己先做到了就直接跳过，不要为了"讲完"而干等。
        if (step.done(s, ev, c)) return this.next(t);
        // 等不到触发条件也要跳过，别把后面的步骤一起卡死。
        if (t - this.pendingSince > step.waitLimit) this.next(t);
        return;
      }
      this.shownAt = t;
      c.hitsAtShow = c.hits;
      this.paint(step, s);
      return;
    }
    if (step.done(s, ev, c) || t - this.shownAt > step.timeout) this.next(t);
    else this.paint(step, s);
  }

  /** 显示/刷新气泡：文案和按钮脉冲都可能随局面变。 */
  private paint(step: Step, s: Snapshot) {
    const text = typeof step.text === 'function' ? step.text(s) : step.text;
    if (this.bubble.textContent !== text) this.bubble.textContent = text;
    this.bubble.classList.add('show');
    const want = step.pulse && (step.pulseIf?.(s) ?? true)
      ? this.root.querySelector(step.pulse) as HTMLElement | null
      : null;
    if (want === this.pulsing) return;
    this.clearPulse();
    if (want) {
      want.classList.add('tut-pulse');
      this.pulsing = want;
    }
  }

  private finishUrgent() {
    if (this.urgent) this.urgentDone.add(this.urgent.id);
    this.urgent = null;
    this.hideBubble();
  }

  private hideBubble() {
    this.bubble.classList.remove('show');
    this.clearPulse();
  }

  private next(t: number) {
    this.idx++;
    this.shownAt = -1;
    this.pendingSince = t;
    this.hideBubble();
  }

  private clearPulse() {
    this.pulsing?.classList.remove('tut-pulse');
    this.pulsing = null;
  }

  stop() {
    this.finished = true;
    this.urgent = null;
    this.bubble.classList.remove('show');
    this.skipBtn.classList.add('hidden');
    this.clearPulse();
  }
}
