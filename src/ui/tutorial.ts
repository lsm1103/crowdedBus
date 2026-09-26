import type { GameEvent, Snapshot } from '../domain/types';
import { skipTutorial } from '../core/storage';

/**
 * 首局引导。
 *
 * 三条设计约束：
 * 1. **不做全屏遮罩**。摇杆是"左半屏任意位置动态起按"，任何盖在上面的遮罩都会
 *    吃掉 pointerdown，玩家会发现"教程让我走但我走不动"。改用底部气泡 +
 *    目标按钮加脉冲光环，遮罩零覆盖。
 * 2. **不暂停游戏**、不做独立教学关。微信场景第一屏必须是真实对局。
 * 3. 每条都能被玩家的动作**提前结束**，不是干等超时。
 *
 * 两类步骤：
 * - **顺序步骤**：一条接一条。每条都有等待上限，等不到触发条件就跳过；
 *   以前"黄圈"那条要求"没坐下"，玩家照着教学抢到座后（实测 99.5% 能坐到终局）
 *   这条永远等不到，后面"推挤/门口/抓扶手"全部丢失。
 * - **插队步骤**：条件一满足就立刻打断当前气泡。"门开了会淘汰""终局抓扶手"
 *   是保命信息，不能排在"去黄圈"后面等 —— 以前门口警告要等前 4 条讲完，
 *   而且只在"到站那一帧"触发，常常赶不上第一、二站，排晚了还会永远卡住。
 *
 * 触发条件全部挂在已有的 phase / snapshot / GameEvent 上，不新增任何模拟逻辑。
 */

interface Step {
  id: string;
  text: string;
  /** 要高亮的按钮选择器。 */
  pulse?: string;
  /** 什么时候该出这一条。 */
  when(s: Snapshot, ev: GameEvent[]): boolean;
  /** 什么时候算学会了。 */
  done(s: Snapshot, ev: GameEvent[]): boolean;
  /** 条件满足时这一条已经没意义，直接跳过（例如已经坐下就不教"没座去黄圈"）。 */
  skip?(s: Snapshot): boolean;
  /** 显示后的兜底超时（秒）。 */
  timeout: number;
  /** 等 when() 的上限（秒），超时跳过。顺序步骤必须有，否则会卡死整条链。 */
  waitLimit: number;
}

const has = (ev: GameEvent[], t: GameEvent['type']) => ev.some((e) => e.type === t);
const riding = (s: Snapshot) => s.phase === 'ignition' || s.phase === 'driving';

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
  // 抢座这件事拆成"走过去"和"按下去"两条。
  // 原来合成一条、并且从头就让 #btn-grab 闪：玩家离座位十万八千里就去按，
  // 只会得到"抓空"，第一次尝试就学到了错误结论 —— 座位系统对我不开放。
  {
    id: 'seat-find',
    // 不说"左边"：越肩镜头跟着人转，面朝车头时座位在右手边。看不见时屏幕边有绿箭头指路。
    text: '绿色光柱就是空座，走过去 · 看不见就跟着绿箭头',
    // 得真有空座才说"走过去"；满座时这条会把人引向一个不存在的目标。
    when: (s) => riding(s) && s.playerSeat === null && s.seatGuide !== null,
    done: (s) => s.interactHint === 'sit' || s.playerSeat !== null,
    skip: (s) => s.playerSeat !== null,
    timeout: 8,
    waitLimit: 6
  },
  {
    id: 'seat-sit',
    text: '按【坐下】占座 · 坐着每一秒都在得分',
    pulse: '#btn-grab',
    // 只有真的能坐时才闪按钮，这样"闪 = 按了一定有用"永远成立。
    when: (s) => s.interactHint === 'sit',
    done: (s) => s.playerSeat !== null,
    skip: (s) => s.playerSeat !== null,
    timeout: 6,
    // 走不到座位就 4 秒后跳过。等太久会在中间留出一段没有任何引导的空窗。
    waitLimit: 4
  },
  {
    id: 'zone',
    text: '没抢到座就去黄圈里站着 · 人越多分越少',
    when: (s) => s.phase === 'driving' && s.playerSeat === null,
    done: (s) => s.playerInZone,
    // 坐着的人不需要这条；以前它会一直等到玩家站起来。
    skip: (s) => s.playerSeat !== null,
    timeout: 6,
    waitLimit: 5
  },
  {
    id: 'push',
    text: '按 💥 推人有分：往门口推、连推三下把坐着的人拽起来',
    pulse: '#btn-push',
    when: (s) => s.phase === 'driving' && s.playerSeat === null,
    done: (_s, ev) => has(ev, 'push'),
    timeout: 6,
    waitLimit: 8
  }
];

/** 插队步骤：各自最多出一次。 */
const URGENT: Step[] = [
  {
    id: 'door',
    // 这一条最关键：玩家目前根本不知道自己为什么会死。
    text: '门开了！别站在门口 · 被挤出车门就淘汰',
    // 电平触发：只要行驶中有门开着就出，不再依赖"到站那一帧"的事件。
    when: (s) => s.phase === 'driving' && s.doorsOpen,
    done: (s) => !s.doorsOpen,
    timeout: 4,
    waitLimit: Infinity
  },
  {
    id: 'grab',
    text: '终点摇摆！走到扶手旁按一下【抓住】· 受力 -70%',
    pulse: '#btn-grab',
    when: (s) => s.phase === 'finale',
    done: (s) => s.playerRail !== null,
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

  constructor(private root: HTMLElement) {
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

    // 人不在场（返场途中/已出局）就先收起气泡，别对着观战画面讲操作。
    if (!s.playerAlive) {
      this.hideBubble();
      if (this.urgent) this.finishUrgent();
      this.shownAt = -1;
      this.pendingSince = t;
      return;
    }

    // 1) 插队步骤优先。
    if (this.urgent) {
      if (this.urgent.done(s, ev) || t - this.urgentAt > this.urgent.timeout) {
        this.finishUrgent();
        // 插队期间不计顺序步骤的等待时间。
        this.pendingSince = t;
      }
      return;
    }
    const hot = URGENT.find((u) => !this.urgentDone.has(u.id) && u.when(s, ev));
    if (hot) {
      this.urgent = hot;
      this.urgentAt = t;
      // 被打断的顺序步骤：已经讲了一半以上就算讲过，否则等插队讲完再完整出一次。
      const cur = SEQUENCE[this.idx];
      if (cur && this.shownAt >= 0 && t - this.shownAt > cur.timeout / 2) this.idx++;
      this.shownAt = -1;
      this.pendingSince = t;
      this.render(hot);
      return;
    }

    // 2) 顺序步骤。
    const step = SEQUENCE[this.idx];
    if (!step) {
      if (this.urgentDone.size >= URGENT.length) this.stop();
      return;
    }
    if (this.pendingSince < 0) this.pendingSince = t;
    if (step.skip?.(s)) return this.next(t);
    if (this.shownAt < 0) {
      if (!step.when(s, ev)) {
        // 玩家自己先做到了就直接跳过，不要为了"讲完"而干等。
        if (step.done(s, ev)) return this.next(t);
        // 等不到触发条件也要跳过，别把后面的步骤一起卡死。
        if (t - this.pendingSince > step.waitLimit) this.next(t);
        return;
      }
      this.shownAt = t;
      this.render(step);
      return;
    }
    if (step.done(s, ev) || t - this.shownAt > step.timeout) this.next(t);
  }

  private render(step: Step) {
    this.bubble.textContent = step.text;
    this.bubble.classList.add('show');
    this.clearPulse();
    if (step.pulse) {
      const el = this.root.querySelector(step.pulse) as HTMLElement | null;
      if (el) {
        el.classList.add('tut-pulse');
        this.pulsing = el;
      }
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
