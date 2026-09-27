/**
 * 场景机关（docs/08 第 3.4 节）：两站之间随机出现 1~2 个，预警后生效，车门此时是关着的。
 * 它们本身不把人甩下车，作用是把没抓稳的人晃倒 —— 下一站一开门，躺在地上的人就是猎物。
 */
export type EventKind = 'brake' | 'turn' | 'bump';

export interface EventDef {
  kind: EventKind;
  label: string;
  warnText: string;
  /** 生效时长（秒）。急转弯的实际时长由 BALANCE.turnDuration 决定。 */
  duration: number;
}

export const EVENTS: Record<EventKind, EventDef> = {
  // 急刹：车速从满速猛降到 BALANCE.brakeHazardFloor 再恢复，全车往车头冲。
  brake: { kind: 'brake', label: '急刹车', warnText: '前方急刹，抓稳扶手！', duration: 1.0 },
  // 急转弯：横向甩一下，方向写进横幅。
  turn: { kind: 'turn', label: '急转弯', warnText: '前方急转弯，抓稳！', duration: 1.2 },
  // 颠簸：全车一起踉跄两下。
  bump: { kind: 'bump', label: '颠簸', warnText: '前方路面颠簸！', duration: 0.6 }
};

/**
 * 到站类型的文案。键与 domain/types.ts 的 StationKind 一致
 * （这里不从 domain 引类型，免得 config 反向依赖 domain）。
 */
export const STATION_TEXT = {
  board: { label: '上客', banner: '到站 · 上客潮！路人要挤上来了' },
  alight: { label: '下客', banner: '到站 · 下客潮！别挡在门口' },
  normal: { label: '停靠', banner: '到站 · 车门打开，离门口远点！' }
} as const;

/** 途经站名（每回合随机挑 4 个）与终点站名。 */
export const STATION_NAMES = [
  '梧桐路', '人民广场', '菜市场', '科技园', '体育中心', '老街口', '图书馆', '滨江公园'
] as const;
export const TERMINAL_NAME = '火车站';
