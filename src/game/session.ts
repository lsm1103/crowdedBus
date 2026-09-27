import type { Simulation, RosterEntry } from '../domain/simulation';
import { Match } from '../domain/match';
import { CHARACTERS, characterById } from '../config/characters';
import { BALANCE } from '../config/balance';
import { Scene3D } from '../view/scene';
import { buildBus } from '../view/bus';
import { ActorManager } from '../view/actors';
import { EffectManager } from '../view/fx';
import { GrabLink, SeatMarkerView } from '../view/props';
import { SceneryView } from '../view/scenery';
import { NpcView } from '../view/npcs';
import { CabinPose } from '../view/cabin';
import { HUD } from '../ui/hud';
import { InputManager } from '../core/input';
import { showResult, hideLobby, showLobby, showIntermission, hideIntermission } from '../ui/screens';
import { Engine, SFX, unlockAudio } from '../core/audio';
import { Tutorial } from '../ui/tutorial';
import { applyMatchResult, shouldShowTutorial } from '../core/storage';
import { renderShareCard, memeFor } from '../ui/sharecard';
import { onStageChange, tryLockLandscape } from '../core/orientation';
import {
  RIG_BOARDING, RIG_IGNITION, RIG_DRIVING, RIG_FINALE, RIG_ELIMINATED, type CameraRig
} from '../config/view';
import type { GameEvent, Phase } from '../domain/types';
import * as THREE from 'three';

const RIG_BY_PHASE: Record<Phase, CameraRig> = {
  boarding: RIG_BOARDING,
  ignition: RIG_IGNITION,
  driving: RIG_DRIVING,
  finale: RIG_FINALE,
  ended: RIG_FINALE
};

/** 越肩贴身的两个阶段：这时要藏掉玩家自己的名字牌和头顶箭头。 */
const CLOSE_PHASES: ReadonlySet<Phase> = new Set<Phase>(['driving', 'finale']);

const FIXED_DT = 1 / BALANCE.tickRate;
/** 回合之间的间歇（秒）：显示本回合赢家和胜场。 */
const INTERMISSION = 3;
/** 先赢几回合拿下整场。 */
const WINS_NEEDED = 3;

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 编排一整场：先赢 3 回合的人拿下整场（docs/08 第 3.3 节）。
 * 规则在 domain/Match + Simulation 里；这里只负责串联画面、界面、输入和音效。
 */
export class Game {
  private scene: Scene3D;
  private busView = buildBus();
  private actors = new ActorManager();
  private fx = new EffectManager();
  private scenery = new SceneryView();
  private npcView = new NpcView();
  private grabLink = new GrabLink();
  private seatMarkers = new SeatMarkerView();
  private cabin = new CabinPose();
  private tmp = new THREE.Vector3();
  private tmpAnchor = new THREE.Vector3();
  private match: Match | null = null;
  private sim!: Simulation;
  private hud: HUD;
  private input: InputManager;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private t = 0;
  private running = false;
  private paused = false;
  /** 回合结束后的间歇倒计时；回合结束后模拟不再推进，只渲染。 */
  private interTimer = 0;
  private roundOver = false;
  private lastPhase: Phase = 'boarding';
  private lastRail: number | null = null;
  private lastCharId = CHARACTERS[0].id;
  private tutorial: Tutorial | null = null;
  private hudRoot: HTMLElement;
  /** 玩家本回合已被挤下车 → 镜头保持观战机位。 */
  private spectating = false;
  /** 上一步每扇门的开关状态，用来检出开门/关门的那一刻。 */
  private doorWasOpen: boolean[] = [];
  /** 本步有门打开：到站开门和机关预警同一步到达时只播开门音。 */
  private doorOpenedThisStep = false;
  /** 整场里每个人一共把几个人扔 / 挤下了车（按角色 id）。 */
  private matchThrowOuts = new Map<number, number>();
  /** 最近一次把玩家弄下车的人，结算梗用。 */
  private lastKiller: string | undefined;

  constructor(app: HTMLElement) {
    this.scene = new Scene3D(app);
    // 车身和车里的一切都挂在车厢姿态组下，跟着刹车点头、转弯侧倾；
    // 车轮、街景、手臂连线留在世界里（连线两端各自取世界坐标）。
    const cabin = this.cabin.group;
    this.scene.scene.add(cabin, this.busView.chassis);
    cabin.add(this.busView.group, this.actors.root, this.npcView.root);
    cabin.add(this.fx.root, this.seatMarkers.root);
    this.scene.scene.add(this.scenery.root, this.grabLink.root);
    // 名字牌去重要把标签投影到屏幕上，需要真实相机；观战机位要让开树和路灯。
    this.actors.setCamera(this.scene.camera);
    this.scenery.setCamera(this.scene.camera);
    // 摔下车的人、上下车的路人都要落在真实地面上。
    this.actors.setGround(this.scenery);
    this.actors.setRailAnchor((id) => this.busView.railAnchor(id));
    this.npcView.setGround(this.scenery);

    const hudRoot = document.getElementById('hud')!;
    this.hudRoot = hudRoot;
    this.hud = new HUD(hudRoot);
    this.input = new InputManager(
      must(hudRoot, '#joystick-zone'),
      must(hudRoot, '#joystick-base'),
      must(hudRoot, '#joystick-knob'),
      {
        grab: must(hudRoot, '#btn-grab'),
        push: must(hudRoot, '#btn-push'),
        dash: must(hudRoot, '#btn-dash')
      },
      must(hudRoot, '#look-zone')
    );

    // 舞台尺寸/旋转变化后画布必须跟着重设，否则强制横屏下画面会被拉伸。
    onStageChange(() => this.scene.resize());

    this.bindPause(hudRoot);
    // 切到后台就暂停：切走后计时和模拟还在跑，回来人可能已经没了。
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.running && !this.paused) this.setPaused(true);
    });
  }

  private bindPause(hudRoot: HTMLElement) {
    const mask = document.getElementById('pause-mask')!;
    must(hudRoot, '#btn-pause').addEventListener('click', () => this.setPaused(true));
    document.getElementById('btn-resume')!.addEventListener('click', () => this.setPaused(false));
    document.getElementById('btn-quit')!.addEventListener('click', () => {
      mask.classList.remove('show');
      this.abort();
    });
  }

  private setPaused(v: boolean) {
    if (!this.running) return;
    this.paused = v;
    document.getElementById('pause-mask')!.classList.toggle('show', v);
    Engine.pause(v);
    if (!v) this.last = performance.now();
  }

  /** 开一整场。8 个角色能力完全一样，玩家选的只是外观。 */
  start(playerCharId: string) {
    this.lastCharId = playerCharId;
    const playerDef = characterById(playerCharId);
    const botDefs = shuffle(CHARACTERS.filter((c) => c.id !== playerCharId));
    const roster: RosterEntry[] = [
      { defId: playerDef.id, name: '你', color: playerDef.color, isPlayer: true },
      ...botDefs.slice(0, BALANCE.botCount).map((d) => ({
        defId: d.id, name: d.name, color: d.color, isPlayer: false
      }))
    ];
    this.match = new Match(roster, WINS_NEEDED);
    this.matchThrowOuts = new Map();
    this.lastKiller = undefined;
    // 只有第一场出引导；玩家点过"跳过教学"就永久不再出。
    // 教学跨回合：第一回合没讲完的接着在下一回合讲，整场结束才停。
    this.tutorial?.stop();
    this.tutorial = shouldShowTutorial() ? new Tutorial(this.hudRoot, 0) : null;

    hideLobby();
    hideIntermission();
    this.hud.show();
    unlockAudio();
    tryLockLandscape();
    this.requestFullscreen();

    this.beginRound();
    this.running = true;
    this.paused = false;
    this.acc = 0;
    this.t = 0;
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame((n) => this.loop(n));
  }

  /** 开新一回合：同一批人，重新上车。 */
  private beginRound() {
    const match = this.match!;
    this.sim = match.newRound();
    this.roundOver = false;
    this.interTimer = 0;
    this.cabin.reset();
    // 门状态基线取 setup 之后：开局后门本来就开着，不能当成"开门"去叮咚。
    this.doorWasOpen = this.sim.layout.doors.map((d) => d.open);
    // 上一回合的残留全部清掉：输入、HUD 横幅计时、扶手高亮、连线、路人。
    this.input.reset();
    this.hud.reset();
    this.busView.highlightRail(null);
    this.grabLink.hide();
    this.npcView.reset();
    this.lastRail = null;
    this.spectating = false;
    this.actors.setRoster(this.sim.characters);
    this.scene.setTarget(this.sim.characters[0].pos);
    this.scene.setTargetFacing(this.sim.characters[0].facing);
    this.scene.setRig(RIG_BOARDING, true);
    this.actors.get(0)?.setSelfMarkersVisible(true);
    this.scenery.setPhase('boarding');
    this.scenery.setBusSpeed(0);
    this.lastPhase = 'boarding';
    this.pushRoundInfo();
    this.hud.banner(`第 ${match.round} 回合 · 走进后门上车！`, 3);
    SFX.start();
    Engine.start();
  }

  /** 中途退出：直接回大厅，不走结算。 */
  private abort() {
    this.running = false;
    this.paused = false;
    Engine.stop();
    cancelAnimationFrame(this.raf);
    this.tutorial?.stop();
    this.busView.highlightRail(null);
    this.grabLink.hide();
    hideIntermission();
    this.hud.hide();
    showLobby();
  }

  private requestFullscreen() {
    // iOS 全系不支持 Element.requestFullscreen，失败是预期内的，由强制横屏兜底。
    try {
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
      const p = el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.();
      p?.catch(() => { /* 忽略 */ });
    } catch {
      /* 忽略不支持全屏的环境 */
    }
  }

  private loop(now: number) {
    if (!this.running) return;
    this.raf = requestAnimationFrame((n) => this.loop(n));

    let dt = (now - this.last) / 1000;
    this.last = now;
    if (this.paused) return;
    if (dt > 0.25) dt = 0.25;
    this.t += dt;

    if (this.roundOver) {
      // 回合间歇：模拟停住，画面继续（摔下车的演出播完）。
      this.interTimer -= dt;
      if (this.interTimer <= 0) this.afterIntermission();
      if (!this.running) return;
      this.render(dt);
      return;
    }

    this.acc += dt;
    let steps = 0;
    while (this.acc >= FIXED_DT && steps < 5 && !this.roundOver) {
      this.step();
      this.acc -= FIXED_DT;
      steps++;
    }
    // 追帧上限打满说明设备跟不上：丢掉积压而不是一直欠着。
    if (steps >= 5) this.acc = Math.min(this.acc, FIXED_DT);

    this.render(dt);
  }

  private step() {
    // 用上一帧渲染后的相机偏航来解释这一帧的摇杆 —— 玩家看到的就是上一帧的画面。
    this.input.setBasisYaw(this.scene.cameraYaw);
    this.sim.applyPlayerInput(this.input.takeFrame());
    const events = this.sim.tick(FIXED_DT);
    this.doorOpenedThisStep = this.playDoorSounds();
    for (const e of events) this.handleEvent(e);

    const snap = this.sim.snapshot();
    // 触屏"抓"是锁定式：手里空了就自动解锁（坐着也算空手，下一次点才是起身）。
    this.input.syncGrab(snap.playerHold !== 'none', FIXED_DT);
    this.hud.update(snap);
    this.tutorial?.update(snap, events, this.t);

    // 每个阶段换一套跟随规格：上车拉开看站台，发车后收到贴身。
    if (snap.phase !== this.lastPhase) {
      this.lastPhase = snap.phase;
      if (!this.spectating) {
        this.scene.setRig(RIG_BY_PHASE[snap.phase]);
        this.actors.get(0)?.setSelfMarkersVisible(!CLOSE_PHASES.has(snap.phase));
      }
      this.scenery.setPhase(snap.phase);
      if (snap.phase === 'ignition') {
        this.scene.shake(0.42);
        SFX.ignition();
      }
      if (snap.phase === 'finale') this.scene.shake(0.5);
    }
    this.scenery.setBusSpeed(snap.busSpeed);
    this.scenery.setStoppingDistance(this.sim.stoppingDistance);

    const p = this.sim.characters[0];
    this.hud.setCooldowns(p.dashCd, p.pushCd);
    const rail = p.hold?.kind === 'rail' ? p.hold.id : null;
    if (rail !== this.lastRail) {
      this.lastRail = rail;
      this.busView.highlightRail(rail);
    }

    if (this.sim.phase === 'ended' && !this.roundOver) this.endRound();
  }

  /** 回合结束：记下赢家，显示间歇。 */
  private endRound() {
    const match = this.match!;
    this.roundOver = true;
    this.interTimer = INTERMISSION;
    this.acc = 0;
    for (const c of this.sim.characters) {
      this.matchThrowOuts.set(c.id, (this.matchThrowOuts.get(c.id) ?? 0) + c.throwOuts);
    }
    const result = match.recordRound(this.sim);
    const winners = result.winners.map((id) => this.sim.characters[id]).filter(Boolean);
    if (winners.some((c) => c.isPlayer)) SFX.respawn();
    else SFX.fail();
    this.grabLink.hide();
    this.pushRoundInfo();
    showIntermission({
      round: match.round,
      winners: winners.map((c) => ({ name: c.name, color: c.color, isPlayer: c.isPlayer })),
      table: this.sim.characters
        .map((c) => ({ name: c.name, color: c.color, wins: match.winsOf(c.id), isPlayer: c.isPlayer }))
        .sort((a, b) => b.wins - a.wins),
      winsNeeded: WINS_NEEDED
    });
  }

  private afterIntermission() {
    hideIntermission();
    if (this.match!.champion !== null) this.finish();
    else this.beginRound();
  }

  /** 顶部的回合数与各人胜场（谁已被淘汰变灰）。 */
  private pushRoundInfo() {
    const match = this.match!;
    this.hud.setRoundInfo({
      round: match.round,
      winsNeeded: WINS_NEEDED,
      players: this.sim.characters.map((c) => ({
        id: c.id, name: c.name, color: c.color, wins: match.winsOf(c.id), alive: c.alive, isPlayer: c.isPlayer
      }))
    });
  }

  private handleEvent(e: GameEvent) {
    const chars = this.sim.characters;
    const at = (id: number) => chars[id]?.pos;
    const name = (id: number) => chars[id]?.name ?? '';
    switch (e.type) {
      case 'banner':
        this.hud.banner(e.text, e.prio);
        break;
      case 'push': {
        const p = at(e.charId);
        if (p) this.fx.push(p);
        this.actors.get(e.charId)?.playPush();
        if (e.charId === 0) {
          SFX.push();
          this.scene.shake(0.12);
        }
        break;
      }
      case 'dash': {
        const p = at(e.charId);
        if (p) this.fx.dash(p);
        if (e.charId === 0) SFX.dash();
        break;
      }
      case 'hit': {
        const p = at(e.charId);
        if (p) this.fx.push(p);
        if (e.charId === 0) {
          SFX.hit();
          this.scene.shake(0.3);
        } else if (e.byId === 0) {
          this.scene.shake(0.1);
        }
        break;
      }
      case 'knockdown': {
        const p = at(e.charId);
        if (p) this.fx.eliminate(p);
        if (e.charId === 0) {
          SFX.hit();
          this.scene.shake(0.5);
          this.hud.toastText('被推倒了！', 'fail');
        } else if (e.byId === 0) {
          SFX.hit();
          this.scene.shake(0.2);
          this.hud.toastText(`${name(e.charId)} 倒了 · 点【抓】拖到门口，再按【扔】`);
        }
        break;
      }
      case 'grab': {
        const p = at(e.charId);
        if (p) this.fx.grab(p);
        if (e.charId === 0) {
          SFX.grab();
          if (e.target.kind === 'char') this.hud.toastText(`抓住 ${name(e.target.id)}`);
        }
        break;
      }
      case 'release':
        if (e.charId === 0) SFX.release();
        break;
      case 'grabFail':
        if (e.charId === 0) SFX.fail();
        break;
      case 'throw': {
        const p = at(e.victimId);
        if (p) this.fx.dash(p);
        if (e.byId === 0 || e.victimId === 0) {
          SFX.dash();
          this.scene.shake(e.victimId === 0 ? 0.6 : 0.25);
        }
        break;
      }
      case 'yank':
        if (e.byId === 0) {
          SFX.push();
          this.hud.toastText(`把 ${name(e.victimId)} 拽起来了`);
        } else if (e.victimId === 0) {
          SFX.hit();
          this.hud.toastText('被拽起来了！', 'fail');
        }
        break;
      case 'sit':
        if (e.charId === 0) {
          SFX.grab();
          this.hud.toastText('坐下了 · 最稳，但不能出手');
        }
        break;
      case 'stand':
        if (e.charId === 0) SFX.release();
        break;
      case 'eliminate': {
        const c = chars[e.charId];
        const p = at(e.charId);
        if (p) this.fx.eliminate(p);
        if (c) {
          // 朝车外摔：速度方向优先，速度接近 0 时就朝车门一侧（+x）甩出去。
          let dx = c.vel.x;
          let dz = c.vel.z;
          if (Math.hypot(dx, dz) < 0.5) {
            dx = 1;
            dz = 0;
          }
          this.actors.get(c.id)?.playEliminate(dx, dz, c.pos.x, c.pos.z);
        }
        SFX.eliminate();
        this.scene.shake(e.charId === 0 ? 0.7 : 0.28);
        if (e.byId === 0 && e.charId !== 0) this.hud.banner(`你把 ${name(e.charId)} 扔下车了！`, 3);
        if (e.charId === 0) {
          // 自己出局：拉远看清是怎么被挤下去的，同时把名字牌放回来。
          this.lastKiller = e.byId !== null ? name(e.byId) : undefined;
          this.spectating = true;
          this.scene.setRig(RIG_ELIMINATED);
          this.actors.get(0)?.setSelfMarkersVisible(true);
        }
        this.pushRoundInfo();
        break;
      }
      case 'eventStart':
        // 到站开门和机关预警同一步：两个音叠在一起是一团噪音，这一步只播开门音。
        if (!this.doorOpenedThisStep) SFX.warn();
        this.scene.shake(0.2);
        break;
      case 'npcBoard':
        // 候车亭里等车的人"上车了"：真正的路人由规则层生成，画在车厢里。
        this.scenery.hideWaiting();
        break;
      case 'station':
      case 'npcAlight':
      case 'roundEnd':
        break;
    }
  }

  /**
   * 车门开关的提示音。规则层只维护 doors[].open、不发事件，所以逐步比对上一步的状态：
   * 任一扇门关→开播开门音，开→关播关门音；同一步既有开又有关时只播开门（更危险）。
   */
  private playDoorSounds(): boolean {
    const doors = this.sim.layout.doors;
    let opened = false;
    let closed = false;
    for (let i = 0; i < doors.length; i++) {
      const open = doors[i].open;
      if (open === this.doorWasOpen[i]) continue;
      this.doorWasOpen[i] = open;
      if (open) opened = true;
      else closed = true;
    }
    if (opened) SFX.doorOpen();
    else if (closed) SFX.doorClose();
    return opened;
  }

  private render(dt: number) {
    const p = this.sim.characters[0];
    // 镜头越肩跟随玩家；玩家出局后停在原地，别把镜头甩飞。
    if (p && p.alive) {
      this.scene.setTarget(p.pos);
      this.scene.setTargetFacing(p.facing);
      this.scene.setMoving(p.status === 'walking' || p.status === 'dashing');
    }
    // 环顾在渲染帧里消费：它纯粹是表现，且拖动的采样率跟的是屏幕。
    const look = this.input.takeLook();
    if (look.dx !== 0) this.scene.peekBy(look.dx);
    if (look.ended) this.scene.endPeek();
    // 终局侧倾沿世界 ±x，只有 ±x 在屏幕上是左右方向时才该滚转。
    this.scene.setRoll(this.sim.tilt * 0.045 * Math.cos(this.scene.cameraYaw));
    // 相机必须先算：车壳遮挡和名字牌缩放都要用本帧的相机位置。
    this.scene.update(dt);
    const cp = this.scene.cameraPosition;
    this.cabin.update(dt, this.sim.longAccel, this.sim.latAccel, this.sim.busSpeed);
    Engine.set(this.sim.busSpeed, this.cabin.throttle);
    this.cabin.group.updateMatrixWorld(true);

    this.busView.update(this.sim.layout.doors, dt, this.sim.busSpeed);
    this.busView.setShellOcclusion(cp.x, cp.z);
    this.actors.update(this.sim.characters, this.t, dt, cp);
    this.npcView.update(this.sim.npcs, this.t, dt);
    const snap = this.sim.snapshot();
    // 终局两门全开、到处是人，这时再高亮空座没意义，所以只在能坐的阶段显示。
    this.seatMarkers.update(
      snap.seats.map((s) => ({ id: s.id, x: s.x, z: s.z, free: s.occupant === 'none', mine: s.occupant === 'player' })),
      snap.seatGuide?.id ?? null, !!snap.seatGuide?.inReach,
      snap.playerAlive && snap.phase !== 'finale' && snap.phase !== 'ended', dt
    );
    this.scenery.update(dt);
    this.updateGrabLink();
    this.fx.update(dt);
    this.hud.frame(dt);
    this.scene.render();
  }

  /** 玩家和他抓着的那根扶手之间连一条线，"抓住"到底抓到了什么一目了然。 */
  private updateGrabLink() {
    const p = this.sim.characters[0];
    const actor = p ? this.actors.get(p.id) : undefined;
    if (!p || !p.alive || p.hold?.kind !== 'rail' || !actor) {
      this.grabLink.hide();
      return;
    }
    const local = this.busView.railAnchor(p.hold.id);
    if (!local) {
      this.grabLink.hide();
      return;
    }
    // 扶手锚点是车身坐标，车身会倾斜；手的位置是世界坐标。两端统一换成世界坐标再连。
    const anchor = this.busView.group.localToWorld(this.tmpAnchor.copy(local));
    this.grabLink.show(actor.handPosition(this.tmp), anchor);
  }

  /** 整场结束：按回合胜场排名，写存档，出结算。 */
  private finish() {
    const match = this.match!;
    this.running = false;
    cancelAnimationFrame(this.raf);
    Engine.stop();
    this.hud.hide();
    this.tutorial?.stop();
    this.grabLink.hide();
    this.busView.highlightRail(null);
    this.scenery.setBusSpeed(0);
    SFX.finish();
    const champion = match.champion;
    const chars = this.sim.characters;
    const ranking = chars.slice().sort((a, b) => {
      if (a.id === champion) return -1;
      if (b.id === champion) return 1;
      return match.winsOf(b.id) - match.winsOf(a.id);
    });
    const rows = ranking.map((c, i) => ({
      rank: i + 1,
      name: c.name,
      color: c.color,
      isPlayer: c.isPlayer,
      wins: match.winsOf(c.id),
      throwOuts: this.matchThrowOuts.get(c.id) ?? 0,
      champion: c.id === champion
    }));
    const me = chars[0];
    const stats = {
      charId: this.lastCharId,
      won: champion === me.id,
      rank: ranking.findIndex((c) => c.isPlayer) + 1,
      total: chars.length,
      rounds: match.round,
      roundWins: match.winsOf(me.id),
      throwOuts: this.matchThrowOuts.get(me.id) ?? 0,
      winsNeeded: WINS_NEEDED
    };
    const records = applyMatchResult({
      charId: stats.charId, won: stats.won, rounds: stats.rounds,
      roundWins: stats.roundWins, throwOuts: stats.throwOuts
    });
    showResult(
      rows, records,
      () => this.start(this.lastCharId),
      () => renderShareCard(stats, memeFor(stats, { killer: this.lastKiller })),
      { rounds: match.round, winsNeeded: WINS_NEEDED }
    );
  }
}

function must(root: HTMLElement, sel: string): HTMLElement {
  const el = root.querySelector(sel) as HTMLElement | null;
  if (!el) throw new Error('元素缺失: ' + sel);
  return el;
}
