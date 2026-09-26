/** 8 名首发角色与主动技能（对应 docs/03-content-and-levels.md 第 3 节）。 */
export interface CharacterDef {
  id: string;
  name: string;
  color: string;
  skillName: string;
  skillDesc: string;
  /** 主动技能冷却（秒）。 */
  skillCooldown: number;
  /** 主动技能持续时间（秒）；0 表示瞬时。 */
  skillDuration: number;
}

export const CHARACTERS: CharacterDef[] = [
  { id: 'xiaoli', name: '打工人小李', color: '#3b82f6', skillName: '公文包锚定', skillDesc: '2秒内击退-70%、移速-50%', skillCooldown: 12, skillDuration: 2 },
  { id: 'xiaoxia', name: '学生小夏', color: '#22c1a6', skillName: '迟到冲刺', skillDesc: '向面朝方向冲刺3.5格', skillCooldown: 10, skillDuration: 0.32 },
  { id: 'aqiang', name: '健身哥阿强', color: '#f59e0b', skillName: '扎稳马步', skillDesc: '1.5秒免疫一次推挤', skillCooldown: 11, skillDuration: 1.5 },
  { id: 'lanjie', name: '买菜阿姨兰姐', color: '#ef4444', skillName: '菜篮路障', skillDesc: '放置4秒软障碍(减速30%)', skillCooldown: 14, skillDuration: 4 },
  { id: 'ayuan', name: '旅行者阿远', color: '#8b5cf6', skillName: '行李横放', skillDesc: '推出滑行3格的行李箱', skillCooldown: 13, skillDuration: 0.7 },
  { id: 'xiaomai', name: '主播小麦', color: '#ec4899', skillName: '大家看这里', skillDesc: '0.8秒预告后环形推力', skillCooldown: 15, skillDuration: 0.8 },
  { id: 'amo', name: '社恐阿默', color: '#64748b', skillName: '缩进角落', skillDesc: '2秒碰撞半径-20%', skillCooldown: 12, skillDuration: 2 },
  { id: 'laozhou', name: '睡神老周', color: '#84cc16', skillName: '原地打盹', skillDesc: '2.5秒环境击退-60%', skillCooldown: 14, skillDuration: 2.5 }
];

export const characterById = (id: string): CharacterDef =>
  CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
