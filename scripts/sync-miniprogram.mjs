#!/usr/bin/env node
// 小程序适配的「薄入口」：不是 webpack / vite，不做转译、不改一行源码。
//
// 从几个入口出发递归解析 ESM 相对 import，自动收出纯逻辑层闭包，把 src/*.js
// 原字节复制到 miniprogram/logic/src/ 下（目录结构保持，所以 import 路径
// 一个字都不用改）；再把 config/campaign.json 包成 ESM 模块（小程序不能直接
// import .json），补上唯一版本号注入。
//
// 生成 MANIFEST.json：每个镜像文件的源路径 + sha256。check-map.mjs 会调
// `--check`，镜像与源一旦分叉就红灯，防止「搬过去的那份」悄悄变旧。
//
// 用法：
//   node scripts/sync-miniprogram.mjs           # 生成 / 刷新镜像
//   node scripts/sync-miniprogram.mjs --check  # 只校验，不写任何文件
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const sha = (b) => createHash('sha256').update(b).digest('hex');

// 小程序「最小可玩切片」需要的入口；闭包会自动带出全部依赖。
const ENTRIES = [
  'src/campaign.js', 'src/persist.js', 'src/save-slots.js',
  'src/outcome.js', 'src/platform/index.js', 'src/version.js',
];

// 渲染 / 装配 / 素材层绝不能被闭包带进小程序包：皮必须重写，引擎原样搬。
const FORBIDDEN = new Set([
  'src/main.js', 'src/map-render.js', 'src/atlas.js', 'src/ui-shell.js',
  'src/city-view.js', 'src/guandu.js', 'src/gongbi.js', 'src/ink-stroke.js',
  'src/portrait.js', 'src/general-portrait.js', 'src/soldier.js',
  'src/tutorial-ui.js', 'src/ticket-store.js', 'src/battle-session.js',
  'src/siege-combat.js',
]);

function closure() {
  const seen = new Set();
  const stack = [...ENTRIES];
  while (stack.length) {
    const p = normalize(stack.pop()).replace(/\\/g, '/');
    if (seen.has(p)) continue;
    if (FORBIDDEN.has(p)) {
      throw new Error(`依赖闭包撞进渲染/装配层：${p}（逻辑层不该依赖宿主）`);
    }
    const abs = join(root, p);
    if (!existsSync(abs)) throw new Error(`闭包引用了不存在的文件：${p}`);
    seen.add(p);
    const text = readFileSync(abs, 'utf8');
    for (const m of text.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) {
      const q = normalize(join(dirname(p), m[1])).replace(/\\/g, '/');
      if (!q.startsWith('src/') || !q.endsWith('.js')) continue;
      if (!existsSync(join(root, q))) throw new Error(`${p} 的 import 找不到 ${q}`);
      stack.push(q);
    }
  }
  return [...seen].sort();
}

const files = closure();
const cfgJson = readFileSync(join(root, 'config/campaign.json'), 'utf8');
const cfg = JSON.parse(cfgJson);
const version = readFileSync(join(root, 'src/version.js'), 'utf8').match(/VERSION\s*=\s*'([^']+)'/)?.[1];
if (!version) throw new Error('读不出 src/version.js 的 VERSION');

// config/campaign.json → miniprogram/logic/config/campaign.js
// 与主工程 boot() 同一口径：cfg.meta.version 由唯一版本常量注入。
const cfgModule = `// 由 scripts/sync-miniprogram.mjs 生成，勿手改。
// 小程序不能直接 import .json，这里把配置包成 ESM 模块；
// meta.version 与网页版 boot() 一样从 src/version.js 注入，全库仍只有一个版本数字。
import { VERSION } from '../src/version.js';
export const CAMPAIGN = ${JSON.stringify(cfg, null, 2)};
CAMPAIGN.meta ??= {};
CAMPAIGN.meta.version = VERSION;
`;

const manifest = {
  generatedBy: 'scripts/sync-miniprogram.mjs',
  sourceRoot: '../../',
  entries: ENTRIES,
  version,
  configSha256: sha(cfgJson),
  files: files.map((p) => ({ path: p, sha256: sha(readFileSync(join(root, p))) })),
  configModuleSha256: sha(cfgModule),
};

const OUT = join(root, 'miniprogram/logic');
const problems = [];

if (CHECK) {
  const mp = join(OUT, 'MANIFEST.json');
  if (!existsSync(mp)) { problems.push('缺 miniprogram/logic/MANIFEST.json'); }
  else {
    const old = JSON.parse(readFileSync(mp, 'utf8'));
    if (old.configSha256 !== manifest.configSha256) problems.push('config/campaign.json 变了，镜像没同步');
    if (old.configModuleSha256 !== manifest.configModuleSha256) problems.push('config 模块内容与镜像不一致');
    if (old.files.length !== manifest.files.length) problems.push('闭包文件数变了，镜像没同步');
    for (const f of manifest.files) {
      const dest = join(OUT, 'src', relative('src', f.path).replace(/\\/g, '/'));
      if (!existsSync(dest)) { problems.push(`镜像缺 ${f.path}`); continue; }
      if (sha(readFileSync(dest)) !== f.sha256) problems.push(`镜像与源不一致：${f.path}`);
    }
    const cm = join(OUT, 'config/campaign.js');
    if (!existsSync(cm) || sha(readFileSync(cm)) !== manifest.configModuleSha256) {
      problems.push('config/campaign.js 镜像与生成结果不一致');
    }
  }
  if (problems.length) {
    console.error('✗ 小程序逻辑层镜像校验失败（跑 node scripts/sync-miniprogram.mjs 刷新）：');
    for (const p of problems) console.error('   - ' + p);
    process.exit(1);
  }
  console.log(`✓ 小程序逻辑层镜像一致：${manifest.files.length} 个 .js + config 模块`);
  process.exit(0);
}

// 生成：先清掉旧镜像目录再写，避免残留上一次闭包里已删掉的文件。
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'src'), { recursive: true });
mkdirSync(join(OUT, 'config'), { recursive: true });
for (const f of manifest.files) {
  const dest = join(OUT, 'src', relative('src', f.path).replace(/\\/g, '/'));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(join(root, f.path)));
}
writeFileSync(join(OUT, 'config/campaign.js'), cfgModule);
writeFileSync(join(OUT, 'MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`✓ 已生成小程序逻辑层镜像：${manifest.files.length} 个 .js + config 模块（${OUT}）`);
console.log('  闭包：' + files.map((p) => p.replace('src/', '')).join(', '));
