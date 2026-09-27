// 无头冒烟测试：用 Match 跑一整场（先赢 3 回合，至少 3 回合），验证规则层能跑完且不出错。
import { Match } from '../src/domain/match';
import type { Simulation } from '../src/domain/simulation';
import { CHARACTERS } from '../src/config/characters';
import { V2, v2Norm } from '../src/core/math';
import { BALANCE } from '../src/config/balance';
import type { Button } from '../src/core/input';
import type { GameEvent } from '../src/domain/types';

/** 项目没装 @types/node：脚本只用到 process 的这两样，自己声明一下。 */
declare const process: { env: Record<string, string | undefined>; exit(code: number): never };

function fail(msg: string): never {
  console.error('SMOKE FAIL: ' + msg);
  process.exit(1);
}

const roster = CHARACTERS.map((d, i) => ({ defId: d.id, name: i === 0 ? '你' : d.name, color: d.color, isPlayer: i === 0 }));
const match = new Match(roster, 3);
const dt = 1 / BALANCE.tickRate;
const seen = new Set<GameEvent['type']>();
let rounds = 0;

function playRound(sim: Simulation, round: number) {
  if (sim.characters.length !== 8) fail('人数应为 8，实际 ' + sim.characters.length);
  const maxSteps = Math.ceil(140 / dt);
  let roundEnd = 0;
  for (let i = 0; i < maxSteps; i++) {
    // 玩家：随机走动 + 各种按键（抓按住一阵、松开一阵）。
    const angle = Math.sin(i * 0.013 + round) * 3;
    const move = v2Norm(V2(Math.sin(angle), Math.cos(angle)));
    const pressed = new Set<Button>();
    const held = new Set<Button>();
    if (i % 90 === 0) pressed.add('dash');
    if (i % 50 === 0) pressed.add('push');
    if (i % 120 === 10) pressed.add('grab');
    if (i % 120 >= 10 && i % 120 < 80) held.add('grab');
    sim.applyPlayerInput({ move, pressed, held });
    const evs = sim.tick(dt);
    for (const e of evs) {
      seen.add(e.type);
      if (e.type === 'roundEnd') roundEnd++;
    }
    for (const c of sim.characters) {
      if (!Number.isFinite(c.pos.x) || !Number.isFinite(c.pos.z)) fail(`位置出现 NaN，round=${round} step=${i} char=${c.id}`);
      if (c.balance < -1e-9 || c.balance > 1 + 1e-9) fail(`平衡值越界 ${c.balance}`);
      if (c.alive && c.status === 'eliminated') fail('活着的人状态是 eliminated');
      if (!c.alive && c.status !== 'eliminated') fail('出局的人状态不是 eliminated');
      if (c.heldBy !== null) {
        const h = sim.characters[c.heldBy];
        if (!h.hold || h.hold.kind !== 'char' || h.hold.id !== c.id) fail(`抓握关系不一致 ${h.id}→${c.id}`);
      }
    }
    for (const n of sim.npcs) {
      if (!Number.isFinite(n.pos.x) || !Number.isFinite(n.pos.z)) fail('路人位置出现 NaN');
    }
    if (sim.npcs.length > 8) fail('路人超过 8 个');
    const snap = sim.snapshot();
    if (snap.seats.length !== 6) fail('座位应为 6 个');
    if (sim.phase === 'ended') break;
  }
  if (sim.phase !== 'ended') fail('回合未在预期内结束，phase=' + sim.phase);
  if (roundEnd !== 1) fail('roundEnd 事件应恰好 1 次，实际 ' + roundEnd);
  const r = sim.roundResult();
  if (!r) fail('回合结束但 roundResult() 为 null');
  if (r.winners.length === 0) fail('没有赢家');
  return r;
}

while (match.champion === null && rounds < 20) {
  const sim = match.newRound(1000 + rounds * 7919);
  const r = playRound(sim, rounds);
  match.recordRound(sim);
  rounds++;
  const names = r.winners.map((id) => roster[id].name).join('、');
  console.log(`第 ${match.round} 回合：${sim.time.toFixed(1)} 秒，淘汰 ${r.eliminated.length} 人，赢家 ${names}` +
    `，胜场 [${match.wins.join(' ')}]，路人 ${sim.npcs.length}`);
}

if (rounds < 3) fail('整场应至少 3 回合，实际 ' + rounds);
if (match.champion === null) fail('20 回合内没有决出整场冠军');
if (match.wins[match.champion] < 3) fail('冠军胜场不足 3');
for (const t of ['push', 'grab', 'knockdown', 'eliminate', 'station', 'eventStart', 'roundEnd', 'npcBoard'] as const) {
  if (!seen.has(t)) fail('整场没有出现事件 ' + t);
}

console.log('SMOKE OK');
console.log(`回合数 ${rounds}，冠军 ${roster[match.champion].name}，事件类型 ${[...seen].sort().join(',')}`);
