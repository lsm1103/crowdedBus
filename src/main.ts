import { Game } from './game/session';
import { setupLobby, showLobby, setupSoundToggles } from './ui/screens';
import { initOrientation } from './core/orientation';
import { unlockAudio } from './core/audio';
import { loadModels } from './view/models';

/**
 * 首屏只预载两个模型（public/models/*.glb，合计约 750KB，meshopt 压缩）。
 *
 * 8 张立绘是大厅选角卡的 CSS background-image，浏览器本来就会自己去拿；
 * 车和街景是 Game 构造时同步取用的，必须在这里等它们到位。
 * 模型加载失败不会卡在加载页：进游戏后控制台报错，车/街景缺失但不白屏。
 */
function preload(onProgress: (v: number) => void): Promise<void> {
  return loadModels(onProgress);
}

initOrientation();
// 存档里的音效开关必须在第一声响之前生效（大厅和暂停页的开关也在这里绑定）。
setupSoundToggles();

// iOS / 微信要求音频上下文由用户手势解锁。
const unlockOnce = () => {
  unlockAudio();
  window.removeEventListener('pointerdown', unlockOnce);
  window.removeEventListener('touchstart', unlockOnce);
};
window.addEventListener('pointerdown', unlockOnce);
window.addEventListener('touchstart', unlockOnce);

const loading = document.getElementById('loading')!;
const loadingBar = document.getElementById('loading-bar')!;

preload((v) => {
  loadingBar.style.width = Math.round(v * 100) + '%';
}).then(() => {
  loadingBar.style.width = '100%';
  const app = document.getElementById('app')!;
  const game = new Game(app);
  setupLobby((charId) => game.start(charId));
  showLobby();
  loading.classList.add('hidden');
});
