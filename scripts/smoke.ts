// 无头冒烟测试：验证模拟器可跑完一整局且不抛异常。
import { Simulation } from '../src/domain/simulation';
import { CHARACTERS } from '../src/config/characters';
import { V2, v2Norm } from '../src/core/math';
import { BALANCE } from '../src/config/balance';

function shuffle<T>(a: T[]): T[] {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

const sim = new Simulation(12345);
const bots = shuffle(CHARACTERS.slice(1));
sim.setup([
  { defId: CHARACTERS[0].id, name: '你', color: CHARACTERS[0].color, isPlayer: true },
  ...bots.map((d) => ({ defId: d.id, name: d.name, color: d.color, isPlayer: false }))
]);

if (sim.characters.length !== 8) throw new Error('人数应为 8，实际 ' + sim.characters.length);

const dt = 1 / BALANCE.tickRate;
const totalSteps = Math.ceil(BALANCE.matchDuration / dt) + 60;
let steps = 0;

for (let i = 0; i < totalSteps; i++) {
  // 玩家随机走动 + 偶尔按键
  const angle = Math.sin(i * 0.13) * 3;
  const move = v2Norm(V2(Math.sin(angle), Math.cos(angle)));
  const buttons = new Set<'dash' | 'push' | 'interact' | 'skill' | 'emote'>();
  if (i % 90 === 0) buttons.add('dash');
  if (i % 70 === 0) buttons.add('push');
  if (i % 40 === 0) buttons.add('interact');
  if (i % 200 === 0) buttons.add('skill');
  sim.applyPlayerInput({ move, buttons });
  sim.tick(dt);
  steps++;

  for (const c of sim.characters) {
    if (!Number.isFinite(c.pos.x) || !Number.isFinite(c.pos.z)) {
      throw new Error('位置出现 NaN，step=' + i + ' char=' + c.id);
    }
  }
}

if (sim.phase !== 'ended') throw new Error('对局未在预期内结束，phase=' + sim.phase);
const ranking = sim.winnerRanking();
if (ranking.length !== 8) throw new Error('结算人数应为 8，实际 ' + ranking.length);

console.log('SMOKE OK');
console.log('steps=' + steps, 'phase=' + sim.phase, 'alive=' + sim.aliveCount());
console.log('ranking:');
ranking.slice(0, 3).forEach((c, i) => console.log('  ' + (i + 1) + '. ' + c.name + ' alive=' + c.alive));
