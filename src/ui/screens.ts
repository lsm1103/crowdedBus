import { CHARACTERS } from '../config/characters';
import { rolePortrait } from '../core/assets';
import { getProfile, getSoundEnabled, setSoundEnabled } from '../core/storage';
import { isUnlocked, unlockRule } from '../config/unlocks';
import { isAudioEnabled, setAudioEnabled, unlockAudio, SFX } from '../core/audio';

export interface ResultRow {
  rank: number;
  name: string;
  isPlayer: boolean;
  note: string;
  score: number;
}

/** 大厅状态：选中的角色跨"回大厅"保留，开始回调由 setupLobby 注册一次。 */
let selected = CHARACTERS[0].id;
let lobbyOnStart: ((charId: string) => void) | null = null;

/** 初始化大厅选角；点击开始触发 onStart。 */
export function setupLobby(onStart: (charId: string) => void): void {
  lobbyOnStart = onStart;
  const start = document.getElementById('btn-start')!;
  start.onclick = () => lobbyOnStart?.(selected);
  renderRoster();
}

/**
 * 按当前存档重建选角卡。
 *
 * 必须每次回大厅都重建：以前只在启动时建一次，局后新解锁的角色一直显示🔒、
 * 进度一直停在"0/5 人"，要刷新页面才生效 —— 解锁这个留存钩子在一次会话里等于没有。
 */
function renderRoster() {
  const roster = document.getElementById('roster')!;
  const detail = document.getElementById('skill-detail')!;
  roster.innerHTML = '';

  // 卡片放不下完整技能描述，单独用一条详情栏顶上：
  // 以前玩家从头到尾都不知道自己选的角色技能是干什么的。
  const showDetail = (id: string) => {
    const c = CHARACTERS.find((x) => x.id === id)!;
    detail.innerHTML =
      `<span class="sd-name" style="color:${c.color}">${c.skillName}</span>` +
      `<span class="sd-desc">${c.skillDesc}</span>` +
      `<span class="sd-cd">冷却 ${c.skillCooldown}s</span>`;
  };

  const profile = getProfile();
  // 首发只开 3 个：8 个陌生角色 + 8 个陌生技能是典型的选择瘫痪，少即是多。
  if (!isUnlocked(selected, profile)) {
    const firstUnlocked = CHARACTERS.find((c) => isUnlocked(c.id, profile));
    if (firstUnlocked) selected = firstUnlocked.id;
  }

  for (const c of CHARACTERS) {
    const unlocked = isUnlocked(c.id, profile);
    const card = document.createElement('div');
    card.className = 'char-card';
    card.innerHTML = `
      <div class="portrait" style="--portrait:url('${rolePortrait(c.id)}'); --accent:${c.color}"></div>
      <div class="char-copy"><div class="name">${c.name}</div><div class="skill">${c.skillName}</div></div>
      <div class="selected-mark">✓</div>
    `;
    if (!unlocked) {
      // 锁定卡把角色名收进遮罩里自己排版，底下那行名字/技能隐藏：
      // 以前半透明遮罩下两层文字叠在一起，谁也看不清。
      const rule = unlockRule(c.id);
      card.classList.add('locked');
      card.innerHTML += `<div class="lock">` +
        `<b class="lock-name">🔒 ${c.name}</b>` +
        `<span class="lock-desc">${rule ? rule.desc : ''}</span>` +
        `<span class="lock-progress">${rule ? rule.progress(profile) : ''}</span>` +
        `</div>`;
    }
    card.addEventListener('click', () => {
      if (!unlocked) return;
      selected = c.id;
      roster.querySelectorAll('.char-card').forEach((el) => el.classList.remove('selected'));
      card.classList.add('selected');
      showDetail(c.id);
    });
    if (c.id === selected) card.classList.add('selected');
    roster.appendChild(card);
  }
  showDetail(selected);
}

export function showLobby() {
  renderRoster();
  document.getElementById('lobby')!.classList.remove('hidden');
  document.getElementById('result')!.classList.add('hidden');
}

export function hideLobby() {
  document.getElementById('lobby')!.classList.add('hidden');
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
 * 把某一行滚到列表中部（到顶/到底就贴边），保证整行可见，上下还能看到邻近名次。
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

export function showResult(
  rows: ResultRow[], records: string[], onAgain: () => void,
  makeCard: () => Promise<string>,
  /** 本局新解锁的角色名。 */
  newlyUnlocked: string[] = []
) {
  const result = document.getElementById('result')!;
  const list = document.getElementById('result-list')!;
  result.classList.remove('hidden');
  list.innerHTML = '';
  // 个人最佳是最便宜的留存钩子：一条数据就能让玩家有"再来一局"的理由。
  const rec = document.getElementById('result-records')!;
  rec.textContent = records.length ? '🎉 新纪录：' + records.join(' · ') : '';
  rec.classList.toggle('show', records.length > 0);
  // 新解锁必须在结算里说出来，不然玩家不会回大厅去看。
  const unl = document.getElementById('result-unlock')!;
  unl.textContent = newlyUnlocked.length ? '🔓 解锁新角色：' + newlyUnlocked.join('、') + ' · 点【换角色】试试' : '';
  unl.classList.toggle('show', newlyUnlocked.length > 0);
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'result-row' + (r.isPlayer ? ' me' : '');
    // 玩家在名单里的名字本身就是"你"，不要再补一个"（你）"。
    const who = r.isPlayer && r.name !== '你' ? `${r.name}（你）` : r.name;
    // 分数必须显示分项，不然改了名次规则也没人看得懂为什么是这个名次。
    row.innerHTML = `
      <span class="who">${r.rank}. ${who}</span>
      <span class="note"><b style="color:#FFD23F">${r.score}分</b> · ${r.note}</span>
    `;
    list.appendChild(row);
  }
  // 名单比列表高时（667×375 这类矮屏），排在后面的玩家那一行会被切在底边，
  // 玩家最关心的恰恰是自己。
  const meRow = list.querySelector<HTMLElement>('.result-row.me');
  if (meRow) scrollRowIntoView(list, meRow);
  const again = document.getElementById('btn-again')!;
  again.onclick = () => {
    result.classList.add('hidden');
    onAgain();
  };
  // 以前结算页只有"再挤一局"，打完第一局就再也换不了角色（只能对局中暂停退出）。
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
