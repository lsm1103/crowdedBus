import type { Profile } from '../core/storage';

/**
 * 角色解锁。
 *
 * 第一阶段 8 个角色全部开放（docs/08 第 3.6 节）：角色能力完全一样、只是外观，
 * 按成绩解锁角色这条已经砍掉。以后解锁的是帽子、衣服这类装扮，到时再在这里加规则。
 *
 * 保留这个函数是为了让调用方不用关心"现在有没有解锁"这件事。
 */
export function isUnlocked(_id: string, _p?: Profile): boolean {
  return true;
}
