// 八向索引：把连续朝向角量化到 0..7 帧。
//
// 用户点出的关键点：「人方向是会变的，所以他需要很多张」——
// 单位转向不再是 scale(-1,1) 一张图左右翻，而是按朝向取对应的造型帧。
// 这里只做纯逻辑：不引用 DOM / canvas / 墙钟 / 随机源，
// 同一 heading 永远得到同一帧，可直接进单测与重放校验。
//
// 帧序与 assets/units/trooper.json 一致（顺时针，0 = 正面朝观者）：
//   0 正面 3/4 | 1 右前 45 | 2 正右 90 | 3 右后 135
//   4 正背 180 | 5 左后 225 | 6 正左 270 | 7 左前 315
export const DIR8 = [
  'd0_front', 'd1_front_right', 'd2_right', 'd3_back_right',
  'd4_back', 'd5_back_left', 'd6_left', 'd7_front_left',
];
export const DIR8_LABEL = [
  '正面 3/4', '右前 45°', '正右 90°', '右后 135°',
  '正背 180°', '左后 225°', '正左 270°', '左前 315°',
];

const TAU = Math.PI * 2;
const SECTOR = TAU / 8;

/** 把任意弧度规整到 [0, 2π)。NaN / Infinity 一律归 0，不抛错、不引入随机。 */
export function normAngle(a) {
  if (!Number.isFinite(a)) return 0;
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

/**
 * heading（弧度，0 = 朝画面下方/正面朝观者，顺时针递增）→ 帧索引 0..7。
 * 用「加半个扇区再取整」做最近邻量化，边界朝向确定性地归入后一扇区。
 */
export function dirIndex(heading) {
  const a = normAngle(heading);
  const q = a / SECTOR + 0.5;
  // atan2 求出的朝向在精确扇区边界上会带 1e-15 级误差：直接 floor 会让
  // 同一个 202.5° 一会儿落第 4 帧、一会儿落第 5 帧，整圈转身时看着像跳帧。
  // 把「几乎就是整数」的商吸附到整数，边界永远确定归入后一扇区。
  const near = Math.round(q);
  const snapped = Math.abs(q - near) < 1e-9 ? near : q;
  return Math.floor(snapped) % 8;
}

/** 由位移向量求朝向；(0,0) 时回退到 fallback（默认正面）。 */
export function headingFromDelta(dx, dy, fallback = 0) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
    return normAngle(fallback);
  }
  // 屏幕坐标 y 向下；0 = 朝下（正面朝观者），顺时针增加
  return normAngle(Math.atan2(dx, dy));
}

export function frameName(heading) { return DIR8[dirIndex(heading)]; }
export function frameLabel(heading) { return DIR8_LABEL[dirIndex(heading)]; }

/** 帧文件 → 索引，供 manifest 校验与调试面板反查。 */
export function indexOfFrame(name) { return DIR8.indexOf(name); }

/** 八个中心角，供自检确认扇区无重叠、无空洞。 */
export function sectorCenters() {
  return DIR8.map((_, i) => normAngle(i * SECTOR));
}
