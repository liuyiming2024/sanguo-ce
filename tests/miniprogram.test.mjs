// 轻量小程序验证：只验「军令帖能跨端逐字传」，不搬战场 / 地图 / 策略层。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { encodeTicket as webEncode, decodeTicket as webDecode } from '../src/sync.js';
import { encodeTicket as mpEncode, decodeTicket as mpDecode, inspectTicket } from '../miniprogram/utils/ticket.js';
import { normalizeShortId, shortIdHint } from '../miniprogram/utils/relay.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const MP = 'miniprogram/';

const samples = [
  { v: 1, game: 'sanguo-ce-guandu', version: '0.9.4', date: '建安五年 正月初一', hash: 'a1b2c3d4e5f60718' },
  { save: { v: 1, mapId: 'quanjing', turn: 11, cities: { 邺: { owner: 'yuan' }, 新野: { owner: 'liu' } } }, logTail: [] },
  { note: '汉字 / 假名 / 한글 / Latin / 123 / ~!@#$%^&*()_+ / 「」《》·—', arr: [1, 2, 3] },
  { emoji: '🏯📜⚔️🀄', astral: '𠀀𪜀', mixed: '许都·官渡 𠔥' },   // 增补平面，验手写 UTF-8 代理对
  { v: 1, game: 'sanguo-ce-guandu', date: '建安七年 四月', hash: '0123456789abcdef',
    save: { v: 1, mapId: 'guandu', turn: 42, reports: [{ title: '仓亭捷报', tag: '纪事' }] },
    logTail: Array.from({ length: 12 }, (_, i) => ({ seq: i, turn: i, type: 'advanceTurn' })) },
];

test('两端编码逐字一致、交叉解码无损（含中文与增补平面字符）', () => {
  for (const obj of samples) {
    const a = webEncode(obj), b = mpEncode(obj);
    assert.equal(b, a, '小程序端 base64url 与主工程结果不一致');
    assert.deepEqual(mpDecode(a), obj, '小程序端解不开主工程的帖');
    assert.deepEqual(webDecode(b), obj, '主工程解不开小程序端的帖');
  }
});

test('inspectTicket 只校字段不重放：正常帖、错帖、缺存档都给确定结果', () => {
  const good = {
    v: 1, game: 'sanguo-ce-guandu', version: '0.9.4', date: '建安六年 三月',
    hash: 'deadbeefcafebabe', save: { v: 1, mapId: 'quanjing', turn: 6 }, logTail: [{ seq: 0 }],
  };
  const info = inspectTicket(mpEncode(good));
  assert.equal(info.mapId, 'quanjing');
  assert.equal(info.turn, 6);
  assert.equal(info.logTail, 1);
  assert.equal(info.hash, 'deadbeefcafebabe');
  assert.equal(info.chars, mpEncode(good).length);
  assert.throws(() => inspectTicket(''), /请先粘贴/);
  assert.throws(() => inspectTicket(mpEncode({ game: 'other' })), /不是三国策/);
  assert.throws(() => inspectTicket(mpEncode({ game: 'sanguo-ce-guandu', save: { v: 2 } })), /存档格式不兼容/);
  assert.throws(() => inspectTicket('!!!not-base64!!!'), /非法字符|Unexpected|JSON/);
});

test('小程序工程齐全：页面注册、零外部请求、零位图、不搬策略层', () => {
  const app = JSON.parse(read(MP + 'app.json'));
  // P2 之后多一页「最小可玩切片」；传帖台首页仍是第一页，不能挤掉。
  assert.deepEqual(app.pages, ['pages/index/index', 'pages/slice/index', 'pages/canvas/index']);
  for (const p of app.pages) {
    for (const ext of ['.wxml', '.wxss', '.js', '.json']) {
      assert.ok(existsSync(new URL(`../${MP}${p}${ext}`, import.meta.url)), `缺 ${p}${ext}`);
    }
  }
  assert.ok(existsSync(new URL(`../${MP}project.config.json`, import.meta.url)));
  assert.ok(existsSync(new URL(`../${MP}sitemap.json`, import.meta.url)));
  // 传帖台链路（app / ticket / relay / index 页）仍不许碰策略层与外部请求。
  // P2 的策略层只允许以「镜像」形式存在于 logic/ 与 pages/slice/，见
  // tests/miniprogram-slice.test.mjs 单独验。
  const js = [read(MP + 'app.js'), read(MP + 'utils/ticket.js'),
    read(MP + 'utils/relay.js'), read(MP + 'pages/index/index.js')].join('\n');
  for (const banned of ['wx.request', 'wx.connectSocket', 'https://', 'http://', 'drawImage', 'new Image']) {
    assert.equal(js.includes(banned), false, `传帖台链路出现「${banned}」，会引入备案域名 / 渲染依赖`);
  }
  const wxml = read(MP + 'pages/index/index.wxml');
  assert.equal(wxml.includes('<image'), false, '验证版不该有位图元素');
  const all = [];
  const walk = (rel) => {
    for (const n of readdirSync(new URL(`../${MP}${rel}`, import.meta.url), { withFileTypes: true })) {
      const p = rel + n.name;
      // subpackages 产物目录由 npm run assets:build 本地生成、.gitignore 不进仓库；
      // 主包仍必须零位图。分包体积另由 scripts/mp-assets.mjs --check 守着。
      if (n.isDirectory() && p === 'assets') continue;
      if (n.isDirectory()) walk(p + '/'); else all.push(p);
    }
  };
  walk('');
  assert.equal(all.some((p) => /\.(png|jpe?g|webp|gif|svg)$/i.test(p)), false, '主包出现位图');
  assert.ok(all.length >= 10, `小程序文件过少：${all.length}`);
  assert.equal(js.includes('createCampaign') || js.includes('advanceTurn'), false,
    '传帖台链路不该碰策略层（策略层只在 logic/ 镜像与切片页里）');
  // P2 新增：镜像存在且由同步脚本生成，切片页确实接了它。
  assert.ok(existsSync(new URL(`../${MP}logic/MANIFEST.json`, import.meta.url)),
    '缺 logic/MANIFEST.json：跑 node scripts/sync-miniprogram.mjs');
  const slice = read(MP + 'pages/slice/index.js');
  assert.match(slice, /bootSlice|pushTurn|hideSlice|showSlice/);
});

test('短号只作纯文本取件码：格式、分享 path、零联网', () => {
  assert.equal(normalizeShortId(' k7m-2qp '), 'K7M2QP');
  for (const bad of ['', 'K7M2Q', 'K7M2QP0', 'K7M2Q!']) {
    assert.throws(() => normalizeShortId(bad), /6 位/);
  }
  assert.match(shortIdHint(), /传帖台/);
  const page = read(MP + 'pages/index/index.js');
  assert.match(page, /\?sid=/, '分享卡片应带六位短号');
  const pathLine = page.split('\n').find((l) => l.includes('path: `/pages/index/index'));
  assert.ok(pathLine, '缺分享 path');
  assert.equal(pathLine.includes('text'), false, '分享 path 不该拼进整帖');
  assert.equal(page.includes('wx.request'), false, '小程序端不联网兑换');
  const relay = read(MP + 'utils/relay.js');
  for (const banned of ['wx.request', 'wx.connectSocket', 'https://', 'http://']) {
    assert.equal(relay.includes(banned), false, `短号工具出现「${banned}」`);
  }
});

test('README 如实写明限制：分享 path 不承载整段口令、短号不联网兑换、合规未启动', () => {
  const doc = read(MP + 'README.md');
  for (const s of ['不是发布版', '剪贴板', '备案', '个人主体', '主工程', '传帖台', '不联网']) {
    assert.ok(doc.includes(s), `README 缺「${s}」`);
  }
});
