# 三国策 · 军令帖（轻量验证版）

> **不是发布版**，是一个只用来验证「微信链路上能不能把一局传下去」的最小原型。
> 传帖台页不带战场、不带地图、不带策略层、不带结算；
> 另有一页「最小可玩切片」搬了**纯逻辑层镜像**，只验冷启动 / 推旬 / 读档，仍零位图、零 Canvas。
> 不放进 `sanguo-ce` 的 Web 主包；主工程只多了一层 `src/platform/` 宿主注入，渲染层一行没改。

## 它做什么

一局推进一旬后，网页版「导出军令帖」会给出一段 base64url 口令（含存档、状态指纹、命令日志尾）。本页只做四件事：

1. **读 / 粘**：从剪贴板读出或手工粘贴整段口令；
2. **校验**：本地解码，显示军历、刊本、图幅、旬次、指纹、命令尾条数、字符数；**不重放局面**；
3. **传**：复制到剪贴板 → 微信会话发给对方；或存本机最近 3 帖，点一下取回再复制；
4. **短号**：填六位短号可复制、可随近帖留存，分享卡片也带它（`?sid=`）；
5. **分享**：`onShareAppMessage` 给一张卡片，标题带短号或一句「有军令帖待传，接一旬」。

对方拿到口令，粘进本页校验，或粘回网页版「导入」接续一旬。

## 短号与「为什么不把口令塞进分享 path」

微信分享 `path` 的 query 有长度限制，一帖几千字符，整段塞进去会被截断、解不开。所以**整帖仍走剪贴板 / 会话粘贴**。

现在多一条短号链路：网页版旁边有独立的 [传帖台](../bridge.html)，把整帖存进一张表，换回六位短号。短号足够短，可以进分享 path、可以口头念、可以手抄。对方点开卡片会看到短号，到传帖台兑换整帖，再粘回网页版「导入」接续一旬。

**但本页不联网、不兑换**：小程序要访问外部服务就得配 request 合法域名，而第三方项目域名无法由本主体备案。所以短号在这里只是「看得见、复制得走」的文本，真正存取在 Web 传帖台。表结构、RLS、成本与合规口径见 `docs/军令帖短号中转说明.md`。

## 零外部依赖（刻意）

- 不用 `wx.request` / `wx.connectSocket`，因此**不需要 HTTPS 备案域名**，也用不上云开发配额；
- 零位图、零 `<image>`，主包只有几 KB 文本；
- `utils/ticket.js` 是纯 JS 的 base64url + 手写 UTF-8，不依赖 `TextEncoder` / `Buffer` / `btoa` / `atob`（小程序运行时没有）；
- `tests/miniprogram.test.mjs` 用 Node 同时 import 它与主工程 `src/sync.js`，对中文与增补平面字符断言**编码逐字一致、交叉解码无损**。

`Date.now()` 只用于「本机近帖」列表的显示时间，**不进入局面、不进口令、不参与任何判定**。

## 合规（未启动，别当结论）

- 所有小程序上线前要**小程序备案（ICP）**：主体证件、负责人人脸核验、`12381` 短信 24 小时内核验、通管局审核；
- 内容关联游戏，平台可能按**游戏类目**要求前置审批。个人主体只能走 **IAA**（不收费、不开虚拟支付）：代备案授权书、著作权自我声明、自审自查报告；开虚拟支付要版号，个人主体开不了；
- 游戏名别带英文或「软件」字样，否则触发补软著；签名别用连笔 / 毛笔签；
- `project.config.json` 里是 `touristappid`（开发者工具测试号占位），**真机预览与提审前必须换成自己的 AppID**。

本仓库只交代码，不代办备案、不承诺过审。

## 与主工程的关系

| | 网页版 | 传帖台页 | 色块切片页 | 画布页 |
| --- | --- | --- | --- | --- |
| 策略层（纯逻辑） | 全在 | **不在** | **镜像在** `logic/src/`（24 个 `.js`） | 同左 |
| 战斗层 / 舆图 / 结算 | 全在 | 不在 | **不在** | **不在** |
| 格网皮 | Canvas 2D 舆图 | 无 | WXML 色块（零 Canvas） | `<canvas type="2d">` + 绘制指令 |
| 军令帖编解码 | `src/sync.js` | `utils/ticket.js`（同逻辑副本） | 仍通 | 仍通 |
| 存档 | 三席 + 自动档 | 只存近帖 | 本机快照 + `onHide/onShow` | 不持久化 |
| 分发 | GitHub Pages | 微信开发者工具（未上传） | 同左 | 同左 |

逻辑层镜像由 `scripts/sync-miniprogram.mjs` 从主 `src/` 的 ESM 依赖闭包自动生成，
**不要手改** `logic/`；改了 `src/` 就跑 `npm run sync:mp`，`npm run check` 会拦住没同步的镜像。

主工程的 `Transport` 抽象仍留着；将来真做端侧，换一层 `CloudBaseTransport` 即可，不必改三层逻辑。但**皮要重写**（DOM/CSS/Canvas 2D → WXML/WXSS）、写实位图素材要挪云存储（主包 2MB 限制），这两件本版一行没做。

## 最小可玩切片（P2）

首页点「打开最小可玩切片」。三件事：**冷启动建局 → 推一旬 → 切后台回来逐字段一致**。
战报是文本，没有地图、没有 Canvas、没有结算层；`onHide` 把快照写进本机存储，`onShow`
读回并比对 `hashState`。逻辑层零墙钟，所以不需要另造快进。

宿主由 `src/platform/` 注入：浏览器走 `localStorage`，小程序走 `wx.*StorageSync`，
Node 走内存 `Map`；四个适配点是 storage / 指针归一 / 画布节点 / now·randomBytes 注入。
`app.js` 的 `onLaunch` 只做一次 `installHost({ wx })`，镜像逻辑层一行不用改。

## 零位图格网与 P4 包体

切片页的 `18×14` 色块格网由 `src/platform/mini-map.js` 从 `terrain.tiles` 确定性降采样而来：
有主格按势力着色、无主格按主导地貌给淡色、城池叠墨点。**不读任何 PNG、不用 Canvas**，
宿主只负责把色块摆出来（将来接 `wxCanvas` 时把 `miniMapOps` 的 `fillRect` 指令喂给 ctx 即可）。

包体核算（`npm run bundle`）的硬结论：首包约 0.21 MiB / 0 位图已成立，但运行时真正加载的
4 张 sheet 合计 13.32 MiB，其中 3 张**各自**超微信单个分包 2 MB —— 直接声明 `subpackages`
会失败，必须先压缩 / 降分辨率。只有 `trooper-tiny-sheet`（71 KB）能与逻辑层同进主包。
另外「按章分包两张舆图」不成立：舆图是 `guandu.js` / `atlas.js` 的程序化离屏画布，
仓库里没有 `bg+fg` 位图文件。10 张源底稿 JPG 与 48 张单帧 PNG 明确不进包。

## 画布格网（`pages/canvas/`）

同一份 `miniMapOps()` 归一化指令，换一层皮：`wxCanvas('#mini', wx)` 拿 canvas 2d 节点，
`applyDrawOps(ctx, ops, w, h, {dpr})` 把 `fillRect` / `circle` 画出来。两个函数都在
`logic/src/platform/canvas.js` 镜像里，纯函数、零宿主 API，Node 里用假 ctx 就能逐条验。
色块页仍是零 Canvas 的回归基线，两条路径互不干扰；画布页拿不到节点会如实报错并留一条
回色块页的路，不白屏。

## 压缩分包（待真机启用）

PNG 原样分包会失败（4 张 sheet 13.32 MiB，其中 3 张各自超微信单个分包 2 MB）。实测
sharp / PIL 转 webp q=80 后合计 **2.59 MiB**，按 `infantry`（1.65）/ `engine`（0.94）分两组
各 ≤ 2 MB，主包 + 分包 2.80 MiB。`assets-plan.json` 是唯一数字来源，
`app.subpackages.example.json` 是待启用模板。

```
npm run assets:build   # 生成 webp 到 miniprogram/assets/（.gitignore，不进仓库）
# 真机时把 app.subpackages.example.json 的 subpackages 数组并入 app.json
```

**现在 `app.json` 没有 `subpackages`**：空分包会在开发者工具报错，且 webp 在小程序端的
解码支持、端侧皮重写读 `.webp` 都没真机验证。详见 `docs/小程序军令帖验证说明.md` §十二。

## 跑起来

1. 微信开发者工具 → 导入项目 → 选本目录 → 用测试号或自己的 AppID；
2. 网页版复制一段军令帖，粘进输入框，点「校验」；或点首页按钮进切片页推几旬、看零位图格网；
3. 改过 `src/` 就先在仓库根跑 `npm run sync:mp`（生成镜像），再跑
   `npm test` / `npm run check` / `npm run bundle` / `npm run assets:plan`。

已知边界见 `docs/小程序军令帖验证说明.md` §十、§十一
（真机、ESM 转译、皮重写、真分包、webp 解码、主包实测均未启动）。
