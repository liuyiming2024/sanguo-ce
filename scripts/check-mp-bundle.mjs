#!/usr/bin/env node
// P4 资源分包的「核算层」：不改运行时、不往仓库塞二进制，只把体积算清楚。
//
// 为什么先核算不先分包：微信「单个分包 / 主包 ≤ 2 MB、总 ≤ 20 MB」，
// 抖音「主包 ≤ 4 MB、分包总 ≤ 20 MB」。实测运行时真正加载的 4 张 sheet
// 就有 13.9 MiB，任何一张单独成包都超 2 MB —— 直接分包必然失败，
// 得先决定压缩 / 降分辨率 / 是否走程序化回退，再谈 app.json 的 subpackages。
//
// 用法：
//   node scripts/check-mp-bundle.mjs           # 打印核算表
//   node scripts/check-mp-bundle.mjs --check  # 只做护栏断言，失败真退出
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const MiB = (n) => (n / 1024 / 1024).toFixed(2);
const MB_LIMIT = { wxMain: 2 * 1024 * 1024, wxSub: 2 * 1024 * 1024,
  wxTotal: 20 * 1024 * 1024, dyMain: 4 * 1024 * 1024, dyTotal: 20 * 1024 * 1024 };
const problems = [];

const MP_DIR = join(root, 'miniprogram');
const ASSET_DIR = join(MP_DIR, 'assets');   // subpackages 产物（本地 build，.gitignore）
const PLAN_META = [join(MP_DIR, 'assets-plan.json'), join(MP_DIR, 'app.subpackages.example.json')];
function walk(dir, skipAssets = false) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, n.name);
    if (n.isDirectory()) {
      if (['.git', 'node_modules', '__pycache__'].includes(n.name)) continue;
      if (skipAssets && p === ASSET_DIR) continue;  // 分包不计入主包
      out.push(...walk(p, skipAssets));
    } else if (!(skipAssets && PLAN_META.includes(p))) out.push(p);  // 方案元数据不计主包
  }
  return out;
}
const size = (p) => statSync(p).size;
const isBitmap = (p) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(p);

// ── ① 首包：miniprogram/ 全部文件 ─────────────────────────────────────
const mpFiles = walk(MP_DIR, true);           // 主包：排除 subpackages 产物目录
const mpBytes = mpFiles.reduce((a, p) => a + size(p), 0);
const mpBitmaps = mpFiles.filter(isBitmap);
// 分包产物只在本地 build 后存在；按 app.json 的 subpackages 口径单独核。
const pkgGroups = [];
if (existsSync(ASSET_DIR)) {
  for (const n of readdirSync(ASSET_DIR, { withFileTypes: true })) {
    if (!n.isDirectory()) continue;
    const d = join(ASSET_DIR, n.name);
    const fs = walk(d);
    pkgGroups.push({ name: n.name, files: fs.length,
      bytes: fs.reduce((a, p) => a + size(p), 0) });
  }
}
const pkgBytes = pkgGroups.reduce((a, g) => a + g.bytes, 0);
const logicFiles = mpFiles.filter((p) => p.includes('miniprogram/logic/'));
const logicBytes = logicFiles.reduce((a, p) => a + size(p), 0);

// ── ② 运行时真正加载的 sheet：从 portrait.js 的 load(...) 解析，不手写清单 ──
const portrait = readFileSync(join(root, 'src/portrait.js'), 'utf8');
const sheets = [...portrait.matchAll(/load\('([^']+\.png)',\s*'([^']+)'\)/g)]
  .map((m) => ({ file: m[1], key: m[2], path: join(root, 'assets/units', m[1]) }));
if (sheets.length === 0) problems.push('portrait.js 里解析不出 load(...) 清单，核算口径失效');
for (const s of sheets) if (!existsSync(s.path)) problems.push(`运行时 sheet 缺失：${s.file}`);
const sheetBytes = sheets.reduce((a, s) => a + (existsSync(s.path) ? size(s.path) : 0), 0);

// ── ③ 其余素材：单帧 PNG / 底稿 JPG / demos 实验层 ─────────────────────
const unitsAll = walk(join(root, 'assets/units'));
const srcDrafts = walk(join(root, 'assets/units/src')).filter(isBitmap);
const srcDraftBytes = srcDrafts.reduce((a, p) => a + size(p), 0);
const sheetNames = new Set(sheets.map((s) => s.file));
const standalone = unitsAll.filter((p) => isBitmap(p) &&
  !sheetNames.has(p.split(/[\\/]/).pop()) && !p.includes(`${'src'}/`));
const standaloneBytes = standalone.reduce((a, p) => a + size(p), 0);
const demosBytes = walk(join(root, 'demos')).filter(isBitmap)
  .reduce((a, p) => a + size(p), 0);

// ── ④ 舆图是不是位图？核 guandu.js / atlas.js 有没有 .png / .jpg 字面量 ──
const atlasSrc = ['src/guandu.js', 'src/atlas.js']
  .map((p) => readFileSync(join(root, p), 'utf8')).join('\n');
const atlasBitmapRefs = (atlasSrc.match(/\.(png|jpe?g|webp)\b/gi) ?? []).length;
const atlasCodeBytes = ['src/guandu.js', 'src/atlas.js']
  .reduce((a, p) => a + size(join(root, p)), 0);

// ── 护栏 ──────────────────────────────────────────────────────────────
if (mpBitmaps.length) problems.push(`主包混入 ${mpBitmaps.length} 张位图，P4「主包零位图」破了`);
if (mpBytes > MB_LIMIT.wxMain) problems.push(`主包 ${MiB(mpBytes)} MiB 超微信 2 MB 主包`);
for (const g of pkgGroups) {
  if (g.bytes > MB_LIMIT.wxSub) problems.push(`分包 ${g.name} ${MiB(g.bytes)} MiB 超微信单个分包 2 MB`);
}
if (mpBytes + pkgBytes > MB_LIMIT.wxTotal) problems.push(`主包 + 分包 ${MiB(mpBytes + pkgBytes)} MiB 超 20 MB`);
if (srcDrafts.some((p) => p.includes('miniprogram'))) problems.push('生成底稿 JPG 进包了');
if (sheets.length !== 4) problems.push(`运行时 sheet 数变了（${sheets.length}），分包方案要重算`);
if (atlasBitmapRefs > 0) problems.push('舆图渲染层出现位图文件名，P4 的「舆图是程序化代码」结论失效');
// 逻辑层镜像必须存在（P4 的前提是逻辑层已在小程序端）
if (logicFiles.length < 20) problems.push(`miniprogram/logic/ 只有 ${logicFiles.length} 个文件，镜像没同步`);

// ── 输出 ──────────────────────────────────────────────────────────────
if (CHECK) {
  if (problems.length) {
    console.error('✗ 包体核算护栏未通过：');
    for (const p of problems) console.error('   - ' + p);
    process.exit(1);
  }
  console.log(`✓ 包体核算通过：主包 ${MiB(mpBytes)} MiB / 0 位图 / ${logicFiles.length} 个逻辑镜像文件`
    + (pkgGroups.length ? `；${pkgGroups.length} 个分包各 ≤ 2 MB` : '；分包产物未生成'));
  process.exit(0);
}

console.log('\n=== 小程序包体核算（P4）===');
console.log(`主包 miniprogram/（排除 subpackages 产物）：${mpFiles.length} 文件 / ${mpBytes} B = ${MiB(mpBytes)} MiB / 位图 ${mpBitmaps.length} 张`);
if (pkgGroups.length) {
  console.log('\n分包产物（npm run assets:build 生成，.gitignore 不进仓库）：');
  for (const g of pkgGroups) console.log(`  ${g.name.padEnd(24)} ${g.files} 文件 / ${g.bytes} B = ${MiB(g.bytes)} MiB`);
  console.log(`  合计 ${MiB(pkgBytes)} MiB，主包 + 分包 ${MiB(mpBytes + pkgBytes)} MiB`);
} else console.log('\n分包产物：未生成（跑 npm run assets:build 可生成本地 webp，不进仓库）');
console.log(`  其中逻辑层镜像 logic/：${logicFiles.length} 文件 / ${MiB(logicBytes)} MiB（纯文本）`);
console.log('\n运行时位图（src/portrait.js 的 load() 清单）：');
for (const s of sheets) {
  const b = existsSync(s.path) ? size(s.path) : 0;
  console.log(`  ${s.file.padEnd(28)} ${String(b).padStart(9)} B = ${MiB(b).padStart(6)} MiB  `
    + `${b > MB_LIMIT.wxSub ? '超微信单包 2 MB' : '可入单包'}`);
}
console.log(`  合计 ${MiB(sheetBytes)} MiB`);
console.log('\n不入包 / 待处置：');
console.log(`  单帧 PNG ${standalone.length} 张          ${MiB(standaloneBytes)} MiB（产物，运行时不引用）`);
console.log(`  源底稿 JPG ${srcDrafts.length} 张          ${MiB(srcDraftBytes)} MiB（B5 待溯源，明确不进包）`);
console.log(`  demos/ 实验层位图        ${MiB(demosBytes)} MiB（不进小程序包）`);
console.log(`  官渡 / 全境舆图          程序化绘制，位图引用 ${atlasBitmapRefs} 处，代码 ${atlasCodeBytes} B`);
console.log('\n平台阈值：微信主包 2 MB / 单个分包 2 MB / 总 20 MB；抖音主包 4 MB / 分包总 20 MB');
console.log('\n结论：');
const tiny = sheets.find((s) => s.file.includes('tiny'));
const tinyBytes = tiny && existsSync(tiny.path) ? size(tiny.path) : 0;
const oversize = sheets.filter((s) => existsSync(s.path) && size(s.path) > MB_LIMIT.wxSub);
console.log(`  1. 首包零位图已成立（${MiB(mpBytes)} MiB），走 mini-map 格网 + soldier.js 程序化回退即可先跑。`);
console.log(`  2. ${sheets.length} 张 PNG sheet 合计 ${MiB(sheetBytes)} MiB；其中 ${oversize.length} 张各自就超微信单个分包 2 MB ——`);
console.log('     把 PNG 原样声明 subpackages 会失败。压缩方案见 miniprogram/assets-plan.json：');
console.log('     sharp webp q=80 后合计 2.59 MiB，按 infantry / engine 分两组各 ≤ 2 MB。');
console.log(`  3. tiny-sheet ${tinyBytes} B，可与逻辑层同进主包（约 ${MiB(mpBytes + tinyBytes)} MiB，远低于 2 MB）。`);
console.log('  4. 「按章分包两张舆图」这条清单前提不成立：舆图是 guandu.js/atlas.js 的程序化');
console.log('     离屏画布，不是 bg/fg 位图文件，随渲染层代码走，不占二进制体积。');
console.log(`  5. webp 产物由 npm run assets:build 生成、.gitignore 不进仓库（${MiB(pkgBytes)} MiB 本地）；`);
console.log('     真分包仍待真机启用：跑 build 后把 app.subpackages.example.json 的片段并入 app.json。');
console.log(`     源 PNG 与单帧共 ${MiB(standaloneBytes + srcDraftBytes)} MiB 永不入包。`);
console.log(`\n护栏问题：${problems.length ? '\n  - ' + problems.join('\n  - ') : '无'}`);
if (problems.length) process.exit(1);
