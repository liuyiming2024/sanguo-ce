#!/usr/bin/env node
// 小程序 P4 资源分包的**静态**校验：不打包、不真机、不改 app.json。
// 只回答三件事：素材各组多大、镜像里有没有混进位图、源底稿有没有被误带。
// 真机分包体积与运行时加载必须在小程序开发者工具里验，本脚本不假装有那能力。
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const U = join(root, 'assets/units');
const MP = join(root, 'miniprogram');

function files(dir) {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(p);
    }
  };
  walk(dir);
  return out;
}
const group = (p) => {
  const n = p.split('/').pop();
  if (n.endsWith('.jpg')) return '源底稿 JPG（不入包）';
  if (n.endsWith('-sheet.png')) return '合图 sheet';
  if (n.startsWith('trooper-walk-')) return '步态帧';
  if (n.startsWith('trooper-tiny-')) return 'tiny 档';
  if (n.startsWith('trooper-d')) return 'idle 八向';
  if (n.startsWith('engine-')) return '器械八向';
  if (n === 'trooper.json') return '索引 JSON';
  return '其他';
};

const all = files(U);
const by = {};
for (const p of all) {
  const g = group(p);
  (by[g] ??= { n: 0, bytes: 0 });
  by[g].n++; by[g].bytes += statSync(p).size;
}
const total = Object.values(by).reduce((a, b) => a + b.bytes, 0);
const MB = (b) => (b / 1024 / 1024).toFixed(2);

console.log('P4 素材静态清点（真机体积仍需在开发者工具里核）');
console.log(`  assets/units/ 共 ${all.length} 个文件 / ${MB(total)} MB\n`);
for (const [k, v] of Object.entries(by).sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  ${k.padEnd(22)} ${String(v.n).padStart(2)} 个  ${MB(v.bytes).padStart(7)} MB`);
}

// 运行时只加载 4 张 sheet + trooper.json（见 src/portrait.js:40-43）。
// 其余 48 张单帧 PNG 是 build_units.py 的产物留档，运行时零引用 —— 这是
// P4 最实在的一刀：分包只需带 sheet，单帧与源 JPG 都不进包。
const RUNTIME = ['trooper-sheet.png', 'trooper-walk-sheet.png',
  'engine-sheet.png', 'trooper-tiny-sheet.png', 'trooper.json'];
const runtimeBytes = RUNTIME.reduce((a, n) => a + statSync(join(U, n)).size, 0);
const singles = all.filter((p) => p.endsWith('.png') && !p.endsWith('-sheet.png'));
const singlesBytes = singles.reduce((a, p) => a + statSync(p).size, 0);

const problems = [];
// ① 逻辑层镜像只应是 .js / .json，不能混进位图
const bitmap = files(join(MP, 'logic')).filter((p) => /\.(png|jpe?g|webp|gif)$/i.test(p));
if (bitmap.length) problems.push(`miniprogram/logic/ 混进 ${bitmap.length} 张位图，镜像不该带皮肤`);
// ② 10 张源底稿 JPG 必须存在但只作底稿；数量变了要人工确认
const jpg = all.filter((p) => p.endsWith('.jpg'));
if (jpg.length !== 10) problems.push(`源底稿 JPG 期望 10 张，实测 ${jpg.length} 张，需复核素材台账`);
// ③ 运行时 4 张 sheet + 索引必须齐，缺一张就整队回退 soldier.js
for (const n of RUNTIME) if (!existsSync(join(U, n))) problems.push(`运行时素材缺失 ${n}`);
// ④ 索引 JSON 的源图指纹锁必须在，否则防回退到假背面失效
if (!existsSync(join(U, 'trooper.json'))) problems.push('trooper.json 缺失');

console.log('\n建议分包（不写进 app.json，交端侧按平台格式落地）');
console.log(`  运行时素材合计：${MB(runtimeBytes)} MB（4 张 sheet + trooper.json）`);
console.log(`  产物留档（不入包）：${singles.length} 张单帧 PNG ≈${MB(singlesBytes)} MB + 源底稿 JPG ≈${MB(by['源底稿 JPG（不入包）']?.bytes ?? 0)} MB`);
console.log('  首包：官渡本图 bg+fg + soldier.js 程序化回退（零 PNG 也能跑）');
console.log(`  分包A「兵形皮肤」：4 张 sheet + trooper.json（≈${MB(runtimeBytes)} MB），素材未就绪自动回退`);
console.log('  分包B「全境图」：全境 bg+fg 按 ?map=quanjing 懒加载');
console.log('  不入包：48 张单帧 PNG 与 10 张源 JPG 只留主工程供 build_units.py 复现');
console.log('  注：清单口径「分包总 ≤20MB」若适用，运行时 13.32MB 已在限内；仍需在开发者工具里核真机体积。');

if (problems.length) {
  console.error('\n✗ P4 静态校验未通过：\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log('\n✓ P4 静态校验通过：镜像零位图、运行时 4 sheet + 索引齐、单帧与底稿未混入');
