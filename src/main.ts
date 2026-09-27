import { Game } from './game/session';
import { setupLobby, showLobby, setupSoundToggles, setStartReady } from './ui/screens';
import { initOrientation } from './core/orientation';
import { unlockAudio } from './core/audio';
import { loadModels } from './view/models';


initOrientation();
// 存档里的音效开关必须在第一声响之前生效（大厅和暂停页的开关也在这里绑定）。
setupSoundToggles();

// iOS / 微信要求音频上下文由用户手势解锁。
// 监听常驻、不移除：来电、切后台之后音频会被系统挂起，要在下一次触摸（比如点"继续"）时再唤醒。
// 已经在播放时 unlockAudio 什么都不做，每次触摸都调用没有开销。
const wake = () => unlockAudio();
window.addEventListener('pointerdown', wake, { capture: true, passive: true });
window.addEventListener('touchstart', wake, { capture: true, passive: true });
// 从后台切回来先试一次：安卓上不需要手势就能恢复；iOS 会被拒绝，等下一次触摸。
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) unlockAudio();
});

/**
 * 大厅不等模型：JS 一到就显示。
 *
 * 车模和街景（public/models/*.glb，合计约 750KB）只有开局才用得到。以前在加载页等它们，
 * 1.6Mbps 弱网下要 6 秒多才进得了大厅，而且立绘要等大厅建好才开始下载，卡片还要再空一两秒。
 * 现在大厅（连同立绘）和模型并行下载，"开始上车"在模型到位前显示进度、不能点。
 * Game 构造时同步取用模型，所以放到加载完成之后再建。
 * 模型加载失败也会放行：进游戏后控制台报错，车/街景缺失但不会卡死在大厅。
 */
let game: Game | null = null;
setupLobby((charId) => game?.start(charId));
setStartReady(false, 0);
showLobby();
document.getElementById('loading')!.classList.add('hidden');

loadModels((v) => setStartReady(false, v)).then(() => {
  game = new Game(document.getElementById('app')!);
  setStartReady(true);
});
