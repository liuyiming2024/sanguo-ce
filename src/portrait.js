// 写实淡彩八向位图渲染层（v0.9.0）。
//
// 素材：8 向转身 × 3 相位（idle / stepL / stepR）= 24 帧，
// 打包成 assets/units/trooper-sheet.png 与 trooper-walk-sheet.png 两张 sprite sheet。
// 运行时只读、不生成、不改像素；加载失败或未就绪时 city-view 自动回退程序化路径。
// 加载状态不进 state、不进存档、不进命令日志、不进状态指纹。
//
// 用户口径：「他要走路啊，所以还需要更多」——走路不再靠整体 bob 假装，
// 而是按模拟时间的相位在左步/右步帧之间交替；上半身稳定，腿在动。
// 无墙钟、无 Math.random：同一 sec + heading + phase 永远画同一帧。
import { DIR8, dirIndex } from './direction.js';
import { VIEW } from './soldier.js';

const BASE = new URL('../assets/units/', import.meta.url);
const CW = 560, CH = 820;

/** 行走相位：0 静止 / 1 左步 / 2 右步。相位只取模拟时间派生值。 */
export function walkPhase(walk, phase) {
  if (!walk) return 0;
  return Math.sin(phase ?? 0) >= 0 ? 1 : 2;
}

export function createPortraits({ onReady } = {}) {
  let idleSheet = null, walkSheet = null;
  let ready = false, failed = false, pending = 2;

  function load(file, assign) {
    const img = new Image();
    img.onload = () => {
      assign(img);
      pending--;
      if (pending === 0 && !failed) { ready = true; onReady?.(); }
    };
    img.onerror = () => { pending--; failed = true; };
    img.src = new URL(file, BASE).href;
  }
  load('trooper-sheet.png', (im) => { idleSheet = im; });
  load('trooper-walk-sheet.png', (im) => { walkSheet = im; });

  function frameRect(heading, ph) {
    const d = dirIndex(heading ?? 0);
    // walk sheet 排布：每方向连续两帧 [L, R]
    return ph === 0
      ? { sheet: idleSheet, sx: d * CW, dir: d }
      : { sheet: walkSheet, sx: d * 2 * CW + (ph - 1) * CW, dir: d };
  }

  /**
   * 画一个写实人形单位。返回 false 表示未就绪/不适用，调用方应回退程序化。
   * @param o {x,y,s,heading,walk,phase,amp,selected,champion,hp}
   */
  function draw(ctx, o) {
    if (!ready) return false;
    const ph = walkPhase(o.walk, o.phase);
    const { sheet, sx } = frameRect(o.heading ?? 0, ph);
    if (!sheet) return false;

    const { x, y, s } = o;
    const h = s * 1.62;           // 全身像在格子里要站得住，别缩成小人点
    const w = h * (CW / CH);
    const dh = h * (0.82 + VIEW.cos * 0.18);   // 斜俯视纵向压缩，脚底贴地
    const bob = o.walk ? Math.sin((o.phase ?? 0) * 1.8) * 0.45 * (o.amp ?? 1) * (s / 20) : 0;

    ctx.save();
    // 地面投影由渲染层画，不烧进素材
    ctx.fillStyle = 'rgba(10,18,16,.34)';
    ctx.beginPath();
    ctx.ellipse(x, y + 1.4, w * 0.30, Math.max(1.4, s * 0.11), 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.translate(x, y + bob);
    ctx.drawImage(sheet, sx, 0, CW, CH, -w / 2, -dh, w, dh);
    ctx.restore();

    const hp = Math.max(0, Math.min(1, o.hp ?? 1));
    const by = y - dh - s * 0.12;
    if (hp < 0.999 || o.selected || o.champion) {
      const bw = s * 0.62, bh = Math.max(1, s * 0.07);
      ctx.fillStyle = 'rgba(10,14,12,.3)'; ctx.fillRect(x - bw / 2, by, bw, bh);
      ctx.fillStyle = hp > 0.5 ? 'rgba(82,110,96,.6)' : 'rgba(146,78,54,.85)';
      ctx.fillRect(x - bw / 2, by, bw * hp, bh);
    }
    if (o.selected || o.champion) {
      ctx.strokeStyle = o.champion ? 'rgba(200,168,106,.9)' : 'rgba(178,202,194,.75)';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.ellipse(x, y + 1.4, w * 0.34, Math.max(1.8, s * 0.14), 0, 0, Math.PI * 2);
      ctx.stroke();
      if (o.champion) {
        const my = y - dh - s * 0.42;
        ctx.fillStyle = 'rgba(200,168,106,.95)';
        ctx.beginPath();
        ctx.moveTo(x, my - s * 0.28); ctx.lineTo(x + s * 0.12, my - s * 0.16);
        ctx.lineTo(x, my - s * 0.04); ctx.lineTo(x - s * 0.12, my - s * 0.16);
        ctx.closePath(); ctx.fill();
      }
    }
    return true;
  }

  return {
    draw,
    get ready() { return ready; },
    get failed() { return failed; },
    get loaded() { return (idleSheet ? 1 : 0) + (walkSheet ? 1 : 0); },
    frameFor: (heading) => DIR8[dirIndex(heading ?? 0)],
    walkFrameFor: (heading, phase) => {
      const ph = walkPhase(true, phase);
      return `${DIR8[dirIndex(heading ?? 0)]}-${ph === 1 ? 'L' : 'R'}`;
    },
    phaseFor: (walk, phase) => walkPhase(walk, phase),
  };
}
