/* ink-stroke.js — 变宽多边形笔触原语
 *
 * 移植并改写自以下两个 MIT 项目（版权声明按要求原样保留）：
 *   MIT License
 *   Copyright (c) 2018 Lingdong Huang
 *
 *   · LingDong-/shan-shui-inf  index.html   函数 stroke() / poly() / loopNoise()
 *   · LingDong-/nonflowers     main.js     函数 tubify() / stroke() / polygon()
 *
 * 许可证全文：同目录 LICENSE-shan-shui-inf.txt / LICENSE-nonflowers.txt
 * 来源与改动清单：同目录 ATTRIBUTION.md
 *
 * 改写内容（不改动原许可证义务）：
 *   1. 去掉 DOM / 全局 CTX 依赖，改为显式传入 CanvasRenderingContext2D；
 *   2. 沿点列按法向左右推宽度后闭合成多边形，一次 fill —— 保留原实现核心结构；
 *   3. 原 stroke() 的法向角修正 (a < a2 时 +PI) 在折返点偶有跳变，改为统一由
 *      前后点差分的垂直向量给出，结果等价但稳定；
 *   4. 增加等弧长重采样、head/tail 笔压曲线、butt 帽飞白、方折宽度函数；
 *   5. 新增分区平涂 / 双勾水线 / 硬折轮廓，属本仓库自撰，非上游代码。
 *
 * 用法（普通 <script> 引入，挂到 window.InkStroke）：
 *   InkStroke.resample(points, 4)
 *   InkStroke.ribbon(ctx, points, {w, col, alpha, head, tail, dry, bristles})
 *   InkStroke.hardRibbon(ctx, points, {...})   方折 / 斧劈
 *   InkStroke.frames(points)
 */
(function (root) {
  'use strict';

  // ── 基础 ──────────────────────────────────────────────────────────────
  const smooth = t => t * t * (3 - 2 * t);
  const clamp01 = x => Math.min(1, Math.max(0, x));

  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // Catmull-Rom 加密（Nonflowers/shan-shui-inf 用 bezmh / densify 同类思路）
  function densify(pts, step) {
    step = step || 3;
    if (pts.length < 3) return pts.map(p => p.slice());
    const P = i => pts[Math.max(0, Math.min(pts.length - 1, i))];
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
      const n = Math.max(6, Math.round(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
      for (let j = 0; j < n; j++) {
        const t = j / n, t2 = t * t, t3 = t2 * t;
        out.push([
          .5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          .5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
        ]);
      }
    }
    out.push(pts[pts.length - 1].slice());
    return out;
  }

  // 等弧长重采样：不让飞白噪声频率随笔画长短变化
  function resample(pts, step) {
    step = step || 4;
    const d = densify(pts, 3), acc = [0];
    let total = 0;
    for (let i = 1; i < d.length; i++) {
      total += Math.hypot(d[i][0] - d[i - 1][0], d[i][1] - d[i - 1][1]);
      acc.push(total);
    }
    if (total < step) return d;
    const out = []; let j = 1;
    for (let s = 0; s <= total; s += step) {
      while (j < acc.length - 1 && acc[j] < s) j++;
      const t = (s - acc[j - 1]) / ((acc[j] - acc[j - 1]) || 1);
      out.push([
        d[j - 1][0] + (d[j][0] - d[j - 1][0]) * t,
        d[j - 1][1] + (d[j][1] - d[j - 1][1]) * t,
      ]);
    }
    out.push(d[d.length - 1].slice());
    return out.length > 3 ? out : d;
  }

  function frames(P) {
    return P.map((p, i) => {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1];
      const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      return { x: p[0], y: p[1], tx, ty, nx: -ty, ny: tx };
    });
  }

  // 笔压：起笔渐入、收笔减约 70%、噪声给 ±7.5% 粗细抖动
  function profile(q, o, nz) {
    const head = o.head == null ? .12 : o.head;
    const tail = o.tail == null ? .40 : o.tail;
    return smooth(clamp01(q / (head || .001))) *
           (1 - .7 * smooth(clamp01((q - (1 - tail)) / (tail || .001)))) *
           (.85 + .15 * nz(q));
  }

  // ── 核心：变宽多边形（源自 tubify / stroke） ─────────────────────────
  // 沿点列每点取法向，左右各推 w(q)，首尾封口，闭合成多边形一次 fill。
  // 这正是「笔」与「等宽线」的分界：收笔能收出尖，边缘有墨的厚薄。
  function ribbon(ctx, pts, o) {
    o = o || {};
    if (!pts || pts.length < 3) return;
    const w = o.w == null ? 4 : o.w;
    const col = o.col || '#33342c';
    const alpha = o.alpha == null ? .7 : o.alpha;
    const dry = o.dry || 0;
    const bristles = o.bristles || 0;
    const sk = o.sk || 0;
    const nz = q => (.5 + .5 * Math.sin(q * 30 + sk * 1.7) * Math.sin(q * 11.3 + sk * .9));
    const F = frames(pts), n = pts.length;
    const wf = o.widthFn || (q => w * profile(q, o, nz));

    const A = [], B = [];
    for (let i = 0; i < n; i++) {
      const ww = wf(i / (n - 1)), f = F[i];
      A.push([pts[i][0] + f.nx * ww, pts[i][1] + f.ny * ww]);
      B.push([pts[i][0] - f.nx * ww, pts[i][1] - f.ny * ww]);
    }
    ctx.save();
    if (o.bleed) ctx.filter = `blur(${o.bleed}px)`;
    ctx.beginPath(); ctx.moveTo(A[0][0], A[0][1]);
    for (const p of A) ctx.lineTo(p[0], p[1]);
    for (let i = B.length - 1; i >= 0; i--) ctx.lineTo(B[i][0], B[i][1]);
    ctx.closePath();
    ctx.fillStyle = rgba(col, alpha * (1 - .28 * dry));
    ctx.fill();
    if (o.bleed) ctx.restore(); else ctx.restore();

    // 飞白：每根笔毛一条连续 path + butt 帽（分段 stroke 会叠出竹节）
    if (bristles > 1 && dry > 0) {
      ctx.save(); ctx.lineCap = 'butt';
      for (let j = 0; j < bristles; j++) {
        const off = (j / (bristles - 1) - .5) * .95;
        let pen = false; ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const q = i / (n - 1), f = F[i], ww = wf(q);
          const x = pts[i][0] + f.nx * ww * off, y = pts[i][1] + f.ny * ww * off;
          const t = .5 + .5 * Math.sin(i * .47 + j * .09 + sk * 3.1);
          if (t < dry * Math.pow(q, 1.2) * .95 + .05) { pen = false; continue; }
          if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = rgba(col, alpha * .5);
        ctx.lineWidth = Math.max(.45, w / (bristles * 1.7));
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // 方折 / 斧劈：宽度取阶跃 + 短斜过渡，不用 sin 平滑，读起来有棱角。
  // 自撰，非上游代码。
  function hardProfile(q, o, nz) {
    const seg = o.seg || 5;
    const k = Math.floor(q * seg);
    const local = q * seg - k;
    const base = .38 + .62 * (1 - k / seg);           // 下笔重、收笔轻
    const stepUp = local < .12 ? local / .12 : 1;     // 短斜起笔
    return base * stepUp * (.88 + .12 * nz(q));
  }

  function hardRibbon(ctx, pts, o) {
    o = Object.assign({}, o);
    const w = o.w == null ? 3 : o.w;
    const sk = o.sk || 0;
    const nz = q => .5 + .5 * Math.sin(q * 47 + sk * 2.3);
    o.widthFn = o.widthFn || (q => w * hardProfile(q, o, nz));
    return ribbon(ctx, pts, o);
  }

  // 双勾 + 水线：内外两线，中间留一线纸白。工笔白描的基本单元。
  // 自撰，非上游代码。
  function doubleOutline(ctx, P, o) {
    o = o || {};
    const gap = o.gap == null ? 2.2 : o.gap;
    const F = frames(P);
    const outer = P.map((p, i) => [p[0] + F[i].nx * gap, p[1] + F[i].ny * gap]);
    const inner = P.map((p, i) => [p[0] - F[i].nx * gap, p[1] - F[i].ny * gap]);
    hardRibbon(ctx, outer, Object.assign({ w: 1.0, col: '#4a4b3c', alpha: .62 }, o));
    hardRibbon(ctx, inner, Object.assign({ w: .7, col: '#6f6f5a', alpha: .34 }, o));
    ribbon(ctx, P, { w: .6, col: '#f5eed9', alpha: .5, head: .02, tail: .06, sk: o.sk || 0 });
  }

  // 分区平涂：一个 Path2D 上低 α 纯色叠 N 遍，层间不叠渐变。
  // 自撰，非上游代码。
  function flatWash(ctx, path, col, alpha, layers, jitter) {
    layers = layers || 2;
    for (let k = 0; k < layers; k++) {
      ctx.save(); ctx.clip(path);
      ctx.fillStyle = rgba(col, alpha / layers * (1 + (jitter ? jitter(k) : 0)));
      ctx.fillRect(-2000, -2000, 6000, 6000);
      ctx.restore();
    }
  }

  root.InkStroke = {
    rgba, smooth, densify, resample, frames, profile,
    ribbon, hardRibbon, hardProfile, doubleOutline, flatWash,
    stroke(ctx, P, o) { return ribbon(ctx, resample(P, (o && o.step) || 4), o); },
  };
})(typeof window !== 'undefined' ? window : this);
