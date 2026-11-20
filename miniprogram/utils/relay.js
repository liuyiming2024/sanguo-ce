// 短号工具 · 小程序端。
// 只做「短号长什么样」的校验与提示，纯文本、零外部网络请求。
// 整帖的存取在 Web 传帖台完成：小程序拿到短号，发给对方；对方到传帖台兑换整帖，
// 或把整帖粘回本页 / 网页版「导入」接续一旬。
// 为什么不在这里直接取帖：小程序若要访问外部服务，需配置 request 合法域名，
// 而第三方项目域名无法由本主体备案。见 docs/军令帖短号中转说明.md §六。
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const LENGTH = 6;

export function normalizeShortId(raw) {
  const s = String(raw ?? '').trim().toUpperCase().replace(/[\s\-—_]/g, '');
  if (!new RegExp(`^[${ALPHABET}]{${LENGTH}}$`).test(s)) {
    throw new Error('短号须为 6 位，且不含 0 / 1 / I / O');
  }
  return s;
}

export function shortIdHint() {
  return '短号只是取件码，不是整帖。发给对方后，请到「传帖台」兑换；本页不联网、不存远端。';
}
