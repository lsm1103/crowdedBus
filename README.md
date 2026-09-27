# 好挤的大巴（CrowdedBus）

> 推倒 · 拎起来 · 扔下车 —— 一款横屏网页派对游戏（物理乱斗，先赢 3 回合拿下整场）。

玩法、角色与事件设计见 docs/ 目录；当前玩法以 docs/08-派对玩法重构.md 为准（旧的积分、技能、黄圈已移除）。本仓库当前为**可运行的网页原型**：车身与街景已用 Blender 程序化建模，8 名角色是在单独的角色工程里做好的蒙皮模型。

## 平台说明（重要调整）

- 原计划发布**微信小游戏**，现改为**手机浏览器打开的网页**：全屏横屏自动适配，内容与设计不变。
- 视觉目标是文档里的卡通玩具风原型图：车身与街景由 Blender 程序化建模（见下文），角色在单独的角色工程里制作后同步进来（见"角色模型"）。

## 运行

~~~bash
npm install
npm run dev        # 开发服务器，浏览器打开 http://localhost:5173
npm run build      # 类型检查 + 产物构建到 dist/
npm run preview    # 预览构建产物
npm run smoke      # 无头冒烟测试：跑完一整场（先赢 3 回合），验证无崩溃、事件齐全
npm run probe      # 平衡探针：5 种玩家打法各跑 150 回合，把 docs/08 的验收标准写成断言（PROBE_RUNS 可改回合数）
npm run model:build  # 用 Blender 重新生成车模和街景（见下文）
npm run chars:sync   # 从角色工程同步 8 个角色模型并压缩（见下文）
~~~

## 3D 模型（Blender 程序化建模）

车身、车内设施、始发站、楼房、树、路灯全部由 `scripts/blender/build_models.py` 在 Blender 里用代码建出来，导出到 `public/models/`：

| 产物 | 内容 |
| --- | --- |
| `public/models/bus.glb` | 车身（红色切顶剖面玩具车）、车门扇、车轮、座位、扶手、横杆吊环、障碍物、驾驶室 |
| `public/models/city.glb` | 始发站站台（与上车围栏对齐）、中途站候车亭、4 款楼房、行道树、路灯、灌木 |
| `assets-src/crowded_bus.blend` | 同一份场景的 .blend，可在 Blender 里打开查看（**重跑脚本会覆盖**） |

- 门洞、座位、扶手、障碍物、站台围栏的位置一律从碰撞数据读取：`npm run model:build` 会先把 `src/domain/layout.ts` 导出成 `assets-src/layout.json`，再交给 Blender。**改了布局就要重跑一次**，否则控制台会提示车门/扶手与布局不符。
- 默认 Blender 路径是 `/Applications/Blender.app/Contents/MacOS/Blender`，其他位置用环境变量 `BLENDER=/path/to/blender npm run model:build`。需要 Blender 4.2 以上（开发时用 5.2）。
- 纯色件烘成顶点色、共用一个材质（车身 27 次 draw call），玻璃和车灯单独成材质；模型经 meshopt 压缩，两个文件合计约 750KB。
- 代码只按节点名取部件做动画：`door_{front|back}_{a|b}`、`axle_front/rear`、`bus_{near|far|nose|tail}_upper`（相机在外侧时淡成虚影）、`floor_surface`、`sign_front/back`、`station`、`station_board`、`stop`、`bld_0~3`、`tree`、`lamp`、`bush`。改名要同步改 `src/view/bus.ts`、`src/view/scenery.ts`。扶手立杆和握把并在 `bus_interior` 里，被抓住时由代码在那根杆上套一层发光外壳。
- 车外世界尺寸（路面高度、路缘线、雾）在 `src/config/world.ts`，和建模脚本里的同名常量是同一组数。

## 角色模型

8 名角色在单独的角色工程 `blender_char`（默认和本仓库的 `game_project` 目录同级）里用 Blender 制作，游戏只取成品：

- `npm run chars:sync` 读取各角色的移动版 GLB（阿强是 `refined/fitness_guy_mobile_v2.glb`，其余是 `characters/<id>/mobile.glb`），用 gltfpack 做 meshopt 压缩后写到 `public/models/characters/<id>.glb`（8 个合计约 800KB）。角色工程在别处时用 `CHAR_SRC=/path/to/blender_char npm run chars:sync`。
- 8 人共用一套 37 根骨骼。游戏只用模型自带的待机 / 走 / 跑三段动作（按实际移动速度混合、变速）；坐下、抓扶手、抓人、推、踉跄、瘫倒、被拎、被扔这些和规则状态实时对齐的姿势，都在 `src/view/character.ts` / `actors.ts` 里直接转骨骼补出来。
- 角色身高统一缩放到 1.85（`CHAR_HEIGHT`），坐姿按模型大腿根的高度对齐座垫；换了角色比例重跑 `chars:sync` 即可，不用改代码。
- 模型加载失败时角色退回成一根同色胶囊，游戏照常能玩。

手机访问：连同一 Wi-Fi 后打开 dev 服务器输出的 Network: 地址（如 http://192.168.x.x:5173）。

## 操作

| 输入 | 行为 |
| --- | --- |
| 左虚拟摇杆 / WASD | 移动（8 方向） |
| 抓 / 按住 E | 抓扶手（晃不倒）、抓人（摔倒的人被拎起来拖走，站着的人被扯住）、坐下 / 起身；抓着坐着的人不放 1 秒把他拽起来。**触屏是点一下抓住、再点一下松手**，键盘是按住 E |
| 推 / J | 推人掉平衡；拎着摔倒的人时变成"扔"，车门开着把人扔出门就淘汰 |
| 冲 / 空格 | 冲撞（冷却 3s） |

一回合：上车 → 行驶（急刹 / 急转 / 颠簸 / 到站开门，路人上下车）→ 终点前摇摆 → 只剩 1 人或到终点结束。先赢 3 回合的人拿下整场。

## 技术栈与架构

Vite + TypeScript + Three.js，越肩透视相机（跟在玩家背后、随朝向转动；上车和观战时退到远机位）。代码按“领域（规则）—视图（表现）—UI”分层，便于后续替换美术与接入联机：

~~~text
src/
  main.ts              入口
  game/session.ts      对局编排（串联模拟/渲染/UI）
  domain/
    simulation.ts      权威模拟：平衡值/推倒/抓拎扔/座位/路人/机关/淘汰
    match.ts           整场：先赢 N 回合，逐回合记录胜场与扔出人数
    ai.ts              机器人决策（抓扶手、推人、拖到门口扔）
    nav.ts             车厢寻路
    layout.ts          车厢布局与碰撞几何
    types.ts           共享类型
  view/
    scene.ts           渲染器 + 越肩透视相机 + 天空球/雾 + 光照
    bus.ts             车身视图：加载 bus.glb，驱动车门/车轮/扶手高亮/车壳淡出
    scenery.ts         车外世界：滚动路面、实例化楼房树木、始发站、中途站
    models.ts          glTF 预载与材质转换
    character.ts       角色身体：蒙皮模型 + 走跑混合 + 代码补的姿势（转骨骼）
    actors.ts          角色状态 → 姿势，影子/昵称/摔下车演出/挡视线淡出
    npcs.ts            路人乘客：上下车、坐下、走出车门
    cabin.ts           车身姿态：刹车点头、转弯侧倾、行驶颠簸（纯视觉）
  ui/
    hud.ts             对局 HUD（回合与胜场、倒计时、车上人数、三键换脸）
    screens.ts         大厅选角 + 回合间歇 + 整场结算
    tutorial.ts        新手引导气泡
  core/
    input.ts           摇杆/按钮/键盘统一输入
    math.ts            二维向量与插值
  config/
    balance.ts         数值初稿
    characters.ts      8 名角色（只管外观和名字）
    events.ts          随机事件池
~~~

## 当前进度

- [x] 平台切换为网页（横屏自适应 + 全屏）
- [x] 占位原型：车厢、站台、座位、扶手、车门、占位人偶（车厢、场景、角色都已被下面的正式模型替换）
- [x] 派对玩法第一阶段（docs/08）：平衡值、推倒、抓人拖走、扔出车门、拽座、路人上下车、急刹/急转/颠簸
- [x] 回合制：先赢 3 回合拿下整场，回合间歇显示胜场
- [x] 8 角色（纯外观）+ 7 机器人补位
- [x] 车身与车外场景：Blender 程序化建模（红色切顶玩具巴士 + 真 3D 街道，行驶时路面/楼房/站台一起滚动）
- [x] 接入 8 名正式角色模型（`npm run chars:sync`），游戏姿势在代码里补齐
- [ ] 联机：Go 权威服务端 + WebSocket（见 docs/04-technical-design.md）
