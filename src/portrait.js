// 写实淡彩位图渲染层（v0.9.2）。运行时只读、不生成像素、不进 state /
// 存档 / 命令日志 / 状态指纹；加载失败自动回退程序化路径，不白屏。
//
// 四张 sheet：
//   trooper-sheet.png       人形 8 向 idle（真转身）
//   trooper-walk-sheet.png  人形 8 向 × 左右步
//   engine-sheet.png        床弩 / 抛石机各 8 向（刚体旋转投影派生）
//   trooper-tiny-sheet.png  手机 s<13 档轮廓增强小帧
// 无墙钟、无 Math.random：同一 sec + heading + phase 永远画同一帧。
import { DIR8, dirIndex } from './direction.js';
import { VIEW } from './soldier.js';

const BASE = new URL('../assets/units/', import.meta.url);
const CW = 560, CH = 820, TW = 72, TH = 108;

/** 58° 斜俯视：立绘高度按 cos58 压到地面平面，再补一层可见厚度。 */
export function projectedHeight(h) { return h * (VIEW.cos + 0.28); }
/** 地面斜轴：竖直高度带来的水平位移，破掉「正面证件照正对」的对称感。 */
export const GROUND_SHEAR = -0.17;

export function walkPhase(walk, phase) {
  if (!walk) return 0;
  return Math.sin(phase ?? 0) >= 0 ? 1 : 2;
}

export function createPortraits({ onReady } = {}) {
  const sheets = { idle: null, walk: null, engine: null, tiny: null };
  let ready = false, failed = false, pending = 4;

  function load(file, key) {
    const img = new Image();
    img.onload = () => {
      sheets[key] = img;
      pending--;
      if (pending === 0 && !failed) { ready = true; onReady?.(); }
    };
    img.onerror = () => { pending--; failed = true; };
    img.src = new URL(file, BASE).href;
  }
  load('trooper-sheet.png', 'idle');
  load('trooper-walk-sheet.png', 'walk');
  load('engine-sheet.png', 'engine');
  load('trooper-tiny-sheet.png', 'tiny');

  function trooperFrame(heading, ph) {
    const d = dirIndex(heading ?? 0);
    return ph === 0
      ? { sheet: sheets.idle, sx: d * CW, sw: CW, sh: CH }
      : { sheet: sheets.walk, sx: d * 2 * CW + (ph - 1) * CW, sw: CW, sh: CH };
  }
  function engineFrame(heading, which) {
    const d = dirIndex(heading ?? 0);
    const base = which === 'trebuchet' ? 8 : 0;
    return { sheet: sheets.engine, sx: (base + d) * CW, sw: CW, sh: CH };
  }
  function tinyFrame(heading) {
    const d = dirIndex(heading ?? 0);
    return { sheet: sheets.tiny, sx: d * TW, sw: TW, sh: TH };
  }

  /**
   * @param o {x,y,s,heading,walk,phase,amp,selected,champion,hp,kind,engine}
   *   kind='engine' 走器械 sheet；s<13 优先 tiny sheet（除非是器械）。
   */
  function draw(ctx, o) {
    if (!ready) return false;
    const engine = o.kind === 'engine';
    const tiny = !engine && (o.s ?? 20) < 13 && !!sheets.tiny;
    const ph = engine ? 0 : walkPhase(o.walk, o.phase);
    const fr = tiny ? tinyFrame(o.heading)
      : engine ? engineFrame(o.heading, o.engine)
        : trooperFrame(o.heading ?? 0, ph);
    if (!fr.sheet) return false;

    const { x, y, s } = o;
    const h = s * 1.62;
    const w = h * (fr.sw / fr.sh) * (tiny ? 1.0 : 1.0);
    const dh = projectedHeight(h);
    // 器械无腿：行军用轮架颠簸 + 极轻摆角，确定性取模拟相位
    const bob = o.walk
      ? Math.sin((o.phase ?? 0) * 1.8) * 0.45 * (o.amp ?? 1) * (s / 20)
      : 0;
    const tilt = engine && o.walk ? Math.sin((o.phase ?? 0) * 1.8) * 0.012 : 0;

    ctx.save();
    // 地面投影始终在地面平面上，不跟着投影矩阵歪
    ctx.fillStyle = 'rgba(10,18,16,.34)';
    ctx.beginPath();
    ctx.ellipse(x, y + 1.4, w * 0.30, Math.max(1.4, s * 0.11 * VIEW.cos + 0.6),
      0, 0, Math.PI * 2);
    ctx.fill();

    ctx.translate(x, y + bob);
    if (tilt) ctx.rotate(tilt);
    // 58° 地面斜轴：x' = x + SHEAR·y，立绘不再是一张正对贴片
    ctx.transform(1, 0, GROUND_SHEAR, 1, 0, 0);
    ctx.drawImage(fr.sheet, fr.sx, 0, fr.sw, fr.sh, -w / 2, -dh, w, dh);
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
    get loaded() { return Object.values(sheets).filter(Boolean).length; },
    frameFor: (heading) => DIR8[dirIndex(heading ?? 0)],
    walkFrameFor: (heading, phase) => {
      const ph = walkPhase(true, phase);
      return `${DIR8[dirIndex(heading ?? 0)]}-${ph === 1 ? 'L' : 'R'}`;
    },
    phaseFor: (walk, phase) => walkPhase(walk, phase),
    engineFrameFor: (heading, which) =>
      `${which ?? 'ballista'}-${DIR8[dirIndex(heading ?? 0)]}`,
    projectedHeight, GROUND_SHEAR,
  };
}
