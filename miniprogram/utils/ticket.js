// 军令帖编解码 · 小程序端。
// 与主工程 src/sync.js 的 encodeTicket / decodeTicket 产出逐字一致，
// 但不依赖 TextEncoder / Buffer / btoa / atob —— 小程序 JS 运行时没有这些宿主 API。
// tests/miniprogram.test.mjs 用 Node 同时 import 两端，对中文与增补平面字符做交叉校验。
const TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const REV = (() => { const m = {}; for (let i = 0; i < TABLE.length; i++) m[TABLE[i]] = i; return m; })();

/** UTF-8 编码：手写以覆盖代理对（codePoint > 0xFFFF）。 */
function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
      0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return out;
}

function utf8Decode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length;) {
    const a = bytes[i++];
    let cp;
    if (a < 0x80) cp = a;
    else if ((a & 0xe0) === 0xc0) cp = ((a & 31) << 6) | (bytes[i++] & 63);
    else if ((a & 0xf0) === 0xe0) cp = ((a & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else cp = ((a & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    if (cp > 0xffff) { cp -= 0x10000; s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023)); }
    else s += String.fromCharCode(cp);
  }
  return s;
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : null, c = i + 2 < bytes.length ? bytes[i + 2] : null;
    s += TABLE[a >> 2];
    s += TABLE[((a & 3) << 4) | (b === null ? 0 : b >> 4)];
    s += b === null ? '=' : TABLE[((b & 15) << 2) | (c === null ? 0 : c >> 6)];
    s += c === null ? '=' : TABLE[c & 63];
  }
  return s;
}

function fromBase64(str) {
  const out = [];
  let acc = 0, bits = 0;
  for (const ch of str) {
    if (ch === '=') break;
    const v = REV[ch];
    if (v === undefined) throw new Error('军令帖含非法字符');
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); acc &= (1 << bits) - 1; }
  }
  return out;
}

export function encodeTicket(obj) {
  return toBase64(utf8Bytes(JSON.stringify(obj)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeTicket(str) {
  const padded = String(str ?? '').replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(utf8Decode(fromBase64(padded)));
}

/** 只做字段完整性检查，不重放局面（本验证版不带策略层）。 */
export function inspectTicket(str) {
  const text = String(str ?? '').trim();
  if (!text) throw new Error('请先粘贴军令帖');
  const d = decodeTicket(text);
  if (d.game !== 'sanguo-ce-guandu') throw new Error('不是三国策的军令帖');
  if (!d.save || d.save.v !== 1) throw new Error('存档格式不兼容');
  return {
    game: d.game, version: d.version ?? '—', date: d.date ?? '—',
    hash: d.hash ?? '—', mapId: d.save.mapId ?? 'guandu',
    turn: d.save.turn ?? 0, logTail: Array.isArray(d.logTail) ? d.logTail.length : 0,
    chars: text.length,
  };
}
