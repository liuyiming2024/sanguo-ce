// 确定性伪随机源。状态是一个 uint32 整数 + 调用计数，可序列化进快照；
// 快进空跑与实时跑必须用同一序列，否则「离开一个月再点进来」结局会分叉。
export function createRng(seed = 20261114) {
  let state = seed >>> 0;
  let calls = 0;

  function next() {
    calls++;
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  return {
    next,
    chance: (p) => next() < p,
    int: (n) => Math.floor(next() * n),
    range: (a, b) => a + next() * (b - a),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** 只有快照/快进用；恢复后下一次 next() 必须与离开前完全一致。 */
    snapshot: () => ({ state, calls }),
    restore(s) {
      if (!Number.isInteger(s?.state) || !Number.isInteger(s?.calls)) {
        throw new Error('rng 快照不合法');
      }
      state = s.state >>> 0;
      calls = s.calls;
    },
  };
}

export function rngFromSnapshot(s) {
  const r = createRng(0);
  r.restore(s);
  return r;
}
