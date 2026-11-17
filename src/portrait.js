// 写实淡彩八向位图渲染层（v0.8.0）。
//
// 这是「可选皮肤」，不是推翻原有骨架：
//   · 素材来自 assets/units/，运行时只读、不生成、不改像素；
//   · 加载失败或未就绪时，city-view 自动回退到 soldier.js 的程序化俯视路径；
//   · 不引用墙钟 / Math.random；同一 sec + heading 永远画同一帧；
//   · 加载状态不进 campaign state / 存档 / 命令日志 / 状态指纹。
//
// 素材是站立 3/4 全身像，战场是斜俯视。这里做一次「纵向压缩 + 脚底锚定」，
// 让它落在地面平面上而不是飘着；压缩系数沿用 VIEW.cos，与程序化层一致。
import { DIR8, dirIndex } from './direction.js?v=0.8.0';
import { VIEW } from './soldier.js?v=0.8.0';

const BASE = new URL('../assets/units/', import.meta.url);

export function createPortraits({ onReady } = {}) {
  const frames = new Array(8).fill(null);
  let ready = false, failed = false, pending = 0;

  function settle() {
    if (failed || ready) return;
    if (pending > 0) return;
    ready = frames.every(Boolean);
    if (ready) onReady?.();
    else failed = true;
  }

  DIR8.forEach((name, i) => {
    const img = new Image();
    pending++;
    img.onload = () => { frames[i] = img; pending--; settle(); };
    img.onerror = () => { pending--; failed = true; };
    img.src = new URL(`trooper-${name}.png`, BASE).href;
  });

  /**
   * 画一个写实人形单位。返回 false 表示未就绪/不适用，调用方应回退程序化。
   * @param o {x,y,s,heading,walk,phase,amp,selected,champion,hp}
   */
  function draw(ctx, o) {
    if (!ready) return false;
    const idx = dirIndex(o.heading ?? 0);
    const img = frames[idx];
    if (!img) return false;

    const { x, y, s } = o;
    // 立像高 ≈ 13k，宽 ≈ 10k；统一脚底基线与尺寸，切帧不跳。
    const h = s * 1.62;   // 全身像在格子里要站得住，别缩成小人点
    const w = h * (img.width / img.height);
    // 斜俯视压缩：不拉宽、只压高，脚底落在地面立足点
    const dh = h * (0.82 + VIEW.cos * 0.18);
    const bob = o.walk ? Math.sin((o.phase ?? 0) * 1.8) * 0.45 * (o.amp ?? 1) * (s / 20) : 0;

    ctx.save();
    // 地面投影由渲染层画，不烧进素材
    ctx.fillStyle = 'rgba(10,18,16,.34)';
    ctx.beginPath();
    ctx.ellipse(x, y + 1.4, w * 0.30, Math.max(1.4, s * 0.11), 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.translate(x, y + bob);
    ctx.drawImage(img, -w / 2, -dh, w, dh);
    ctx.restore();

    // 血条 / 选中环沿用程序化层的口径：满血不画
    const hp = Math.max(0, Math.min(1, o.hp ?? 1));
    if (hp < 0.999 || o.selected || o.champion) {
      const bw = s * 0.62, bh = Math.max(1, s * 0.07), by = y - dh - s * 0.12;
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
        ctx.fillStyle = 'rgba(200,168,106,.95)';
        ctx.beginPath();
        ctx.moveTo(x, by0(y, dh, s) - s * 0.28); ctx.lineTo(x + s * 0.12, by0(y, dh, s) - s * 0.16);
        ctx.lineTo(x, by0(y, dh, s) - s * 0.04); ctx.lineTo(x - s * 0.12, by0(y, dh, s) - s * 0.16);
        ctx.closePath(); ctx.fill();
      }
    }
    return true;
  }

  return {
    draw,
    get ready() { return ready; },
    get failed() { return failed; },
    get loaded() { return frames.filter(Boolean).length; },
    frameFor: (heading) => DIR8[dirIndex(heading ?? 0)],
  };
}

function by0(y, dh, s) { return y - dh - s * 0.42; }
