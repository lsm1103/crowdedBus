import { CHARACTERS } from '../config/characters';
import { rolePortrait } from '../core/assets';
import { getProfile, getSoundEnabled, setSoundEnabled } from '../core/storage';
import { isAudioEnabled, setAudioEnabled, unlockAudio, SFX } from '../core/audio';
import { nameGlyph } from './hud';

/** 整场结算的一行（按整场名次排好序传进来）。 */
export interface ResultRow {
  /** 整场名次，1 = 冠军。 */
  rank: number;
  name: string;
  color: string;
  isPlayer: boolean;
  /** 整场赢了几回合。 */
  wins: number;
  /** 整场把几个人扔 / 挤下车（各回合 CharacterState.throwOuts 之和）。 */
  throwOuts: number;
  /** 拿下整场的人。缺省时按 rank === 1 认。 */
  champion?: boolean;
}

/** 结算页的附加信息（可省略）。 */
export interface ResultMeta {
  /** 这一场打了几回合。 */
  rounds: number;
  /** 先赢几回合拿下整场。 */
  winsNeeded: number;
}

/** 回合间歇浮层的数据。 */
export interface IntermissionData {
  /** 刚结束的是第几回合。 */
  round: number;
  /** 本回合赢家：只剩 1 人时是他；到终点时是所有还在车上的人。 */
  winners: { name: string; color: string; isPlayer: boolean }[];
  /** 当前胜场表（已计入本回合）。 */
  table: { name: string; color: string; wins: number; isPlayer: boolean }[];
  winsNeeded: number;
}

/** 大厅状态：选中的角色跨"回大厅"保留，开始回调由 setupLobby 注册一次。 */
let selected = CHARACTERS[0].id;
let selectionRestored = false;
let lobbyOnStart: ((charId: string) => void) | null = null;

/** 名字转义：名字最终会进 innerHTML。 */
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** 带名字首字的彩色小圆（和 HUD 顶栏同一套样式）。 */
const dotHtml = (name: string, color: string, isPlayer: boolean): string =>
  `<i class="rp-dot${isPlayer ? ' me' : ''}" style="--c:${esc(color)}">${esc(nameGlyph(name, isPlayer))}</i>`;

/**
 * "开始上车"是否可点。
 * 大厅在 JS 到位后立刻显示，车模和街景在后台加载；加载完之前按钮显示进度、点了也没反应。
 * progress：0~1。
 */
export function setStartReady(ready: boolean, progress = 0): void {
  const start = document.getElementById('btn-start') as HTMLButtonElement | null;
  if (!start) return;
  start.disabled = !ready;
  start.textContent = ready ? '开始上车' : `正在备车 ${Math.round(progress * 100)}%`;
}

/** 初始化大厅选角；点击开始触发 onStart。 */
export function setupLobby(onStart: (charId: string) => void): void {
  lobbyOnStart = onStart;
  const start = document.getElementById('btn-start')!;
  start.onclick = () => lobbyOnStart?.(selected);
  renderRoster();
}

/**
 * 重建选角卡。8 个角色能力完全一样、全部可选（docs/08 第 3.6 节），卡片上只有立绘和名字。
 * 第一次进大厅时默认选中存档里上次用的角色。
 */
function renderRoster() {
  const roster = document.getElementById('roster')!;
  roster.innerHTML = '';
  if (!selectionRestored) {
    selectionRestored = true;
    const last = getProfile().lastCharId;
    if (last && CHARACTERS.some((c) => c.id === last)) selected = last;
  }
  for (const c of CHARACTERS) {
    const card = document.createElement('div');
    card.className = 'char-card';
    card.innerHTML = `
      <div class="portrait" style="--portrait:url('${rolePortrait(c.id)}'); --accent:${c.color}"></div>
      <div class="char-copy"><div class="name">${esc(c.name)}</div></div>
      <div class="selected-mark">✓</div>
    `;
    card.addEventListener('click', () => {
      selected = c.id;
      roster.querySelectorAll('.char-card').forEach((el) => el.classList.remove('selected'));
      card.classList.add('selected');
    });
    if (c.id === selected) card.classList.add('selected');
    roster.appendChild(card);
  }
}

export function showLobby() {
  hideIntermission();
  renderRoster();
  document.getElementById('lobby')!.classList.remove('hidden');
  document.getElementById('result')!.classList.add('hidden');
}

export function hideLobby() {
  document.getElementById('lobby')!.classList.add('hidden');
}

/**
 * 回合间歇浮层：第 N 回合 · 谁赢了 + 当前胜场表。
 * 没有按钮，显示多久由 session 控制（约 3 秒）后调 hideIntermission()。
 * 不拦触摸，底下的画面照常能看。
 */
export function showIntermission(data: IntermissionData): void {
  const need = Math.max(1, data.winsNeeded);
  document.getElementById('im-round')!.textContent = `第 ${data.round} 回合`;

  const head = document.getElementById('im-head')!;
  const list = document.getElementById('im-winners')!;
  const ws = data.winners;
  const meWon = ws.some((w) => w.isPlayer);
  list.innerHTML = '';
  if (ws.length === 0) {
    head.textContent = '这一回合没人留下';
  } else if (ws.length === 1) {
    const w = ws[0];
    head.innerHTML = w.isPlayer
      ? '<span class="me">你</span> 赢了这一回合！'
      : `<span style="color:${esc(w.color)}">${esc(w.name)}</span> 赢了`;
  } else {
    // 多人一起撑到终点都算赢：大字只报人数，下面列出是谁。
    head.innerHTML = `${ws.length} 人撑到终点 · ${meWon ? '<span class="me">你也赢了</span>' : '都算赢'}`;
    list.innerHTML = ws.map((w) =>
      `<span class="im-w">${dotHtml(w.name, w.color, w.isPlayer)}${esc(w.isPlayer ? '你' : w.name)}</span>`
    ).join('');
  }

  // 胜场表：按胜场从多到少，同分保持传入顺序；本回合赢家新拿到的那一分弹一下。
  const winnerKeys = new Set(ws.map((w) => `${w.isPlayer ? 1 : 0}:${w.name}`));
  const rows = data.table
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.wins - a.r.wins || a.i - b.i)
    .map(({ r }) => r);
  const table = document.getElementById('im-table')!;
  table.innerHTML = rows.map((r) => {
    const justWon = winnerKeys.has(`${r.isPlayer ? 1 : 0}:${r.name}`);
    let pips = '';
    for (let i = 0; i < need; i++) {
      const on = i < r.wins;
      const pop = on && justWon && i === r.wins - 1;
      pips += `<i class="${on ? 'on' : ''}${pop ? ' new' : ''}"></i>`;
    }
    // 赛点：再赢一回合就拿下整场。给间歇一点紧张感。
    const tag = r.wins >= need ? '<span class="im-tag">🏆</span>'
      : r.wins === need - 1 && need > 1 ? '<span class="im-tag">赛点</span>' : '';
    return `<div class="im-cell${r.isPlayer ? ' me' : ''}">${dotHtml(r.name, r.color, r.isPlayer)}` +
      `<div class="im-info"><span class="im-name">${esc(r.name)}</span><b class="rp-wins">${pips}</b></div>${tag}</div>`;
  }).join('');
  document.getElementById('im-foot')!.textContent = `先赢 ${need} 回合拿下整场`;

  // 上一回合最后一条横幅、飘字、教学气泡还挂在 HUD 上，会从卡片边上露出来：间歇期间先收起。
  document.getElementById('hud')?.classList.add('inter');
  const ov = document.getElementById('intermission')!;
  // 重新触发弹入和"新得分"动画：先摘掉 show，强制一次重排再加回来。
  ov.classList.remove('show');
  void ov.offsetWidth;
  ov.classList.add('show');
}

export function hideIntermission(): void {
  document.getElementById('intermission')?.classList.remove('show');
  document.getElementById('hud')?.classList.remove('inter');
}

/**
 * 战绩图浮层。
 * 挂在 #stage 外面（index.html 里是 body 的直接子元素）：强制横屏时 stage 被
 * rotate(90deg)，放进去玩家看到的会是转了 90° 的图。放外面正好是竖屏观感 ——
 * 而此时玩家本来就要把手机转回竖屏去发微信，交互是自洽的。
 */
function showShareCard(dataUrl: string) {
  const ov = document.getElementById('share-overlay')!;
  const img = document.getElementById('share-img') as HTMLImageElement;
  img.src = dataUrl;
  ov.classList.add('show');
  (document.getElementById('share-close') as HTMLElement).onclick =
    () => ov.classList.remove('show');
}

/**
 * 把某一行滚到列表中部（到顶/到底就贴边），保证整行可见。
 *
 * 不用 row.scrollIntoView()：它会连带滚动所有可滚动的祖先，包括 overflow:hidden 的
 * #stage，强制横屏时整个舞台会被推歪。offsetTop/offsetHeight 是布局坐标，
 * 不受 rotate(90deg) 影响；#result-list 设了 position:relative，是行的 offsetParent。
 */
function scrollRowIntoView(list: HTMLElement, row: HTMLElement) {
  const max = list.scrollHeight - list.clientHeight;
  if (max <= 0) return;
  const target = row.offsetTop - (list.clientHeight - row.offsetHeight) / 2;
  list.scrollTop = Math.max(0, Math.min(max, target));
}

/**
 * 整场结算。
 * rows 按整场名次排好序；标题直接写冠军是谁，冠军那一行描金。
 * records：本场刷新的个人纪录（applyMatchResult 的返回值），为空就不显示提示条。
 * makeCard：点"生成战绩图"时调用，返回图片 dataURL。
 */
export function showResult(
  rows: ResultRow[], records: string[], onAgain: () => void,
  makeCard: () => Promise<string>,
  meta?: ResultMeta
) {
  hideIntermission();
  const result = document.getElementById('result')!;
  const list = document.getElementById('result-list')!;
  result.classList.remove('hidden');
  list.innerHTML = '';

  const champ = rows.find((r) => r.champion) ?? rows.find((r) => r.rank === 1) ?? rows[0];
  const title = document.getElementById('result-title')!;
  if (!champ) title.innerHTML = '🏆 <span class="accent">结算</span>';
  else if (champ.isPlayer) title.innerHTML = '🏆 <span style="color:#FFD23F">你</span> 拿下了整场！';
  else title.innerHTML = `🏆 <span style="color:${esc(champ.color)}">${esc(champ.name)}</span> 拿下整场`;
  const sub = document.getElementById('result-sub')!;
  const me = rows.find((r) => r.isPlayer);
  const parts: string[] = [];
  if (meta) parts.push(`打了 ${meta.rounds} 回合 · 先赢 ${meta.winsNeeded} 回合的人拿下整场`);
  if (me && champ && !champ.isPlayer) parts.push(`你排第 ${me.rank}`);
  sub.textContent = parts.join(' · ');
  sub.classList.toggle('hidden', parts.length === 0);

  // 个人最佳是最便宜的留存钩子：一条数据就能让玩家有"再来一局"的理由。
  const rec = document.getElementById('result-records')!;
  rec.textContent = records.length ? '🎉 新纪录：' + records.join(' · ') : '';
  rec.classList.toggle('show', records.length > 0);

  for (const r of rows) {
    const row = document.createElement('div');
    const isChamp = r === champ;
    row.className = 'result-row' + (r.isPlayer ? ' me' : '') + (isChamp ? ' champ' : '');
    // 玩家在名单里的名字本身就是"你"，不要再补一个"（你）"。
    const who = r.isPlayer && r.name !== '你' ? `${r.name}（你）` : r.name;
    row.innerHTML =
      `<span class="rk">${isChamp ? '🏆' : r.rank}</span>` +
      dotHtml(r.name, r.color, r.isPlayer) +
      `<span class="who">${esc(who)}</span>` +
      `<span class="note"><b>赢 ${r.wins} 回合</b> · 扔下 ${r.throwOuts} 人</span>`;
    list.appendChild(row);
  }
  // 名单比列表高时（矮屏），排在后面的玩家那一行会被切在底边，玩家最关心的恰恰是自己。
  const meRow = list.querySelector<HTMLElement>('.result-row.me');
  list.scrollTop = 0;
  if (meRow) scrollRowIntoView(list, meRow);

  const again = document.getElementById('btn-again')!;
  again.onclick = () => {
    result.classList.add('hidden');
    onAgain();
  };
  document.getElementById('btn-lobby')!.onclick = () => showLobby();
  const share = document.getElementById('btn-share')!;
  let busy = false;
  share.onclick = async () => {
    if (busy) return;
    busy = true;
    share.textContent = '生成中…';
    try {
      showShareCard(await makeCard());
    } finally {
      busy = false;
      share.textContent = '生成战绩图';
    }
  };
}

/**
 * 音效开关：大厅角落一个（只有图标），暂停页一个（图标 + 文字），
 * 两处都是 index.html 里带 data-sound-toggle 的元素，状态互相同步并写进存档。
 * 启动时调用一次：存档里的开关要在第一声响之前生效。
 */
export function setupSoundToggles(): void {
  const btns = Array.from(document.querySelectorAll<HTMLElement>('[data-sound-toggle]'));
  const render = () => {
    const on = isAudioEnabled();
    for (const b of btns) {
      const icon = on ? '🔊' : '🔇';
      b.textContent = b.dataset.soundToggle === 'label' ? `${icon} 音效：${on ? '开' : '关'}` : icon;
      b.setAttribute('aria-pressed', String(on));
      b.setAttribute('aria-label', on ? '关闭音效' : '打开音效');
      b.title = on ? '关闭音效' : '打开音效';
    }
  };
  setAudioEnabled(getSoundEnabled());
  render();
  for (const b of btns) {
    b.addEventListener('click', () => {
      const on = !isAudioEnabled();
      setAudioEnabled(on);
      setSoundEnabled(on);
      render();
      // 打开时响一声，玩家立刻知道声音回来了（点击本身就是解锁音频所需的手势）。
      if (on) {
        unlockAudio();
        SFX.grab();
      }
    });
  }
}
