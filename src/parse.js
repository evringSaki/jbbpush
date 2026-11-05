'use strict';

/**
 * 页面解析
 *
 * 所有商品都在 window.__react_data__ 里，不需要执行 JS：
 *   - App 构建（h5static）：activityData.floorList[].tabList[].secondTabList[].floorList[].providerData[]
 *   - H5  构建（pro.m）  ：activityData.floorList[].providerData.feeds.goodsList[]
 *
 * 这里用「括号配对 + 递归遍历」而不是整体 JSON.parse 页面，避免脚本里混入非法字符时整页失败。
 */

function extractReactData(html) {
  const m = /window\.__react_data__\s*=\s*/.exec(html || '');
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch (e) {
          return { __parseError: e.message };
        }
      }
    }
  }
  return null;
}

/**
 * 递归收集商品与 feed 楼层，并携带所在 tab 名称
 * 返回 { seckill: [{tab, node}], feeds: [{tab, feeds}], tabs: string[] }
 */
function collect(activityData) {
  const out = { seckill: [], feeds: [], tabs: [] };

  function walk(node, tabName) {
    if (Array.isArray(node)) {
      for (const v of node) walk(v, tabName);
      return;
    }
    if (!node || typeof node !== 'object') return;

    // 进入多 tab 容器时切换 tab 名称（tab 对象带 name + secondTabList/floorList）
    let nextTab = tabName;
    if (typeof node.name === 'string' && node.name.trim() &&
        (Array.isArray(node.secondTabList) || Array.isArray(node.floorList))) {
      nextTab = node.name.trim();
      if (!out.tabs.includes(nextTab)) out.tabs.push(nextTab);
    }

    // App 构建：一个 SKU 一个楼层
    if (node.itemIdentityId && node.productResult && typeof node.productResult === 'object') {
      out.seckill.push({ tab: nextTab, node });
      return; // 商品对象内部不再递归，避免重复
    }

    // H5 构建：推荐流楼层
    if (node.feeds && typeof node.feeds === 'object' && Array.isArray(node.feeds.goodsList)) {
      out.feeds.push({ tab: nextTab, feeds: node.feeds });
    }

    for (const [k, v] of Object.entries(node)) {
      if (k === 'productResult') continue;
      walk(v, nextTab);
    }
  }

  walk(activityData, '');
  return out;
}

/** 活动级别元信息：分页、登录态、活动 ID */
function buildMeta(data, collected) {
  const ad = (data && data.activityData) || {};
  const info = (data && data.activityInfo) || {};
  const feedMeta = collected.feeds.map((f) => ({
    tab: f.tab,
    count: f.feeds.goodsList.length,
    hasNextPage: f.feeds.hasNextPage === true,
    firstPage: f.feeds.firstPage === true,
    pageId: f.feeds.pageId || '',
    tabs: Array.isArray(f.feeds.tabs)
      ? f.feeds.tabs.map((t) => t.sceneWordName || t.name || '').filter(Boolean)
      : [],
  }));

  return {
    activityId: ad.activityId || info.activityId || '',
    pageId: ad.pageId || '',
    isLogin: ad.isLogin === true,
    pagination: ad.pagination === true,
    paginationParams: Array.isArray(ad.paginationParams) ? ad.paginationParams : [],
    paginationParamEnd: ad.paginationParamEnd || '',
    tabs: collected.tabs,
    seckillCount: collected.seckill.length,
    feedMeta,
    feedHasNextPage: feedMeta.some((f) => f.hasNextPage),
    feedCount: feedMeta.reduce((n, f) => n + f.count, 0),
    transParamPresent: typeof ad.transParam === 'string' && ad.transParam.length > 0,
    activityVersion: info.activeVersionId || ad.activeVersionId || '',
  };
}

function parseActivity(html) {
  const data = extractReactData(html);
  if (!data) return { ok: false, error: '未找到 window.__react_data__', data: null };
  if (data.__parseError) return { ok: false, error: `__react_data__ 解析失败: ${data.__parseError}`, data: null };
  const collected = collect((data.activityData) || {});
  const meta = buildMeta(data, collected);
  return { ok: true, error: '', data, collected, meta };
}

/** 取 H5 页 <title> 作为活动名（App 页 title 为空） */
function extractActivityName(html, fallback = '') {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  const t = m ? m[1].replace(/\s+/g, ' ').trim() : '';
  return t || fallback;
}

module.exports = { extractReactData, collect, buildMeta, parseActivity, extractActivityName };
