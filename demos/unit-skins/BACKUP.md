# 重绘之前的备份 · 单位样式（第十九轮）

> 用户要求：「为了防止你重绘的太差，所以让你保存以前的，然后以一个类似于
> 皮肤的方式来呈现」。备份在**写任何一行重绘代码之前**就做完了。

## 备份点（真实存在）

| 项 | 值 |
| --- | --- |
| 远端分支 | **`backup/pre-unit-skin-a00e4683`** → `a00e468367ef3e3cb3c08c5b956af92e2550e84a` |
| 创建时机 | 本轮所有改动之前，指向当时的 main，不随 main 前进 |
| 更早的备份 | `backup/pre-multi-skin-cd7ef484`、`backup/pre-skin-d25542b9` 仍在 |
| 实体快照 | `士兵立绘-基线.js`（`src/soldier.js`）、`将领立绘-基线.js`、`主地图回退-基线.js`、`位图层-基线.js` |
| 版本 | `0.9.4`，未动 |

四份基线 js 的 sha256：

- `004b70bb…` 主地图回退（map-render.js）
- `ca722389…` 士兵立绘（soldier.js）
- `a4539ae4…` 将领立绘（general-portrait.js）
- 位图层快照同目录可查

## 回退方式（三选一）

- **只看旧画面**：游戏内「系统 → 单位样式」或对照页下拉选 **A 现行立绘**。
  位图原版与程序化回退都原封不动。
- **只拿旧文件**：直接取本目录四份 `*-基线.js`（可与 `src/` 逐字节比对）。
- **整仓回退**：`git checkout backup/pre-unit-skin-a00e4683 -- .`。

## 为什么 A 一定还是原来那一张

`src/soldier.js` / `src/general-portrait.js` **一个字节没改**。`src/city-view.js`
与 `src/map-render.js` 只改了 import 路径（指向 `unit-skin.js` 的同名导出）与
一行回退分派，**所有调用语句的文本原样保留**——静态自检里那几条精确断言
（`export function drawSoldier\(ctx, u, o\)`、`drawSoldier\(ctx, u, \{`、
`portraits\.ready && portraits\.draw\(ctx, \{ \.\.\.common`）全部仍命中。

`unit-skin.js` 的 `classic` 分支直接转调原函数，
`tests/unit-skin.test.mjs` 用记录型 fake ctx 断言 **逐命令一致**：
四类单位 × 四档尺度、将领、主地图简笔都过。切到 F 再切回 A 仍一致。

`portrait.js` 只加了一行闸门（非 A 档让出画面），A 档这一行直接跳过，
四张 sprite sheet 的加载逻辑没动。

## 本轮改了什么（最小侵入）

- 新增 `src/unit-redraw.js`（五套重绘）、`src/unit-skin.js`（皮肤表 + 同名分派入口）
- `city-view.js`：三个 import 改路径，调用文本零改动
- `map-render.js`：`inkTrooper` 开头一行分派
- `portrait.js`：闸门一行
- `main.js` / `ui-shell.js`：系统页六个按钮 + `markDirty()` 强制重画一帧
- `demos/单位样式皮肤.html`：对照页
- `tests/unit-skin.test.mjs`：9 项新断言

**逻辑层、存档、确定性重放、命令日志、状态指纹、地图底图、势力层一律没碰。**
