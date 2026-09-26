import { Simulation, type RosterEntry } from '../domain/simulation';
import { CHARACTERS, characterById } from '../config/characters';
import { BALANCE, SCORE } from '../config/balance';
import { Scene3D } from '../view/scene';
import { buildBus } from '../view/bus';
import { ActorManager } from '../view/actors';
import { EffectManager } from '../view/fx';
import { PropView, GrabLink, HotZoneView, SeatMarkerView } from '../view/props';
import { SceneryView } from '../view/scenery';
import { CabinPose } from '../view/cabin';
import { HUD } from '../ui/hud';
import { InputManager } from '../core/input';
import { showResult, hideLobby, showLobby } from '../ui/screens';
import { Engine, SFX, unlockAudio } from '../core/audio';
import { Tutorial } from '../ui/tutorial';
import { applyMatchResult, shouldShowTutorial, getProfile } from '../core/storage';
import { isUnlocked } from '../config/unlocks';
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

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 编排一局：串联模拟、渲染与 UI。 */
export class Game {
  private scene: Scene3D;
  private busView = buildBus();
  private actors = new ActorManager();
  private fx = new EffectManager();
  private props = new PropView();
  private scenery = new SceneryView();
  private grabLink = new GrabLink();
  private hotZoneView = new HotZoneView();
  private seatMarkers = new SeatMarkerView();
  private tmp = new THREE.Vector3();
  private tmpAnchor = new THREE.Vector3();
  private tmpArrow = new THREE.Vector3();
  private cabin = new CabinPose();
  private sim = new Simulation();
  private hud: HUD;
  private input: InputManager;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private t = 0;
  private running = false;
  private paused = false;
  private endedShown = false;
  private lastPhase: Phase = 'boarding';
  private lastGrab: number | null = null;
  private lastCharId = CHARACTERS[0].id;
  private tutorial: Tutorial | null = null;
  private hudRoot: HTMLElement;
  /**
   * 玩家当前不在场（被挤下车，含返场途中）→ 镜头保持观战机位。
   * 以前阶段一切换就无条件套 RIG_BY_PHASE，把观战机位拉回贴身；
   * 返场后又从不切回来，活着的玩家要用观战机位一直玩到终局。
   */
  private spectating = false;
  /** 本步里被玩家击落的人：他们的通用"X 被挤下车"横幅不再重复播。 */
  private koByMe = new Set<number>();
  /** 上一步每扇门的开关状态（下标对应 sim.layout.doors），用来检出开门/关门的那一刻。 */
  private doorWasOpen: boolean[] = [];
  /** 本步有门打开：到站开门和 eventStart 同一步到达，这一步只播开门音。 */
  private doorOpenedThisStep = false;

  constructor(app: HTMLElement) {
    this.scene = new Scene3D(app);
    // 车身和车里的一切都挂在车厢姿态组下，跟着刹车点头、转弯侧倾；
    // 车轮、街景、手臂连线留在世界里（连线两端各自取世界坐标）。
    const cabin = this.cabin.group;
    this.scene.scene.add(cabin, this.busView.chassis);
    cabin.add(this.busView.group);
    cabin.add(this.actors.root);
    // 名字牌去重要把标签投影到屏幕上，需要真实相机。
    this.actors.setCamera(this.scene.camera);
    // 观战机位会退到人行道上空，树和路灯要给镜头让路。
    this.scenery.setCamera(this.scene.camera);
    // 摔下车的人要落在真实地面上，车在开时还要被甩在后面。
    this.actors.setGround(this.scenery);
    cabin.add(this.fx.root, this.props.root, this.hotZoneView.root, this.seatMarkers.root);
    this.scene.scene.add(this.scenery.root);
    this.scene.scene.add(this.grabLink.root);

    const hudRoot = document.getElementById('hud')!;
    this.hudRoot = hudRoot;
    this.hud = new HUD(hudRoot);
    this.input = new InputManager(
      must(hudRoot, '#joystick-zone'),
      must(hudRoot, '#joystick-base'),
      must(hudRoot, '#joystick-knob'),
      {
        dash: must(hudRoot, '#btn-dash'),
        push: must(hudRoot, '#btn-push'),
        interact: must(hudRoot, '#btn-grab'),
        skill: must(hudRoot, '#btn-skill')
      },
      must(hudRoot, '#look-zone')
    );

    // 舞台尺寸/旋转变化后画布必须跟着重设，否则强制横屏下画面会被拉伸。
    onStageChange(() => this.scene.resize());

    this.bindPause(hudRoot);
    // 切到后台就暂停：以前切走后计时和模拟还在跑，回来人可能已经没了。
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

    this.sim.setup(roster);
    this.cabin.reset();
    // 门状态基线取 setup 之后：开局后门本来就开着，不能当成"开门"去叮咚。
    this.doorWasOpen = this.sim.layout.doors.map((d) => d.open);
    // 上一局的残留全部清掉：输入（摇杆指针/按键）、HUD 横幅计时、扶手高亮、连线。
    // 中途退出走的是 abort()，那条路径以前不清扶手高亮，会带进下一局。
    this.input.reset();
    this.hud.reset();
    this.busView.highlightRail(null);
    this.grabLink.hide();
    this.spectating = false;
    this.koByMe.clear();
    this.actors.setRoster(this.sim.characters);
    this.scene.setTarget(this.sim.characters[0].pos);
    this.scene.setTargetFacing(this.sim.characters[0].facing);
    this.scene.setRig(RIG_BOARDING, true);
    this.actors.get(0)?.setSelfMarkersVisible(true);
    this.scenery.setPhase('boarding');
    this.scenery.setBusSpeed(0);
    this.lastPhase = 'boarding';
    this.lastGrab = null;
    hideLobby();
    this.hud.show();
    this.hud.setGrab(false);
    this.hud.setGrabState(null);
    this.hud.setSkillName(playerDef.skillName);
    this.hud.status('走进后门上车！', 2.2);
    // 只有第一局出引导；玩家点过"跳过教学"就永久不再出。
    this.tutorial?.stop();
    this.tutorial = shouldShowTutorial() ? new Tutorial(this.hudRoot) : null;

    unlockAudio();
    SFX.start();
    Engine.start();
    tryLockLandscape();
    this.requestFullscreen();

    this.running = true;
    this.paused = false;
    this.endedShown = false;
    this.acc = 0;
    this.t = 0;
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame((n) => this.loop(n));
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
    this.acc += dt;

    let steps = 0;
    while (this.acc >= FIXED_DT && steps < 5) {
      this.step();
      this.acc -= FIXED_DT;
      steps++;
    }
    // 追帧上限打满说明设备跟不上：丢掉积压而不是一直欠着。
    // 否则持续低于约 12fps 时积压无限增长，帧率一恢复就整段快进。
    if (steps >= 5) this.acc = Math.min(this.acc, FIXED_DT);

    this.render(dt);
  }

  private step() {
    // 用上一帧渲染后的相机偏航来解释这一帧的摇杆 —— 玩家看到的就是上一帧的画面。
    // 必须在 takeFrame() 之前喂，否则摇杆方向会落后一帧。
    this.input.setBasisYaw(this.scene.cameraYaw);
    const frame = this.input.takeFrame();
    this.sim.applyPlayerInput(frame);
    const events = this.sim.tick(FIXED_DT);
    this.koByMe.clear();
    this.doorOpenedThisStep = this.playDoorSounds();
    for (const e of events) this.handleEvent(e);

    const snap = this.sim.snapshot();
    this.hud.update(snap);
    this.tutorial?.update(snap, events, this.t);

    // 每个阶段换一套跟随规格：上车拉开看站台，发车后收到贴身。
    if (snap.phase !== this.lastPhase) {
      this.lastPhase = snap.phase;
      // 玩家不在场时保持观战机位和名字牌，只在返场/新局时才回到阶段机位。
      if (!this.spectating) {
        this.scene.setRig(RIG_BY_PHASE[snap.phase]);
        this.actors.get(0)?.setSelfMarkersVisible(!CLOSE_PHASES.has(snap.phase));
      }
      this.scenery.setPhase(snap.phase);
      if (snap.phase === 'ignition') {
        this.scene.shake(0.42);
        SFX.ignition();
        this.hud.toastText('发动机启动');
      }
      if (snap.phase === 'finale') this.scene.shake(0.5);
    }
    this.scenery.setBusSpeed(snap.busSpeed);
    this.scenery.setStoppingDistance(this.sim.stoppingDistance);

    const p = this.sim.characters[0];
    this.hud.setCooldowns(p.dashCd, p.pushCd, p.skillCd);
    this.hud.setStunned(p.alive && p.stunTimer > 0);
    if (p.grabHandrail !== this.lastGrab) {
      this.lastGrab = p.grabHandrail;
      this.hud.setGrab(p.grabHandrail !== null);
      this.hud.setGrabState(p.grabHandrail);
      this.busView.highlightRail(p.grabHandrail);
    }

    if (this.sim.phase === 'ended' && !this.endedShown) {
      this.endedShown = true;
      this.finish();
    }
  }

  private handleEvent(e: GameEvent) {
    const at = (id: number) => this.sim.characters[id]?.pos;
    switch (e.type) {
      case 'banner':
        // 玩家亲手击落的人已经有"你把 X 挤下车 +分"那条，通用出局横幅不再重复。
        if (e.charId !== undefined && this.koByMe.has(e.charId)) break;
        this.hud.banner(e.text, e.prio);
        break;
      case 'push': {
        const p = at(e.charId);
        if (p) this.fx.push(p);
        this.actors.get(e.charId)?.playPush();
        if (e.charId === 0) {
          SFX.push();
          this.scene.shake(0.16);
        }
        break;
      }
      case 'hit': {
        const p = at(e.charId);
        if (p) this.fx.push(p);
        if (e.charId === 0) {
          SFX.hit();
          this.scene.shake(0.32);
        }
        break;
      }
      case 'dash': {
        const p = at(e.charId);
        if (p) this.fx.dash(p);
        if (e.charId === 0) SFX.dash();
        break;
      }
      case 'skill': {
        const c = this.sim.characters[e.charId];
        if (c) {
          this.fx.skill(c.pos, c.color);
          this.actors.get(c.id)?.playSkill(c.defId);
        }
        if (e.charId === 0 && c) {
          SFX.skill();
          this.scene.shake(0.14);
          this.hud.toastText(characterById(c.defId).skillName);
        }
        break;
      }
      case 'grab': {
        const p = at(e.charId);
        if (p) this.fx.grab(p);
        if (e.charId === 0) {
          SFX.grab();
          this.hud.toastText(`抓住 ${e.railId + 1} 号扶手`);
        }
        break;
      }
      case 'release':
        if (e.charId === 0) {
          SFX.release();
          this.hud.toastText('松手');
        }
        break;
      case 'grabFail':
        if (e.charId === 0) {
          SFX.fail();
          this.hud.toastText('附近没有空扶手', 'fail');
        }
        break;
      case 'skillFail':
        if (e.charId === 0) {
          SFX.fail();
          // 以前一律说"冷却中"，阿远身前放不下箱子时玩家会以为按钮坏了。
          this.hud.toastText(e.reason === 'blocked' ? '前面放不下行李' : '技能冷却中', 'fail');
        }
        break;
      case 'eliminate': {
        const c = this.sim.characters[e.charId];
        const p = at(e.charId);
        if (p) this.fx.eliminate(p);
        if (c) {
          // 朝车外摔：速度方向优先，速度接近 0 时就朝最近那扇门的方向甩出去。
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
        // 自己出局就拉远看清是怎么被挤下去的，同时把名字牌放回来。
        if (e.charId === 0) {
          this.spectating = true;
          this.scene.setRig(RIG_ELIMINATED);
          this.actors.get(0)?.setSelfMarkersVisible(true);
        }
        break;
      }
      case 'respawn': {
        const p = at(e.charId);
        if (p) this.fx.respawn(p);
        if (e.charId === 0) {
          SFX.respawn();
          this.hud.status('返场保护已用完，小心！', 2.2);
          // 返场了就回到当前阶段的跟随机位（以前一直停在观战机位）。
          this.spectating = false;
          const phase = this.sim.phase;
          this.scene.setRig(RIG_BY_PHASE[phase]);
          this.actors.get(0)?.setSelfMarkersVisible(!CLOSE_PHASES.has(phase));
        }
        break;
      }
      case 'knockout': {
        const v = this.sim.characters[e.victimId];
        if (e.byId === 0 && v) {
          this.koByMe.add(e.victimId);
          const gain = SCORE.knockout + (e.streak - 1) * SCORE.knockoutStreakStep;
          this.hud.banner(`你把${v.name}挤下车！+${gain}`, 3);
          this.scene.shake(0.35);
        }
        break;
      }
      case 'seatTaken':
        if (e.charId === 0) this.hud.toastText(`抢到座位 · 每秒得分`);
        break;
      case 'unseat':
        if (e.charId === 0) {
          this.hud.toastText(e.byId !== null ? '被拽起来了！' : '起身', e.byId !== null ? 'fail' : 'ok');
        }
        break;
      case 'score':
        // 有效推挤的分以前完全不可见，玩家不知道"推人"是有收益的。
        // 只报有分量的：逼门（推中门口的人）和拽起座位；1 分的零头不刷屏。
        if (e.charId === 0 && e.reason === 'push') {
          if (e.amount >= SCORE.seatSteal) this.hud.toastText(`拽起座位 +${Math.round(e.amount)}`);
          else if (e.amount >= 8) this.hud.toastText(`逼到门口 +${Math.round(e.amount)}`);
        }
        break;
      case 'eventStart':
        // 到站时开门和事件预警是同一步：两个音叠在一起是一团噪音，
        // 开门"叮咚"更具体也更致命，这一步就只播它（它自带震动）。
        if (!this.doorOpenedThisStep) SFX.warn();
        this.scene.shake(0.2);
        if (e.kind === 'boarding') {
          // "上人"要真的看见有人上来：候车亭里的路人走到开着的门口挤上车。
          const door = this.sim.layout.doors.find((d) => d.open);
          if (door) this.scenery.playBoarding((door.zMin + door.zMax) / 2);
        }
        break;
    }
  }

  /**
   * 车门开关的提示音。模拟层只维护 doors[].open、不发事件，所以逐步比对上一步的状态：
   * 任一扇门关→开播开门音，开→关播关门音；同一步既有开又有关时只播开门（更危险）。
   * 返回本步是否有门打开。
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
    // 环顾在渲染帧里消费而不是在固定步里：它纯粹是表现，且拖动的采样率跟的是屏幕。
    const look = this.input.takeLook();
    if (look.dx !== 0) this.scene.peekBy(look.dx);
    if (look.ended) this.scene.endPeek();
    // 终局侧倾的推力沿世界 ±x（朝车门/朝座位），而越肩镜头跟着朝向转：
    // 只有 ±x 在屏幕上是左右方向时才该滚转，方向取它在屏幕右向量上的分量
    // （屏幕右 = screenToWorld(1,0,yaw) = (cos yaw, -sin yaw)）。
    // 以前固定符号，玩家转个身，画面倾斜的方向就和实际被甩的方向相反。
    this.scene.setRoll(this.sim.tilt * 0.045 * Math.cos(this.scene.cameraYaw));
    // 相机必须先算：车壳遮挡剔除和名字牌缩放都要用本帧的相机位置，
    // 放在后面就会拿到上一帧的值，贴墙转身时能看到墙"闪一下才消失"。
    this.scene.update(dt);
    const cp = this.scene.cameraPosition;
    this.cabin.update(dt, this.sim.longAccel, this.sim.latAccel, this.sim.busSpeed);
    Engine.set(this.sim.busSpeed, this.cabin.throttle);
    this.cabin.group.updateMatrixWorld(true);

    this.busView.update(this.sim.layout.doors, dt, this.sim.busSpeed);
    this.busView.setShellOcclusion(cp.x, cp.z);
    this.actors.update(this.sim.characters, this.t, dt, cp);
    this.props.update(this.sim.activeLuggage);
    const snap = this.sim.snapshot();
    this.hotZoneView.update(
      snap.hotZone.x, snap.hotZone.z, snap.hotZone.r,
      snap.phase === 'driving' || snap.phase === 'finale',
      snap.playerInZone, dt
    );
    // 终局强制清座，这时再高亮空座是骗人的，所以只在能坐的阶段显示。
    this.seatMarkers.update(
      snap.seats, snap.seatGuide?.id ?? null, !!snap.seatGuide?.inReach,
      snap.phase !== 'finale' && snap.phase !== 'ended', dt
    );
    this.scenery.update(dt);
    this.updateSeatArrow(snap);
    this.updateGrabLink();
    this.fx.update(dt);
    this.hud.frame(dt);
    this.scene.render();
  }

  /**
   * 找座箭头：目标空座不在画面里时，在屏幕边缘指向它。
   * 越肩镜头跟着人转，"座位在左边还是右边"没有固定答案，只能按当前画面算。
   */
  private updateSeatArrow(snap: ReturnType<Simulation['snapshot']>) {
    const g = snap.seatGuide;
    const active = !!g && !g.inReach && snap.playerAlive && snap.playerSeat === null
      && (snap.phase === 'ignition' || snap.phase === 'driving');
    if (!active || !g) {
      this.hud.setSeatArrow(null);
      return;
    }
    const cam = this.scene.camera;
    const world = this.cabin.group.localToWorld(this.tmpArrow.set(g.x, 0.8, g.z));
    const view = world.clone().applyMatrix4(cam.matrixWorldInverse);
    let dx: number;
    let dy: number;
    if (view.z < -0.2) {
      const ndc = world.project(cam);
      // 在画面里（留一点边）：绿光柱看得见，不需要箭头。
      if (Math.abs(ndc.x) < 0.9 && ndc.y > -0.75 && ndc.y < 0.7) {
        this.hud.setSeatArrow(null);
        return;
      }
      dx = ndc.x;
      dy = ndc.y;
    } else {
      // 在镜头背后：往下指（"转身"），并带上左右分量。
      dx = view.x;
      dy = -Math.abs(view.z) - 0.3;
    }
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    // 贴着一个内缩的矩形边缘放：上边让开状态栏，下边让开提示条。
    const X = 0.86;
    const TOP = 0.6;
    const BOTTOM = -0.5;
    const tx = dx !== 0 ? X / Math.abs(dx) : Infinity;
    const ty = dy > 0 ? TOP / dy : dy < 0 ? BOTTOM / dy : Infinity;
    const t = Math.min(tx, ty);
    this.hud.setSeatArrow({
      leftPct: (dx * t + 1) * 50,
      topPct: (1 - dy * t) * 50,
      angle: Math.atan2(-dy, dx)
    });
  }

  /** 玩家和他抓着的那根扶手之间连一条线，"抓住"到底抓到了什么一目了然。 */
  private updateGrabLink() {
    const p = this.sim.characters[0];
    const actor = p ? this.actors.get(p.id) : undefined;
    if (!p || !p.alive || p.grabHandrail === null || !actor) {
      this.grabLink.hide();
      return;
    }
    const local = this.busView.railAnchor(p.grabHandrail);
    if (!local) {
      this.grabLink.hide();
      return;
    }
    // 扶手锚点是车身坐标，车身会倾斜；手的位置是世界坐标。两端统一换成世界坐标再连。
    const anchor = this.busView.group.localToWorld(this.tmpAnchor.copy(local));
    this.grabLink.show(actor.handPosition(this.tmp, local), anchor);
  }

  private finish() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    Engine.stop();
    this.hud.hide();
    this.tutorial?.stop();
    this.grabLink.hide();
    this.busView.highlightRail(null);
    this.scenery.setBusSpeed(0);
    SFX.finish();
    const ranking = this.sim.winnerRanking();
    const rows = ranking.map((c, i) => ({
      rank: i + 1,
      name: c.name,
      isPlayer: c.isPlayer,
      score: Math.round(c.score),
      note: [
        c.knockouts > 0 ? `挤下 ${c.knockouts} 人` : '',
        c.seatSeconds > 0.5 ? `坐了 ${Math.round(c.seatSeconds)}s` : '',
        c.alive ? '仍在车内'
          : c.status === 'returning' ? '返场途中'
            : c.eliminatedOrder > 0 ? `第 ${c.eliminatedOrder} 个下车` : '未上车'
      ].filter(Boolean).join(' · ')
    }));
    // 记录本局并拿到刷新的纪录，结算页要能显示"新纪录"。
    const me = this.sim.characters[0];
    const myRank = ranking.findIndex((c) => c.isPlayer) + 1;
    const stats = {
      charId: this.lastCharId,
      rank: myRank,
      total: this.sim.characters.length,
      score: Math.round(me.score),
      knockouts: me.knockouts,
      pushHits: me.pushHits,
      seatSeconds: Math.round(me.seatSeconds),
      survived: me.alive
    };
    // 解锁前后对比，结算页要说出"本局新解锁了谁"。
    const lockedBefore = CHARACTERS.filter((c) => !isUnlocked(c.id, getProfile()));
    const records = applyMatchResult(stats);
    const newlyUnlocked = lockedBefore
      .filter((c) => isUnlocked(c.id, getProfile()))
      .map((c) => c.name);
    // 被谁挤下车的，用来生成"我被 XX 挤下车了"这类可分享的梗。
    const victim = me.knockouts > 0
      ? ranking.find((c) => !c.isPlayer && c.lastHitBy === 0 && !c.alive)?.name
      : undefined;
    showResult(
      rows, records,
      () => this.start(this.lastCharId),
      () => renderShareCard(stats, memeFor(stats, victim)),
      newlyUnlocked
    );
  }
}

function must(root: HTMLElement, sel: string): HTMLElement {
  const el = root.querySelector(sel) as HTMLElement | null;
  if (!el) throw new Error('元素缺失: ' + sel);
  return el;
}
