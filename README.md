# 好挤的大巴（CrowdedBus）

> 抢位置 · 抓扶手 · 把对手挤下车 —— 一款横屏网页派对游戏。

玩法、角色与事件设计见 docs/ 目录。本仓库当前为**可运行的网页原型**：车身与街景已用 Blender 程序化建模，角色仍是占位人偶。

## 平台说明（重要调整）

- 原计划发布**微信小游戏**，现改为**手机浏览器打开的网页**：全屏横屏自动适配，内容与设计不变。
- 视觉目标是文档里的卡通玩具风原型图：车身与街景已由 Blender 程序化建模完成（见下文），角色仍是占位人偶，正式角色另行制作后替换 src/view/actors.ts。

## 运行

~~~bash
npm install
npm run dev        # 开发服务器，浏览器打开 http://localhost:5173
npm run build      # 类型检查 + 产物构建到 dist/
npm run preview    # 预览构建产物
npm run smoke      # 无头冒烟测试：跑完一整局模拟，验证无崩溃
npm run probe      # 平衡探针：6 种玩家策略各跑 90 局（约 3 分钟），校验"主动打法优于消极"
npm run model:build  # 用 Blender 重新生成车模和街景（见下文）
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

手机访问：连同一 Wi-Fi 后打开 dev 服务器输出的 Network: 地址（如 http://192.168.x.x:5173）。

## 操作

| 输入 | 行为 |
| --- | --- |
| 左虚拟摇杆 / WASD | 移动（8 方向） |
| 冲刺 / 空格 | 冲刺（冷却 3s） |
| 推挤 / J | 推挤（冷却 2s） |
| 抓扶手 / E | 抓/松扶手（减伤 70%） |
| 技能 / Q | 角色主动技能 |
| 表情 / X | 表情 |

## 技术栈与架构

Vite + TypeScript + Three.js，越肩透视相机（跟在玩家背后、随朝向转动；上车和观战时退到远机位）。代码按“领域（规则）—视图（表现）—UI”分层，便于后续替换美术与接入联机：

~~~text
src/
  main.ts              入口
  game/session.ts      对局编排（串联模拟/渲染/UI）
  domain/
    simulation.ts      权威模拟：移动/推挤/冲刺/扶手/事件/淘汰/技能
    ai.ts              机器人决策
    layout.ts          车厢布局与碰撞几何
    types.ts           共享类型
  view/
    scene.ts           渲染器 + 越肩透视相机 + 天空球/雾 + 光照
    bus.ts             车身视图：加载 bus.glb，驱动车门/车轮/扶手高亮/车壳淡出
    scenery.ts         车外世界：滚动路面、实例化楼房树木、始发站、中途站
    models.ts          glTF 预载与材质转换
    actors.ts          占位人偶 + 影子/昵称/抓环/摔下车演出/挡视线淡出
    cabin.ts           车身姿态：刹车点头、转弯侧倾、行驶颠簸（纯视觉）
  ui/
    hud.ts             对局 HUD（拥挤度/时间/存活/冷却）
    screens.ts         大厅选角 + 结算
  core/
    input.ts           摇杆/按钮/键盘统一输入
    math.ts            二维向量与插值
  config/
    balance.ts         数值初稿
    characters.ts      8 名角色与技能
    events.ts          随机事件池
~~~

## 当前进度

- [x] 平台切换为网页（横屏自适应 + 全屏）
- [x] 占位原型：车厢、站台、座位、扶手、车门、占位人偶（车厢与场景已被下面的 Blender 模型替换）
- [x] 完整一局循环：上车 → 行驶/停站 → 终点摇摆 → 结算
- [x] 移动/冲刺/推挤/抓扶手/技能/表情
- [x] 8 角色 + 7 机器人补位、随机事件、拥挤度、淘汰与返场
- [x] 车身与车外场景：Blender 程序化建模（红色切顶玩具巴士 + 真 3D 街道，行驶时路面/楼房/站台一起滚动）
- [ ] 替换为正式角色模型（src/view/actors.ts；坐姿对齐见其中的 SEAT_TOP / PELVIS_Y）
- [ ] 联机：Go 权威服务端 + WebSocket（见 docs/04-technical-design.md）
