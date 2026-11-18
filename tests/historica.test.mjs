// v0.9.4：游戏内典籍（文言）与后台文档（白话）必须分工；版本号只有一个常量。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { VERSION } from '../src/version.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const hist = JSON.parse(read('config/historica.json'));
const doc = read('docs/建安五年官渡舆图史料汇总.md');
const atlas = read('src/atlas.js');
const render = read('src/map-render.js');
const shell = read('src/ui-shell.js');

test('版本号：大版本号保持 0，全库唯一的带引号版本字面量在 version.js', () => {
  assert.match(VERSION, /^0\.\d+\.\d+$/);
  assert.equal(read('config/campaign.json').includes('"version"'), false);
  assert.equal(read('package.json').includes('"version"'), false);
  assert.equal(read('assets/units/trooper.json').includes('"version"'), false);
  assert.equal(read('index.html').includes('?v=0.'), false);
  assert.equal(read('src/version.js').includes(`'${VERSION}'`), true);
});

test('典籍六门齐全，每条有题 / 文言 / 出处 / A·B·C 级', () => {
  assert.deepEqual(hist.cats.map((c) => c.id),
    ['benji', 'yudi', 'tufa', 'xingzhi', 'yiyi', 'shumu']);
  let total = 0;
  for (const c of hist.cats) {
    assert.ok(c.name && c.glyph && c.intro, `${c.id} 缺门名/字/小引`);
    assert.ok(c.items.length >= 6, `${c.id} 条目过少`);
    for (const it of c.items) {
      assert.ok(it.t && it.s && it.n, `${c.id} 有条目缺字段`);
      assert.match(it.lv, /^[ABC]$/);
      total++;
    }
  }
  assert.ok(total >= 45, `典籍条目只有 ${total} 条，不够「总揽」`);
});

test('游戏内只呈文言：不漏 URL、白话形制辨正、出土年份', () => {
  const raw = read('config/historica.json');
  assert.equal(/https?:\/\//.test(raw), false);
  for (const w of ['亭是带围墙', '1957', '新野北安乐寨', '305 座', '南宋苏州', '后台营造']) {
    assert.equal(raw.includes(w), false, `白话细目「${w}」漏进了游戏内`);
  }
  assert.match(hist.meta.preface, /^汉室既微/);
  assert.match(hist.meta.colophon, /别载图籍/);
});

test('后台文档有总揽 / 细目 / 取舍 / 重难四章，且明确「不进游戏」', () => {
  for (const s of ['## 12. 史料总揽', '## 13. 细目考据存目', '## 14. 游戏内', '## 15. 重难']) {
    assert.ok(doc.includes(s), `缺 ${s}`);
  }
  assert.match(doc, /实施总纲|疑难点|落地文件/);
  assert.match(doc, /后台营造用 · 白话，不进游戏/);
  assert.match(doc, /config\/historica\.json/);
  assert.ok(doc.includes('床弩') && doc.includes('《武经总要》'), '文档未收本作战场单位形制');
});

test('全境舆图内核：确定性、零位图、参数化，且战区只贴背景层', () => {
  assert.match(atlas, /export function createAtlas/);
  assert.match(atlas, /opts\.LON0 \?\? 93/);
  assert.doesNotMatch(atlas, /Math\.random|Date\.now|performance\.now|new Image|addEventListener|document\.getElementById/);
  assert.match(render, /fg: false/);
  assert.match(render, /g\.drawImage\(a\.bg, 0, 0, W, H\)/);
  assert.doesNotMatch(render, /g\.drawImage\(a\.fg/);
  assert.match(render, /LON0: 112\.75, LON1: 116\.15/);
});

test('界面装配：典籍页 / 全境页 / 纸页 / 入口 / canvas 挂载齐全', () => {
  assert.match(shell, /archive: pageArchive, atlasView: pageAtlasView/);
  assert.match(shell, /'archive', 'atlasView'/);
  assert.match(shell, /data-act="archive"/);
  assert.match(shell, /mountAtlas\(\)/);
  assert.match(shell, /createAtlas\(\{\}\)/);
  assert.equal((shell.match(/data-act="archive"/g) ?? []).length >= 3, true,
    '纪事 / 天下 / 系统 三处都要有典籍入口');
});

test('对面 docs / demos / 许可文件保留，没有被覆盖', () => {
  for (const p of ['docs/十三州全境取数表.md', 'docs/背景层落地清单.md',
    'docs/毛笔笔势与古舆图参考资料.md', 'demos/建安五年全境舆图.html',
    'demos/官渡舆图笔势重绘.html', 'demos/third-party/ATTRIBUTION.md']) {
    assert.ok(existsSync(new URL(`../${p}`, import.meta.url)), `缺 ${p}`);
  }
});
