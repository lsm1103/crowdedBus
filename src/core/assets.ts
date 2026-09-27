/**
 * 静态资源路径。
 *
 * vite.config.ts 里 `base: './'`，但代码里的图片路径原本全是写死的绝对路径
 * （/textures/... 、/roles/...）。部署到子目录（比如 https://x.com/bus/）时
 * JS 能加载、图片全部 404 —— 微信 H5 经常被塞在某个子路径下，这个必须统一。
 */
const BASE = import.meta.env.BASE_URL || '/';

/** 拼出可用的资源 URL；中文文件名必须编码，否则部分 CDN/网关会 404。 */
export function asset(path: string): string {
  const clean = path.replace(/^\/+/, '');
  const encoded = clean.split('/').map(encodeURIComponent).join('/');
  return BASE.replace(/\/+$/, '') + '/' + encoded;
}

/** 8 个角色的立绘文件名（不含扩展名）。 */
export const ROLE_PORTRAITS: Record<string, string> = {
  xiaoli: '打工人小李', xiaoxia: '学生小夏', aqiang: '健身哥阿强', lanjie: '买菜阿姨兰姐',
  ayuan: '旅行者阿远', ajia: '时尚姐阿娇', amo: '社恐阿默', laozhou: '睡神老周'
};

export const rolePortrait = (id: string): string => asset(`roles/${ROLE_PORTRAITS[id]}.jpg`);
