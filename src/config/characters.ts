/**
 * 8 名角色（docs/08-派对玩法重构.md 第 3.6 节）：能力完全一样，只是外观。
 * 以后解锁的是帽子、衣服这类装扮，不再是角色或技能。
 */
export interface CharacterDef {
  id: string;
  name: string;
  color: string;
}

export const CHARACTERS: CharacterDef[] = [
  { id: 'xiaoli', name: '打工人小李', color: '#3b82f6' },
  { id: 'xiaoxia', name: '学生小夏', color: '#22c1a6' },
  { id: 'aqiang', name: '健身哥阿强', color: '#f59e0b' },
  { id: 'lanjie', name: '买菜阿姨兰姐', color: '#ef4444' },
  { id: 'ayuan', name: '旅行者阿远', color: '#8b5cf6' },
  { id: 'xiaomai', name: '主播小麦', color: '#ec4899' },
  { id: 'amo', name: '社恐阿默', color: '#64748b' },
  { id: 'laozhou', name: '睡神老周', color: '#84cc16' }
];

export const characterById = (id: string): CharacterDef =>
  CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
