/**
 * 8 个角色的对局外观。
 *
 * 存在的理由：大厅是精细渲染的 3D 卡通立绘，进对局后全变成只靠身体配色区分的
 * 胶囊人偶，玩家会有被骗的感觉。这份表把立绘里**隔几米一眼能认出**的那个特征
 * 提取出来，用程序化几何体做进对局模型。
 *
 * 每个角色只挑 1~2 个一级特征。特征越多 draw call 越多，而识别度的边际收益
 * 在第三个特征之后就很低了。
 */

export type AccessoryKind =
  | 'headband'    // 头带（阿强）
  | 'kerchief'    // 头巾 + 蝴蝶结（兰姐）
  | 'neckPillow'  // U 形颈枕（阿远）
  | 'backpack'    // 背包（阿远 / 小夏）
  | 'selfieStick' // 自拍杆 + 手机（小麦）
  | 'headphones'  // 颈挂耳机（阿默）
  | 'sleepMask'   // 推在额头的眼罩（老周）
  | 'necktie'     // 领带（小李）
  | 'briefcase'   // 手提公文包（小李）
  | 'groceryBag'; // 菜袋（兰姐）

export interface AppearanceSpec {
  /** 上衣主色（覆盖 characters.ts 里的 color，用于身体）。 */
  top: number;
  /** 裤子/下身。 */
  bottom: number;
  /** 头发。 */
  hair: number;
  /** 发型：影响头发那块几何体的缩放。 */
  hairStyle: 'spiky' | 'curly' | 'bob' | 'messy' | 'short';
  /** 配件的强调色。 */
  accent: number;
  accessories: AccessoryKind[];
}

export const APPEARANCE: Record<string, AppearanceSpec> = {
  xiaoli: {
    top: 0xf5f1e8, bottom: 0x3f4655, hair: 0x2a2f3a, hairStyle: 'short',
    accent: 0xd9483b, accessories: ['necktie', 'briefcase']
  },
  xiaoxia: {
    top: 0x3fb6c4, bottom: 0x2b3340, hair: 0x4a3324, hairStyle: 'messy',
    accent: 0xf2b33d, accessories: ['backpack', 'headphones']
  },
  aqiang: {
    top: 0x2c9e9e, bottom: 0x22262e, hair: 0x1f232b, hairStyle: 'spiky',
    accent: 0x36c9c9, accessories: ['headband']
  },
  lanjie: {
    top: 0xf5a9c0, bottom: 0x7b5ea7, hair: 0x5a3a2e, hairStyle: 'curly',
    accent: 0xf27bb0, accessories: ['kerchief', 'groceryBag']
  },
  ayuan: {
    top: 0xe8724a, bottom: 0xd6c3a5, hair: 0x3a2b22, hairStyle: 'short',
    accent: 0x4fc3c3, accessories: ['neckPillow', 'backpack']
  },
  xiaomai: {
    top: 0x4fcfcf, bottom: 0x2f3a48, hair: 0xa96bd8, hairStyle: 'bob',
    accent: 0xf58ba8, accessories: ['selfieStick']
  },
  amo: {
    top: 0x9fe3c4, bottom: 0x2e4468, hair: 0x232a36, hairStyle: 'messy',
    accent: 0x1b2029, accessories: ['headphones']
  },
  laozhou: {
    top: 0xf2d66b, bottom: 0x8f8b80, hair: 0x8e8e8e, hairStyle: 'short',
    accent: 0x8c6bd8, accessories: ['sleepMask']
  }
};

/** 发型对头发几何体的缩放（x, y, z）。 */
export const HAIR_SCALE: Record<AppearanceSpec['hairStyle'], [number, number, number]> = {
  spiky: [1.0, 0.78, 0.95],
  curly: [1.16, 0.86, 1.12],
  bob: [1.12, 0.9, 1.06],
  messy: [1.06, 0.7, 1.0],
  short: [1.0, 0.6, 0.95]
};
