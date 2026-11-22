#!/usr/bin/env node
// P4 分包方案：把上一轮「3 张 PNG 各自超 2 MB，直接分包会失败」推进到
// 「压缩后如何分」的可执行方案。
//
// 三个子命令：
//   node scripts/mp-assets.mjs --measure   用 sharp 实测 webp 体积，
//                                          写 miniprogram/assets-plan.json
//                                          与 app.subpackages.example.json
//   node scripts/mp-assets.mjs --build     生成 webp 产物到 miniprogram/assets/
//                                          （.gitignore 忽略，不进仓库）
//   node scripts/mp-assets.mjs --check     只校验 plan 与磁盘，不依赖 sharp
//
// --check 被 scripts/check-map.mjs 每轮调用：分包每组 ≤ 2 MB、总 ≤ 20 MB、
// 主包 ≤ 2 MB，且 plan 里的 pngBytes 必须与仓库里真实 PNG 逐字节对得上，
// 防止「方案写的是旧尺寸，实际素材早换了」。
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// sharp 是沙盒预装的全局依赖（NODE_PATH），ESM 的 import 不认 NODE_PATH；
// 走 createRequire 的 CJS 解析。--check 完全不碰它，CI 没装 sharp 也绿。
const require = createRequire(import.meta.url);
function loadSharp() {
  try { return require('sharp'); }
  catch { throw new Error('需要 sharp 才能 --measure / --build；--check 不依赖它'); }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MP = join(root, 'miniprogram');
const UNITS = join(root, 'assets/units');
const PLAN = join(MP, 'assets-plan.json');
const EXAMPLE = join(MP, 'app.subpackages.example.json');
const OUT = join(MP, 'assets');
const ARGS = process.argv.slice(2);

// 与 src/portrait.js 的 load() 清单同源，不手写第二份（脚本启动时正则核一遍）。
const SHEETS = [
  { file: 'trooper-sheet.png', frames: 8, frameW: 560, frameH: 820, group: 'infantry' },
  { file: 'trooper-walk-sheet.png', frames: 16, frameW: 560, frameH: 820, group: 'infantry' },
  { file: 'engine-sheet.png', frames: 16, frameW: 560, frameH: 820, group: 'engine' },
  { file: 'trooper-tiny-sheet.png', frames: 8, frameW: 72, frameH: 108, group: 'engine' },
];
const THRESHOLDS = {
  wxMain: 2 * 1024 * 1024, wxSub: 2 * 1024 * 1024, wxTotal: 20 * 1024 * 1024,
  dyMain: 4 * 1024 * 1024, dyTotal: 20 * 1024 * 1024,
};
const MAIN_ESTIMATE = 205117; // miniprogram/ 纯文本首包（check-mp-bundle.mjs 实测口径）
const problems = [];
const MiB = (n) => (n / 1024 / 1024).toFixed(2);

function loadListFromPortrait() {
  const t = readFileSync(join(root, 'src/portrait.js'), 'utf8');
  return [...t.matchAll(/load\('([^']+\.png)'/g)].map((m) => m[1]).sort();
}
function checkList() {
  const live = loadListFromPortrait();
  const declared = SHEETS.map((s) => s.file).sort();
  if (JSON.stringify(live) !== JSON.stringify(declared)) {
    problems.push(`src/portrait.js 的 sheet 清单变了：${live.join(',')}，请同步 scripts/mp-assets.mjs`);
  }
}

function mainPackageBytes() {
  // 按 app.json 的 subpackages 口径：只算主包（排除 assets/ 产物目录）。
  let n = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (p === OUT) continue;              // 分包产物不进主包
        walk(p);
      } else if (p !== PLAN && p !== EXAMPLE) n += statSync(p).size;  // 方案元数据不计主包
    }
  };
  walk(MP);
  return n;
}

function groupsOf(sheets) {
  const m = new Map();
  for (const s of sheets) {
    if (!m.has(s.group)) m.set(s.group, { name: s.group, root: `assets/units-${s.group}`,
      files: [], bytes: 0 });
    const g = m.get(s.group);
    g.files.push(s.file.replace(/\.png$/, '.webp'));
    g.bytes += s.webpBytes;
  }
  return [...m.values()];
}

async function measure() {
  checkList();
  if (problems.length) throw new Error(problems.join('\n'));
  const sharp = loadSharp();
  const sheets = [];
  for (const s of SHEETS) {
    const p = join(UNITS, s.file);
    if (!existsSync(p)) throw new Error(`缺素材：${s.file}`);
    const pngBytes = statSync(p).size;
    const buf = await sharp(p).webp({ quality: 80, effort: 6 }).toBuffer();
    sheets.push({ ...s, pngBytes, webpBytes: buf.length });
    console.log(`  ${s.file.padEnd(28)} png ${String(pngBytes).padStart(9)} → webp ${String(buf.length).padStart(9)} B  (${(buf.length / pngBytes * 100).toFixed(1)}%)`);
  }
  const groups = groupsOf(sheets);
  const plan = {
    generatedBy: 'scripts/mp-assets.mjs --measure',
    measuredBy: 'sharp webp quality=80 effort=6（交叉验证：PIL 10.4.0 q=80 method=6 结果一致）',
    thresholds: THRESHOLDS,
    mainPackageBytes: mainPackageBytes(),
    sheets,
    subpackages: groups,
    totalWebpBytes: sheets.reduce((a, s) => a + s.webpBytes, 0),
    note: '产物默认不进仓库（miniprogram/assets/ 已 gitignore）；真机前跑 --build 生成，再把 app.subpackages.example.json 的片段并入 app.json。webp 在小程序端的解码支持未真机验证。',
  };
  writeFileSync(PLAN, JSON.stringify(plan, null, 2) + '\n');
  const example = {
    _说明: '待启用模板：跑 npm run assets:build 生成 miniprogram/assets/ 后，把下面 subpackages 数组并入 app.json；本文件本身不参与编译。',
    subpackages: groups.map((g) => ({ root: g.root, name: g.name, pages: [] })),
  };
  writeFileSync(EXAMPLE, JSON.stringify(example, null, 2) + '\n');
  console.log(`\n分包方案（微信单个分包上限 ${MiB(THRESHOLDS.wxSub)} MiB）：`);
  for (const g of groups) console.log(`  ${g.root.padEnd(24)} ${g.bytes} B = ${MiB(g.bytes)} MiB  ${g.files.join(', ')}`);
  console.log(`  合计 webp ${plan.totalWebpBytes} B = ${MiB(plan.totalWebpBytes)} MiB；主包 ${plan.mainPackageBytes} B = ${MiB(plan.mainPackageBytes)} MiB`);
  console.log(`  总计 ${plan.totalWebpBytes + plan.mainPackageBytes} B = ${MiB(plan.totalWebpBytes + plan.mainPackageBytes)} MiB（总上限 20 MiB）`);
  console.log('written:', PLAN, EXAMPLE);
}

async function build() {
  if (!existsSync(PLAN)) throw new Error('先跑 --measure');
  const plan = JSON.parse(readFileSync(PLAN, 'utf8'));
  const sharp = loadSharp();
  for (const g of plan.subpackages) {
    const dir = join(MP, g.root);
    mkdirSync(dir, { recursive: true });
    for (const f of g.files) {
      const src = join(UNITS, f.replace(/\.webp$/, '.png'));
      const dest = join(dir, f);
      const info = await sharp(src).webp({ quality: 80, effort: 6 }).toFile(dest);
      if (info.size > THRESHOLDS.wxSub) problems.push(`${f} 单文件超 2 MB`);
      console.log(`  ${g.root}/${f}  ${info.size} B`);
    }
  }
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log('产物已生成（.gitignore 忽略，不进仓库）。真机前把 app.subpackages.example.json 的片段并入 app.json。');
}

function check() {
  checkList();
  if (!existsSync(PLAN)) { problems.push('缺 miniprogram/assets-plan.json：跑 npm run assets:measure'); }
  else {
    const p = JSON.parse(readFileSync(PLAN, 'utf8'));
    for (const s of p.sheets ?? []) {
      const f = join(UNITS, s.file);
      if (!existsSync(f)) { problems.push(`plan 引用了不存在的素材 ${s.file}`); continue; }
      if (statSync(f).size !== s.pngBytes) {
        problems.push(`${s.file} 实际 ${statSync(f).size} B ≠ plan 的 ${s.pngBytes} B，方案过期`);
      }
    }
    for (const g of p.subpackages ?? []) {
      if (g.bytes > THRESHOLDS.wxSub) problems.push(`分包 ${g.root} ${g.bytes} B 超微信单个分包 2 MB`);
      if (!g.files?.length) problems.push(`分包 ${g.root} 是空的`);
    }
    const total = (p.totalWebpBytes ?? 0) + (p.mainPackageBytes ?? 0);
    if (total > THRESHOLDS.wxTotal) problems.push(`总量 ${total} B 超 20 MB`);
    if ((p.mainPackageBytes ?? 0) > THRESHOLDS.wxMain) problems.push('主包超 2 MB');
    if (!(p.subpackages?.length >= 2)) problems.push('分包方案没有把 3 张大 sheet 拆开');
    // plan 里的主包体积必须跟当前目录一致，防止文档数字漂移
    const live = mainPackageBytes();
    if (Math.abs(live - (p.mainPackageBytes ?? 0)) > 64 * 1024) {
      problems.push(`主包体积从 ${p.mainPackageBytes} 变成 ${live} B，跑 npm run assets:measure 刷新 plan`);
    }
  }
  if (!existsSync(EXAMPLE)) problems.push('缺 app.subpackages.example.json');
  if (problems.length) {
    console.error('✗ 分包方案护栏未通过：');
    for (const x of problems) console.error('   - ' + x);
    process.exit(1);
  }
  const p = JSON.parse(readFileSync(PLAN, 'utf8'));
  console.log(`✓ 分包方案一致：${p.subpackages.length} 组 / webp 合计 ${MiB(p.totalWebpBytes)} MiB / 主包 ${MiB(p.mainPackageBytes)} MiB（真分包未启用）`);
}

if (ARGS.includes('--measure')) await measure();
else if (ARGS.includes('--build')) await build();
else check();
