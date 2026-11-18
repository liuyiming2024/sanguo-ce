# 第三方代码来源与改动清单

上一版把「无版权争议」理解成了「一律不引入代码」，过于保守，这里更正。

**MIT 允许 use / copy / modify / merge / publish / distribute / sublicense / sell，
唯一条件是：在所有副本或实质性部分中保留原版权声明与许可全文。** 它不要求衍生作品开源，
也不要求同许可证。因此上游代码可以直接用，只要履行署名义务。

本仓库 `liuyiming2024/sanguo-ce` 自身 `license: None`，这**不影响引入 MIT 代码**：
义务是「带上上游声明」，不是「本仓库必须也声明许可证」。只影响别人如何再分发本仓库整体，
届时随包带上本目录的两份 LICENSE 即可。GPL-3.0 项目（江山时序等）仍不引入。

---

## 已引入

| 上游 | 许可 | 引入的函数 | 落在哪 |
| --- | --- | --- | --- |
| `LingDong-/shan-shui-inf` `index.html` | MIT, Copyright (c) 2018 Lingdong Huang | `stroke()` 的「沿点列按法向左右推宽度 → 闭合多边形一次 fill」结构、`poly()` 的填充方式、`loopNoise` 的宽度扰动思路 | `ink-stroke.js` 的 `ribbon()` / `densify()` |
| `LingDong-/nonflowers` `main.js` | MIT, Copyright (c) 2018 Lingdong Huang | `tubify()` 的法向偏移 + 首尾封口、`stroke()` 默认宽度函数 `sin(xπ)·Noise.noise(x·10)`、`polygon()` | `ink-stroke.js` 的 `ribbon()` / `profile()` |

许可证全文：
- `LICENSE-shan-shui-inf.txt`
- `LICENSE-nonflowers.txt`

`ink-stroke.js` 文件头已保留 `MIT License / Copyright (c) 2018 Lingdong Huang` 声明。
若该文件被单独复制出去，须连同这两份 LICENSE 一起带走。

## 改动（MIT 允许 modify，此处如实列出）

1. 去掉上游对全局 `CTX` / DOM / SVG 字符串拼接的依赖，改为显式传 `CanvasRenderingContext2D`。
2. 上游 `stroke()` 用 `(a1+a2)/2` 再在 `a < a2` 时 `+PI` 求法向，折返处偶有跳变；
   改为由前后点差分直接取垂直向量，结果等价但稳定。
3. 新增等弧长 `resample()`、`head/tail` 笔压曲线、`butt` 帽多笔毛飞白。
4. 输出从 SVG 字符串改为 Canvas 路径。

## 自撰部分（非上游代码，不主张上游版权）

`hardRibbon()` / `hardProfile()`（斧劈、折带的方折宽度）、`doubleOutline()`（双勾 + 水线）、
`flatWash()`（分区平涂）、以及 `官渡舆图笔势重绘.html` 里全部地物生成逻辑
（山列、河、泽、城郭、村落、塔寺、桥舟、田畴、注记、界格），均为本仓库自撰。

## 只作阅读参考、未引入代码

`huashu-art-motion` 的 `17_ink` 参数表、`inkify` 的运笔节奏模型、
`JobinJia/shuimo-core` 的 `generateCunFaStrokes` 数据格式、
Way & Shih 2001 / 魏德乐论文的皴笔定义、故宫《十八描》与《平江图》研究 ——
这些只提炼为 `docs/毛笔笔势与古舆图参考资料.md` 里的自撰要点，没有复制源码或正文。
