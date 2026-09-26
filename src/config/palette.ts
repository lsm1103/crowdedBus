/**
 * 代码里现场上色用的颜色。
 *
 * 车身、座椅、扶手、街景这些纯色件的颜色不在这里：它们是 Blender 模型里烘好的
 * 顶点色（scripts/blender/build_models.py 的 PALETTE，车身现在是红色 body_red），
 * 要改得改那边再 npm run model:build。这里只留 three.js 运行时自己上色的两样。
 *
 * coral / lemon 同时也是界面的强调色：index.html 里的 --c-coral / --c-lemon 与这里同值，
 * 改色要两边一起改。其余 CSS 颜色与这份表无关。
 */
export const PALETTE = {
  /** 车门打开时门板染的危险色 */
  coral: 0xff7a6b,
  /** 门口危险区关门时的底色 */
  lemon: 0xffd23f
} as const;
