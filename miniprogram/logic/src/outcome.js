// 终局判定：纯逻辑，只读 state，不写任何字段，因此不进状态指纹、不进命令日志。
// 率土-like 的「输了怎么办」：城池尽失即败，敌城尽取即胜，章回终局另记。
// 界面读到终局后停自动推进，给「读档 / 新开一局」两条路，不偷偷重开。

/** @returns {{ over: boolean, kind: 'playing'|'defeat'|'victory', title: string, body: string }} */
export function checkOutcome(state) {
  if (!state?.cities) return { over: false, kind: 'playing', title: '', body: '' };
  const pf = state.playerFaction;
  const all = Object.values(state.cities);
  const own = all.filter((c) => c.owner === pf);
  const hostile = all.filter((c) => c.owner !== pf && c.owner);

  if (own.length === 0) {
    return { over: true, kind: 'defeat', title: '行 台 已 失',
      body: `${all.length} 城尽属他姓，司空府再无寸土可奉檄。此局终。` };
  }
  if (hostile.length === 0) {
    return { over: true, kind: 'victory', title: '河 北 粗 定',
      body: `诸城尽入麾下，得城 ${own.length} 座。章回可续，此局亦可另开。` };
  }
  // 全面断粮且守军崩溃：不是硬性判负，但给一条明显警讯。
  const starving = own.filter((c) => c.starving).length;
  const broken = own.every((c) => c.garrison < 120 && c.morale < 20);
  if (starving === own.length && broken) {
    return { over: true, kind: 'defeat', title: '粮 尽 众 散',
      body: `${own.length} 城俱断粮，守军溃散，军心尽失。此局终。` };
  }
  return { over: false, kind: 'playing', title: '', body: '' };
}

/** 给系统页看的局面摘要，不参与判定。 */
export function outcomeSummary(state) {
  const all = Object.values(state.cities ?? {});
  const pf = state.playerFaction;
  const own = all.filter((c) => c.owner === pf);
  return { own: own.length, total: all.length,
    starving: own.filter((c) => c.starving).length,
    hostile: all.filter((c) => c.owner !== pf && c.owner).length };
}
