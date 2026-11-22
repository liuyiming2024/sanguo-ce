// 轻量「军令帖」终端：只管把一局传下去，不带战场、不带地图、不带策略层。
// 主路径：复制口令 → 微信会话粘贴 → 对方粘进本页校验 / 或粘回 Web 版「导入」。
// 不发起任何外部网络请求，不接云开发，零外部域名、零位图。
import { inspectTicket } from '../../utils/ticket.js';
import { normalizeShortId, shortIdHint } from '../../utils/relay.js';

const KEY = 'sg:tickets';

Page({
  data: {
    text: '',
    shortId: '',
    shortHint: shortIdHint(),
    info: null,
    err: '',
    recent: [],
  },

  onLoad(options) {
    const sid = String(options?.sid || '').toUpperCase();
    this.setData({
      recent: wx.getStorageSync(KEY) || [],
      shortId: /^[2-9A-HJ-NP-Z]{6}$/.test(sid) ? sid : '',
    });
  },

  onInput(e) {
    this.setData({ text: e.detail.value, err: '', info: null });
  },

  onShortInput(e) {
    this.setData({ shortId: String(e.detail.value || '').toUpperCase(), err: '' });
  },

  onCopyShort() {
    try {
      const id = normalizeShortId(this.data.shortId);
      this.setData({ shortId: id });
      wx.setClipboardData({
        data: id,
        success: () => wx.showToast({ title: '短号已复制，发给对方', icon: 'none' }),
      });
    } catch (e) {
      wx.showToast({ title: e.message || '短号格式不对', icon: 'none' });
    }
  },

  onPaste() {
    wx.getClipboardData({
      success: (r) => this.setData({ text: r.data || '', err: '', info: null }),
      fail: () => wx.showToast({ title: '读剪贴板失败', icon: 'none' }),
    });
  },

  onInspect() {
    try {
      const info = inspectTicket(this.data.text);
      this.setData({ info, err: '' });
      wx.showToast({ title: '军令帖可解', icon: 'success' });
    } catch (e) {
      this.setData({ info: null, err: e.message || '口令无法解析' });
      wx.showToast({ title: '口令无法解析', icon: 'none' });
    }
  },

  onCopy() {
    const t = String(this.data.text || '').trim();
    if (!t) { wx.showToast({ title: '先粘贴或读出帖', icon: 'none' }); return; }
    wx.setClipboardData({
      data: t,
      success: () => wx.showToast({ title: '已复制，发给好友即可', icon: 'none' }),
    });
  },

  onKeep() {
    try {
      const info = inspectTicket(this.data.text);
      const item = {
        at: Date.now(), date: info.date, mapId: info.mapId, turn: info.turn,
        hash: info.hash, chars: info.chars, text: String(this.data.text).trim(),
        shortId: this.data.shortId || '',
      };
      const recent = [item, ...(this.data.recent || [])]
        .filter((x, i, a) => a.findIndex((y) => y.hash === x.hash && y.turn === x.turn) === i)
        .slice(0, 3);
      wx.setStorageSync(KEY, recent);
      this.setData({ recent });
      wx.showToast({ title: '已存本机（仅留最近 3 帖）', icon: 'none' });
    } catch (e) {
      wx.showToast({ title: e.message || '无法留存', icon: 'none' });
    }
  },

  onUse(e) {
    const i = Number(e.currentTarget.dataset.i);
    const item = (this.data.recent || [])[i];
    if (!item) return;
    this.setData({ text: item.text, shortId: item.shortId || '', err: '', info: null });
    wx.showToast({ title: '已取回，可复制', icon: 'none' });
  },

  onClear() {
    wx.removeStorageSync(KEY);
    this.setData({ text: '', shortId: '', info: null, err: '', recent: [] });
    wx.showToast({ title: '已清空', icon: 'none' });
  },

  onSlice() {
    wx.navigateTo({ url: '/pages/slice/index' });
  },

  onShareAppMessage() {
    // 分享 path 仍不携带整段口令（几千字符会被截断），但可以带六位短号。
    // 短号只是取件码：对方点开卡片看到它，去「传帖台」兑换整帖；本页不联网。
    let sid = '';
    try { sid = normalizeShortId(this.data.shortId); } catch { /* 没填或格式不对就不带 */ }
    const has = !!(this.data.text || '').trim();
    return {
      title: sid ? `三国策 · 军令帖 ${sid}` : (has ? '三国策 · 有军令帖待传，接一旬' : '三国策 · 军令帖'),
      path: `/pages/index/index${sid ? `?sid=${sid}` : ''}`,
    };
  },
});
