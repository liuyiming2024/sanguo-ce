// 单位样式皮肤入口（第十九轮）。「皮肤」＝ 对小兵／将领样式的一次重绘，
// 旧版完整保存为 classic 基线，新旧可在同一界面里切换对比、随时回退。
//
// 调用方一律只 import 本模块：导出的 drawSoldier / drawGeneralPortrait 与
// 旧模块同名同参，classic 档直接转调原函数，逐像素一致；其余档转调重绘层。
// 纯渲染层，不进 state / 存档 / 命令日志 / 状态指纹；无墙钟、无随机源。
import { drawSoldier as baseSoldier, idSeed, unitKind, SOLDIER_PAL, VIEW } from './soldier.js';
import { drawGeneralPortrait as baseGeneral } from './general-portrait.js';
import {
  drawRedrawnSoldier, drawRedrawnGeneral, drawRedrawnTrooper, REDRAW_IDS,
} from './unit-redraw.js';

export { idSeed, unitKind, SOLDIER_PAL, VIEW };

export const UNIT_SKINS = [
  { id: 'classic', letter: 'A', title: '现行立绘（备份基线）', short: '现行立绘',
    desc: '八向写实位图 + 俯视札甲程序化回退；将领半身像。原文件一字未改。',
    caveat: '回退锚点，什么都不改。' },
  { id: 'gongbi', letter: 'B', title: '工笔札甲（矿物重彩）', short: '工笔札甲',
    desc: '密甲片 / 护心镜 / 盾面云纹 / 朱缨 / 兽首肩甲，石青赭石金，硬边平涂。将领改全身立姿。',
    caveat: '细节最密，手机 tiny 档仍按尺度收敛。' },
  { id: 'rubbing', letter: 'C', title: '墨影拓片（汉画像石）', short: '墨影拓片',
    desc: '头肩躯干连成一块大墨影 + 飞白剥蚀 + 一点朱印，几乎不勾线。将领改侧面拓片剪影。',
    caveat: '辨识度靠留白，缩小后偏暗。' },
  { id: 'baimiao', letter: 'D', title: '朱线白描（纯线不填）', short: '朱线白描',
    desc: '完全不填色，兜鍪 / 肩线 / 甲片 / 盾 / 兵器全用线；朱色只给缨、旗与血条。',
    caveat: '最轻，但深底上对比弱。' },
  { id: 'shadow', letter: 'E', title: '皮影戏偶（分段镂空）', short: '皮影戏偶',
    desc: '头 / 躯干 / 两臂 / 两腿各一块暖透光片，带镂空孔与关节铆钉；将领改皮影侧身。',
    caveat: '平面化最强，与「俯视写实」口径差别最大，挑的时候注意是不是要这个方向。' },
  { id: 'night', letter: 'F', title: '夜墨反白（深底浅笔）', short: '夜墨反白',
    desc: '深墨底上的浅金 / 纸白笔，线为主、少量淡墨块，与全境图 F 档同气质。',
    caveat: '需要深底才成立；浅绢底上会偏淡。' },
];

const VALID = new Set(UNIT_SKINS.map(s => s.id));
let current = 'classic';

// 本机界面状态，不进局面。小程序无 localStorage 时静默忽略，不影响逻辑层。
const KEY = 'sanguo.unitSkin';
try {
  const v = globalThis.localStorage?.getItem(KEY);
  if (v && VALID.has(v)) current = v;
} catch (_) { /* 宿主无存储时保持默认 */ }

/** 切换皮肤。返回是否真的变了，便于调用方决定要不要重绘。 */
export function setUnitSkin(id) {
  if (!VALID.has(id) || id === current) return false;
  current = id;
  try { globalThis.localStorage?.setItem(KEY, id); } catch (_) { /* 忽略 */ }
  return true;
}
export function getUnitSkin() { return current; }
export function getUnitSkinInfo() { return UNIT_SKINS.find(s => s.id === current) || UNIT_SKINS[0]; }
export function isClassicSkin() { return current === 'classic'; }

/** 与旧 soldier.js 同名同参；classic 直接转调，重绘档走重绘层。 */
export function drawSoldier(ctx, u, o) {
  if (current === 'classic') { baseSoldier(ctx, u, o); return; }
  drawRedrawnSoldier(ctx, u, o, current);
}

/** 与旧 general-portrait.js 同名同参。 */
export function drawGeneralPortrait(ctx, look, x, y, s, opts = {}) {
  if (current === 'classic') { baseGeneral(ctx, look, x, y, s, opts); return; }
  drawRedrawnGeneral(ctx, look, x, y, s, opts, current);
}

/** 主地图驻军／行军队列的程序化简笔。classic 返回 false，调用方走原 inkTrooper。 */
export function drawInkTrooper(ctx, x, y, s, heading, phase, col) {
  if (current === 'classic') return false;
  return drawRedrawnTrooper(ctx, x, y, s, heading, phase, col, current);
}

/** 供自检／预览页枚举，避免两处各写一份名单。 */
export function redrawIds() { return REDRAW_IDS.slice(); }
