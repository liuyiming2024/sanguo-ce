// 证据台账口径护栏：平台传输层截断标记不是使用者欠的一段内容。
// 2026-11-20 翻案后立，防止后来人再把 <truncated> 登记成「待补全」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');
const B = read('docs/evidence/会话B-界面与画风评审.md');
const C = read('docs/evidence/会话C-他项目会话.md');

test('两份归档副本不含平台字面截断标记，也不向使用者挂待补全欠账', () => {
  for (const [name, s] of [['B', B], ['C', C]]) {
    assert.ok(!s.includes('<truncated>'), `${name} 仍把平台标记写进正文`);
    assert.ok(!s.includes('【截断，待补全】'), `${name} 仍挂待补全`);
    assert.ok(!s.includes('需使用者从原页末尾复制'), `${name} 仍写需使用者补`);
    assert.match(s, /传输层/);
    assert.match(s, /非原件缺失/);
    assert.match(s, /本会话收到的副本/);
  }
});

test('其余台账不得再把副本边界算作未闭环', () => {
  const all = [read('docs/创作决策日志.md'), read('docs/军令帖短号中转说明.md'),
    read('docs/建安五年官渡舆图史料汇总.md'),
    read('docs/evidence/screens-实拍清单.md')].join('\n');
  for (const bad of ['【截断，待补全】', '需使用者从原页末尾复制', '两份分享页末尾截断段，仍未闭环']) {
    assert.ok(!all.includes(bad), `台账仍有旧口径：${bad.slice(0, 12)}`);
  }
});

test('软著 AI 声明政策全本在仓库，且写明关键口径', () => {
  assert.ok(existsSync(join(root, 'docs/软著登记AI声明政策梳理.md')));
  const d = read('docs/软著登记AI声明政策梳理.md');
  for (const k of ['2026-03-15', '未使用 AI 开发编写代码', '失信名单', '个人征信',
                   '500–1300', '提交前', '后台开发用 · 白话 · 不进游戏']) {
    assert.ok(d.includes(k), `政策文档缺 ${k}`);
  }
});
