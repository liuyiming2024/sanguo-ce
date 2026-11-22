# 率土式旬循环与 AI 对手落地说明

> 后台开发用 · 白话 · 不进游戏。
> 本轮主题由使用者一句话定下：「就是率土 like，然后你都也做」——即按外部评审提的四件（旬循环闭环、AI 对手、多档存档与失败态、素材署名页）全部做实，不改既定方向（两章、玩法与官渡本图相同、粮草只给大概档位、封面已收）。
> 游戏内只增加三个可点页面（旬计簿 / 素材致谢 / 终局）与系统页的三席存档控件；全部白话、系数、边界与台账留在本文件，不进 `config/historica.json`，不进典籍六门。

---

## 一、先纠正评审里三处过时判断

外部评审扫的是较早快照，夸架构那部分基本对（逻辑层零位图、确定性 RNG 进快照、双时钟、A\* 连通），但三条事实已经不成立：

| 评审说法 | 实测 | 处置 |
| --- | --- | --- |
| 「产出端没接上，缺粮 debuff 就差真的会发生」 | `collectResources()` 一直在跑，但 `advanceTurn()` 里**每座城各加一次全势力总产量**（`c.grain += yieldByOwner[c.owner].grain`），官渡 9 城等于把 944.7 粮记 9 遍；再怎么扣驻军耗粮都花不完 | 改为按各城所辖己方地块数**分摊**，驻军 / 在途按旬扣，断粮真实生效 |
| 「加一个纯逻辑 `src/ai.js` 很干净」 | `src/ai.js` 确实不存在，但 `campaign.js` 里一直有内联 AI：每 2 旬一次、只有铺路与打最近敌城两招 | 抽成纯逻辑层，改每旬一策、四类权重分桶 |
| 「一旦上线就是许可证违约」 | `src/ink-stroke.js` 头、`src/guandu.js` 头、`demos/third-party/ATTRIBUTION.md` + 两份 LICENSE 全文都在，MIT 的「保留声明与许可全文」已履行大半 | 定性降一档：**玩家看不见**才是真缺口；补一页游戏内致谢，不写成「上线即违约」 |

另核到：67 commit 准；单测不是 121，本轮前是 178；`src/` 里 6 处 `Math.random` 字样中 5 处是「无 Math.random」的注释宣言，唯一实际调用在 `ticket-store.js` 的短号回退随机源（可注入 rng、单测走注入），策略 / 战斗层确实零随机，但「全库严格零」不准确。

---

## 二、逐文件台账

| 文件 | 本轮动作 | 口径 |
| --- | --- | --- |
| `src/economy.js` | 新增 | `settleXun()` 一旬结算、`xunLedger()` 只读汇总、`canAffordTroops()` 发令约束、`shortageReport()` 战报；纯逻辑，零 DOM / 墙钟 / 随机 |
| `src/ai.js` | 新增 | `planAiTurn()` 只出 spec 不写 state、`AI_WEIGHTS` 四类权重、`isGranaryCity()`、`describeAiPlan()`；全部随机经注入 rng |
| `src/save-slots.js` | 新增 | 三席 + 备份 + 坏档救援 + meta；localStorage 不可用时静默降级 |
| `src/outcome.js` | 新增 | `checkOutcome()` 只读判定、`outcomeSummary()`；不进指纹、不进命令日志 |
| `src/campaign.js` | 改 | `issueOrder()` 加军粮校验；`advanceTurn()` 用 `settleXun()` 替换旧重复记粮；内联 AI 换成 `planAiTurn()` |
| `src/persist.js` | 改 | `commissary` 进存档 / 读档，旧档懒初始化 |
| `src/main.js` | 改 | 三席 actions、通用读档装配 `applyLoaded()`、旬末断粮战报与终局弹层、`window.__sanguo` 暴露 `xunLedger / checkOutcome / listSlots / readSlot` |
| `src/ui-shell.js` | 改 | 新增 `pageLedger / pageCredits / pageOutcome`；系统页加三席控件与卷帙入口；事件分发加 9 个 case |
| `src/ink-stroke.js`、`src/guandu.js` | 改头部 | 许可证路径纠正为 `demos/third-party/…`；guandu 补上游 MIT 声明与致谢页锚点 |
| `styles/main.css` | 改 | `.creditsLicense` 等宽小字整段留白；`#slotPanels .cmdGroup` 小按钮换行 |
| `scripts/check-map.mjs` | 改 | 追加本轮护栏：旧重复记粮 / 旧 AI 不许回潮、四文件接线、MIT 三处署名、版本唯一源、明文泄露 |
| `scripts/smoke.mjs` | 改 | 补 6 条真浏览器点按（三席 / 三页 / 推一旬入账） |
| `tests/economy.test.mjs` 等 4 个 | 新增 | 22 条纯逻辑断言 |

**刻意不动**：`config/campaign.json` 数值、`src/sync.js`、`src/rng.js`、`src/terrain.js`、`src/pathfind.js`、`src/battle-session.js`、素材 / 画风、`index.html` 开场、`release.html` 刊行记、`config/historica.json` 六门文言、`src/version.js`（仍 `0.9.4`、大版本号 `0`）。

---

## 三、旬循环数值口径

| 项 | 值 | 说明 |
| --- | --- | --- |
| 产量分摊权重 | 各城所辖己方地块数；无地城按 `pop/10000` 兜底 | 一次遍历建索引，避免 32 城 × 15552 格逐城 reduce |
| 围城产量 | ×0.45 | 沿用旧口径 |
| 驻军耗粮 | `garrison × 0.12` / 旬 | 与 `cfg.hidden.grainUpkeepPerUnitTurn` 同源 |
| 在途耗粮 | `troops × 0.18` / 旬 | 按发令城归集，从该城城仓扣 |
| 势力库存配给 | 耗粮合计 × 0.22 / 旬 | `state.resources[f].grain` 才是发令时真正扣的那本账；见底为 0，不写负数 |
| 断粮 | 城仓 < 0 → `starving=true`、军心 −2.2/旬、连续 2 旬后每旬逃兵 1.5% | 恢复供粮即清零 `starveTurns` |
| 发令锁 | `shortageTurns >= 2` 时拦 `recruit / march / transfer / garrison / reinforce` | 放行 `claim / develop / buildFort / scout / withdraw / fireDirectional / stratagem` |
| 账面储备 | `startReserve=600` 起按净额累加 | **只作展示，不参与锁**；真实约束看城仓是否断粮 |

两本账分工：城仓管城池死活（军心 / 逃兵），势力库存管能不能出兵（发令扣费）。旧版两套账互不往来且都只涨不跌，所以「征兵还是屯田」没有代价。

**一个必须记住的实测**：开局曹方产粮 944.7、驻军 17460 耗粮 2095.2，净额天然为负。任何「从零起算的虚拟储备一负数就锁征发」的设计都会把正常开局全锁死，所以锁条件只看真实断粮城数，不看虚拟账。

---

## 四、AI 对手

| 桶 | 权重 | 行为 |
| --- | --- | --- |
| `expand` 扩地 | 0.40 | 占相邻无主高产田（无高产则退普通可通行格） |
| `defend` 守城 | 0.18 | 被围城优先就地征兵，否则随机己方城小额征兵 |
| `raid` 袭粮 | 0.17 | **直取粮仓城**（史注含「粮 / 仓 / 囤 / 粟」），不与纯距离混排 |
| `march` 出征 | 0.25 | 打几何最近敌城，兵力 `min(1200+rng.int(900), 30% 守军)` |

- 每旬一策（旧为每 2 旬）；在途命令达 `maxConcurrentPerFaction` 时本旬不动。
- rng 消耗顺序固定：`pick(己方城) → next() 分桶 → 分支内各自消耗`，不受 UI 影响。
- 只返回 spec，落库仍走 `issueOrder()` → 同一条命令日志；**不聪明、可预测、有变数**，符合单机异步版的最低可用线。
- 袭粮最初写成「先找地占，占不到才打城」，实测 40 个 seed 从未选中粮仓城 —— 红测抓到后改为直取，护栏与单测一并守住。

---

## 五、三席存档与终局

- 甲 / 乙 / 丙三席 + 本机自动档并存，互不影响。写入前 `backupSlot()` 把上一份可用档复制成 `:bak`；`meta` 单列（存时 / 回合 / 图幅 / 城数 / 势力），列档不反序列化整局。
- 坏档：JSON 解析失败或 `v!==1` → 标 `corrupt`，**原文不删**，能回退备份就给一键回退；`deleteSlot()` 连带清备份与 meta。
- 结构校验只认最小契约（`v/turn/cities/tiles/rng`），不猜字段；localStorage 不可用全部静默降级，不影响开局。
- 终局三态：己方城尽失 → 败；敌城尽取 → 胜（章回可续、不强制结档）；全境断粮且守军崩溃 → 粮尽众散。判到终局即停自动推进、只弹一次，给「读本机自动档 / 查看三席 / 新开一局」三条路，**不偷偷重开**。`outcomeShown` 读档时复位。
- `commissary` 进存档；终局判定纯只读，**不进 `stateFingerprint`**，旧军令帖指纹不变。

---

## 六、素材署名（玩家可见）

`src/ui-shell.js` 的 `pageCredits()` 在系统页「卷帙」组可点开，含：

- 原作者声明 `MIT License / Copyright (c) 2018 Lingdong Huang`；
- 两份 LICENSE 同文**全文**（`THE SOFTWARE IS PROVIDED "AS IS" …` 完整保留）；
- 两个上游项目与引入函数逐条对照；
- 改动清单（去全局 CTX、法向差分、等弧长重采样、Canvas 路径输出）与自撰部分（hardRibbon / doubleOutline / 全部地物生成逻辑）分列；
- 「单独复制 `src/ink-stroke.js` 须连同两份 LICENSE」的再分发提示。

`ink-stroke.js` 头原本写「同目录 LICENSE…」是错的（LICENSE 实际在 `demos/third-party/`），已纠正；`guandu.js` 头补上游声明与致谢页锚点。静态自检对源码头 / 玩家可见页 / 许可全文三处同时设护栏，缺一即红灯。

---

## 七、验证

| 项 | 结果 |
| --- | --- |
| `node --test tests/*.mjs` | **200 / 200**（原 178 + 本轮 22） |
| `node scripts/check-map.mjs` | 全绿（新增 20 余条护栏） |
| `node scripts/smoke.mjs`（真 Chromium） | **163 / 163**（原 157 + 本轮 6） |
| 确定性重放 | 同 seed 同命令序列，`commissary` 逐字段、各城仓逐字段一致 |
| 版本 | `src/version.js` 唯一 `0.9.4`，大版本号 `0`，全库无 `?v=` 硬编码戳 |

中间红灯三次，都是真问题不是测试写歪：袭粮分支退化成扩地、旬计簿缺驻军字段、分摊断言把净额当毛额；另有 `check-map.mjs` 里 `shellSrc` 重复声明与 AI 注释被误判为 `Math.random` 调用，均已修正。

---

## 八、未闭环（如实）

1. **长局平衡没试玩**：系数（0.12 / 0.18 / 0.22 / 1.5%）是按开局量级定的，未做 100 旬以上的人工对局；「征兵还是屯田」有了代价，但代价曲线是否好玩未验证。
2. **AI 不聪明**：无同盟、无外交、无多目标协同、不评估胜负概率；袭粮只认史注里的粮仓城，不真的算对方粮道。
3. **三席受本机存储容量约束**：每席是完整 `serializeGame`（差异格压缩后通常几十到几百格），浏览器 localStorage 5MB 上限未做容量预警。
4. **终局不含章回终局**：第十回之后仍是「自由经略」，无第十一回；`checkOutcome` 只判城池与粮尽，不判章回完成度。
5. **断粮战报按 `state.turn` 去重**，不是真实日历；自动推进连续多旬时只推一条。
6. 17 张实拍像素、两份会话副本边界、软著登记受理口径，均为旧账，见 `docs/建安五年官渡舆图史料汇总.md` §16.6。

## 九、文白分工

白话、系数、边界、逐文件台账、验证与未闭环全留本文件；游戏内只给：旬计簿的数字与一句「可预测，但有变数」、致谢页的许可全文、终局页的文言标题（「行台已失」/「河北粗定」/「粮尽众散」）。**不往典籍六门加条目，不动 `config/historica.json`。**

---

## 十、长局对演与系数二次定标（C1 兑现度）

`scripts/longrun.mjs` 是纯逻辑长局对演：零 DOM、零墙钟、多 seed 各跑 200 旬、每 20 旬采样一次，只把病态暴露成数字，不「证明平衡」。

### 10.1 第一次对演：C1 做完了，但承诺没兑现

按 `79306f0911` 的系数跑 200 旬 × 5 seed，五个 seed 结果几乎一样：

| 观测 | seed 7 / 200 旬 | 结论 |
| --- | --- | --- |
| 首次断粮旬 | **−1（从未发生）** | 「让缺粮真的会发生」没兑现 |
| 势力库存 | 484 → 80 213，单调涨 | 产粮永远花不完 |
| 旬计簿 `reserve` | −550 → **−341 072** | 与顶栏库存两本账，互不相干 |
| 断粮城数 / 军心 | 0 / 72 → 67 | `condition.js` 的档位形同虚设 |
| 城数 / 终局 | 9 : 3 纹丝不动 / 无 | 无限重玩其实是「无限空转」 |
| AI 落令 | 322 条 | 全在扩地与出征，从不改变战线 |

三条根因：

1. **城仓太满**：`createCampaign()` 按 `pop × 2.4` 给城仓，许都约 22 万粮；而 `grainUpkeepPerUnitTurn = 0.12`、守军约 1.7 万，一旬才吃 2 095 粮，200 旬也耗不完。
2. **两本账分叉**：`collectResources()` 每旬把全境产粮入 `state.resources[f].grain`（顶栏「粮」），`settleXun()` 又另把「净额」累加进 `commissary[f].grain` 当旬计簿 `reserve`。前者涨到 8 万、后者跌到 −34 万，玩家看哪一个都不对。
3. **配给只扣 22%**：`rationRate = 0.22` 意味着驻军口粮八成凭空消失，库存只进不出。

### 10.2 二次定标改了什么

| 处 | 旧 | 新 | 理由 |
| --- | --- | --- | --- |
| `config/campaign.json` `hidden.grainUpkeepPerUnitTurn` | 0.12 | **0.035** | 与领地旬产粮同量级；常态略盈，征兵 / 出征才把账推成赤字 |
| `createCampaign()` 城仓初值 | `pop × 2.4` | **`garrison × upkeep × fullTurns`** | 与 `condition.js`「存粮可支撑旬数 / 30 旬」逐字同源，开局约满仓 |
| `issueOrder()` 征兵成本 | `total × 3` | **`total × upkeep × 6`** | 一次 500 兵吃掉约两成城仓，征兵真有代价 |
| `COMMISSARY.rationRate` | 0.22 | **1.0** | 产粮入账后整份扣回耗粮，库存＝历旬结余 |
| `COMMISSARY.fieldUpkeep` | 0.18 | **0.07** | 在途约为驻军两倍口粮，不再是 1.5 倍 |
| 旬计簿 `reserve` | `acct.grain`（虚拟账） | **`state.resources[f].grain`** | 与顶栏、发令扣费、配给扣粮同一份，逐字可对 |
| `shortageTurns` | `starvingCities > 0 && net < 0` | **`starvingCities > 0`** | 大城亏 / 小城盈时总账仍可能为正，饿着的那座城不该被「全局余粮」放过 |
| `src/ai.js` 目标 | 只按经纬度距离 | **目标评分**（距离 + 守军/1200 + 城防/200 − 粮仓加成） | 旧版「最近但守军七千的坚城」永远压过「稍远的空城」，像闭眼撞墙 |
| `src/ai.js` 断粮 | 照常硬征兵 / 硬出征（必被拒） | **`planRelief()`**：抢高产田 → 撤在途 → 休整一旬 | `aiRejected` 不再一旬旬空转 |
| `campaign.js` `stats` | 无 | **`aiRejected`** | 长局可观测「AI 白想了几策」 |

### 10.3 第二次对演（改完后，200 旬 × 2 seed）

| 观测 | seed 7 | seed 31 |
| --- | --- | --- |
| 首次断粮旬 | **69** | **66** |
| 断粮城数（200 旬） | 1–2 座 | 1–3 座 |
| 军心 | 72 → 44 后稳住 | 72 → 44 后稳住 |
| 库存 / 旬计簿 `reserve` | 334 → 45 372，**两数逐旬相等** | 334 → 45 910，相等 |
| 旬净额 | +333 → +51，始终为正但持续收窄 | 同 |
| AI 落令 / 被拒 | 218 / 19（前期，后期不再涨） | 208 / 26（同） |
| 终局 | 无 | 无 |

「缺粮真会发生」兑现了：不动作时库存缓慢攒、城仓逐步见底，约 70 旬后局部断粮、军心下滑、AI 转救荒。

### 10.4 仍然存在的边界（不硬修）

- **库存单调涨、城数 200 旬纹丝不动**：玩家什么也不做时产 806 > 耗 611，永远略盈；AI 的 `march` 到达后**不自动结算攻城**（要玩家进子界面），所以只有 3 次开战记录、战线不变。接自动结算会动 `battle-session.js` 与双时钟，属于新方向，不在这轮动。
- **无终局**：三态判定都在，但长局自然演化到不了；「可无限重玩」目前是「可无限推进」，不是「可反复决出胜负」。
- **系数由对演定标，未人工试玩 100 旬以上**；0.035 / 0.07 / 1.0 是量级校准，不是手感定稿。
- **AI 仍不聪明**：无同盟 / 外交 / 多目标协同 / 胜负概率评估；袭粮只认史注粮仓城，不真的算对方粮道。

### 10.5 回归护栏

`tests/longrun.test.mjs`（120 旬 × 2 seed，8 条）把上面三条病态钉成红灯：城仓初值同源、产耗同量级、120 旬内必须断粮、`reserve === 真实库存`、AI 后半程不再空转、同 seed 双跑逐字段一致、目标评分软优于坚、断粮只出救荒策。`scripts/check-map.mjs` 另守静态口径：`pop × 2.4` / `total × 3` / `rationRate: 0.22` / `acct.grain =` 一律不许回潮。
