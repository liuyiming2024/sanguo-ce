// 武将五维与设施等级（v0.9.1）。纯逻辑、确定性，不显示数值，只进公式。
// 统率→士气/带兵上限；武力→近战；智力→远程与计策；政治→城防修复；忠诚→被擒招降。
export function generalFor(cfg, campaign, cityId) {
  const G = cfg.generals;
  const named = G?.perCity?.[cityId];
  if (named) return { ...G.base, ...named };
  let h = 2166136261;
  for (const ch of cityId) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const j = (n) => ((h >>> n) % 31) - 15;
  return { ...G.base, name: `${campaign.cities[cityId]?.name ?? cityId}守将`,
    command: G.base.command + j(3), force: G.base.force + j(7),
    intellect: G.base.intellect + j(11), politics: G.base.politics + j(15),
    loyalty: G.base.loyalty + j(19) };
}

/** 设施是全局 {id: level}；按城查询时兼容按城存法，取等级总和。 */
export function facilityLevel(state, cityId) {
  const f = state.facilities?.[cityId] ?? state.facilities;
  if (f == null) return 0;
  if (typeof f === 'number') return Math.max(0, f | 0);
  const vals = Array.isArray(f) ? f : Object.values(f);
  return vals.reduce((s, v) => s + (Number(v) > 0 ? Number(v) : 0), 0);
}
