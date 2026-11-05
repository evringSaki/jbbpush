'use strict';

/**
 * 数据完整性校验
 *
 * 目标不是“看起来抓到了”，而是能证明：
 *   - 活动清单（今日抢购/明日预告）是否全量：SSR 楼层数、DOM 卡片数、SKU 唯一性、必填字段完整率；
 *   - 推荐流是否翻页到底：hasNextPage / queryCode / pageNum 序列 / 接口 403 记录；
 *   - 与上一轮快照相比是否骤降（防止风控降级页写入基线）。
 */

function ratio(n, d) {
  return d ? n / d : 0;
}

function pct(n, d) {
  return `${(ratio(n, d) * 100).toFixed(1)}%`;
}

function buildAudit({ products, recommendations, seckill, feed, browser, previous, activityName, expectedTotal, requiredSkus }) {
  const checks = [];
  const add = (id, name, ok, level, detail) => checks.push({ id, name, ok, level, detail });

  const total = products.length;
  const skus = products.map((p) => p.sku);
  const unique = new Set(skus).size;
  const invalidSku = products.filter((p) => !/^\d{5,}$/.test(String(p.sku || ''))).length;
  const expected = Number(expectedTotal || 0);
  const required = Array.isArray(requiredSkus) ? requiredSkus.filter(Boolean) : [];

  add('activity_non_empty', '活动清单非空', total > 0, 'error', `解析到 ${total} 个商品`);
  add('activity_unique_sku', 'SKU 唯一且格式合法', unique === total && invalidSku === 0, 'error',
    `唯一 ${unique}/${total}，非法 SKU ${invalidSku} 个`);

  // 用户提供的真实总数（活动页实际 29 个）——这是「全量」的硬标准
  if (expected > 0) {
    add('expected_total', '商品总数达到预期', total >= expected, 'error',
      `已抓 ${total}/${expected}，缺 ${Math.max(0, expected - total)} 个`);
  }

  const missingRequired = required.filter((s) => !skus.includes(String(s)));
  if (required.length) {
    add('required_sku', '参考 SKU 已覆盖', missingRequired.length === 0, 'error',
      missingRequired.length ? `缺少 ${missingRequired.join(', ')}` : `已包含 ${required.join(', ')}`);
  }

  const need = (fn) => products.filter(fn).length;
  const nameOk = need((p) => p.name && p.name.length >= 2);
  const priceOk = need((p) => p.price !== null && p.price !== undefined);
  const timeOk = need((p) => p.saleTime && p.saleTime.start);
  const statusOk = need((p) => p.saleStatus && p.saleStatus !== 'unknown');
  const stockOk = need((p) => p.stock && p.stock.status && p.stock.status !== 'unknown');

  add('field_name', '商品名称完整率', total > 0 && nameOk === total, 'error', `${nameOk}/${total}（${pct(nameOk, total)}）`);
  add('field_price', '价格完整率', total > 0 && priceOk === total, 'error', `${priceOk}/${total}（${pct(priceOk, total)}）`);
  add('field_sale_time', '抢购时间完整率', total > 0 && timeOk === total, 'error', `${timeOk}/${total}（${pct(timeOk, total)}）`);
  add('field_sale_status', '销售状态完整率', total > 0 && statusOk === total, 'warn', `${statusOk}/${total}（${pct(statusOk, total)}）`);
  add('field_stock', '库存状态完整率', total > 0 && stockOk === total, 'warn', `${stockOk}/${total}（${pct(stockOk, total)}）`);

  // SSR 是否有分页（活动清单应该一次直出，不应分页）
  const sMeta = (seckill && seckill.meta) || null;
  const seckillPaginated = !!(sMeta && (sMeta.pagination === true || (sMeta.paginationParams || []).length > 1));
  add('activity_single_page', '活动清单为服务端一次直出', total > 0 && !seckillPaginated, 'error',
    sMeta ? `pagination=${sMeta.pagination}, paginationParams=${JSON.stringify(sMeta.paginationParams)}` : '无 SSR 元信息');

  // 原始 HTML 计数：只对比 SSR 来源的商品，浏览器/API 补充的 13 条不计入
  const ssrCount = products.filter((p) => p.source === 'ssr_app').length;
  const rawItemCount = sMeta && Number.isFinite(sMeta.rawItemIdentityCount) ? sMeta.rawItemIdentityCount : null;
  add('ssr_raw_count', '原始 HTML 商品标识数与 SSR 解析数一致',
    rawItemCount === null ? true : rawItemCount === ssrCount,
    'warn',
    rawItemCount === null
      ? '未统计原始计数'
      : `HTML itemIdentityId ${rawItemCount} 个，SSR 解析 ${ssrCount} 个${total > ssrCount ? `，浏览器补充 ${total - ssrCount} 个` : ''}`);

  // DOM 独立计数（浏览器通道启用时）
  const domCount = browser && browser.domCount ? browser.domCount : 0;
  if (domCount > 0) {
    const diff = Math.abs(domCount - total);
    const tolerance = Math.max(2, Math.ceil(total * 0.1));
    add('ssr_vs_dom', 'SSR 数量与页面卡片数一致', diff <= tolerance, 'error',
      `SSR ${total}，DOM 卡片 ${domCount}，容差 ±${tolerance}`);
  } else {
    add('ssr_vs_dom', 'SSR 数量与页面卡片数一致', true, 'info', '未启用浏览器通道，跳过 DOM 交叉计数');
  }

  // 推荐流翻页
  const fMeta = (feed && feed.meta) || null;
  const hasNext = !!(fMeta && fMeta.feedHasNextPage);
  const apiPages = browser ? (browser.pages || []).filter((p) => p.fid === 'queryBabelFeeds') : [];
  const pageNums = apiPages.map((p) => p.pageNum).filter((n) => Number.isFinite(n));
  const uniquePages = [...new Set(pageNums)].sort((a, b) => a - b);
  const pageGap = uniquePages.length > 1 && uniquePages.some((n, i) => i > 0 && n !== uniquePages[i - 1] + 1);
  const feedEnded = !!(browser && browser.apiEnded);
  const feedBlocked = !!(browser && browser.apiBlocked);

  add('feed_pagination', '推荐流分页是否到底',
    !hasNext || feedEnded,
    'warn',
    hasNext
      ? `hasNextPage=true；已截获页码 [${uniquePages.join(',') || '无'}]；接口${feedBlocked ? ' 403/失败' : '未明确结束'}`
      : 'hasNextPage=false，无下一页');

  const rawWare = fMeta && Number.isFinite(fMeta.rawWareIdCount) ? fMeta.rawWareIdCount : null;
  add('feed_raw_count', '推荐流原始商品数与解析数一致',
    rawWare === null || !fMeta ? true : rawWare === fMeta.feedCount,
    'info',
    rawWare === null || !fMeta ? '未统计原始计数' : `HTML wareId ${rawWare} 个，解析 ${fMeta.feedCount} 个`);

  if (uniquePages.length) {
    add('feed_page_sequence', '页码连续无跳号', !pageGap, 'warn',
      `页码序列 [${uniquePages.join(',')}]${pageGap ? '（存在跳号）' : ''}`);
  }

  // 两套构建的商品重合度（应接近 0：App 楼层是活动清单，H5 feed 是推荐位）
  const recSkus = new Set((recommendations || []).map((p) => p.sku));
  const overlap = products.filter((p) => recSkus.has(p.sku)).length;
  add('cross_source_overlap', '活动清单与推荐流来源区分', true, 'info',
    `交集 ${overlap} 个；活动 ${total}，推荐 ${recSkus.size}${overlap === 0 ? '（两套构建商品集合不重叠，推荐流不应计入活动清单）' : ''}`);

  // 与上一轮快照比，防止风控降级页
  if (previous && Number.isFinite(previous.total) && previous.total > 0) {
    const drop = total < previous.total * 0.7;
    add('baseline_drop', '对比上一轮未骤降', !drop, 'warn',
      `本轮 ${total}，上轮 ${previous.total}${drop ? '（疑似降级页/活动换场）' : ''}`);
  }

  const errors = checks.filter((c) => !c.ok && c.level === 'error');
  const warnings = checks.filter((c) => !c.ok && c.level === 'warn');
  const activityComplete = errors.length === 0 && total > 0;
  const feedComplete = !hasNext || feedEnded;

  return {
    ok: activityComplete,
    complete: activityComplete,
    feedComplete,
    activityName: activityName || '',
    counts: {
      activityTotal: total,
      expectedTotal: expected || null,
      missing: expected > 0 ? Math.max(0, expected - total) : null,
      requiredSkus: required,
      missingRequired,
      today: products.filter((p) => p.activityTab === '今日抢购').length,
      tomorrow: products.filter((p) => p.activityTab === '明日预告').length,
      recommendations: recommendations ? recommendations.length : 0,
      ssrSeckillCount: sMeta ? sMeta.seckillCount : null,
      ssrFeedCount: fMeta ? fMeta.feedCount : null,
      domCount,
      apiPages: uniquePages.length,
      apiPageNums: uniquePages,
      feedHasNextPage: hasNext,
      feedBlocked,
      feedEnded,
    },
    checks,
    errors: errors.map((e) => e.detail),
    warnings: warnings.map((e) => e.detail),
  };
}

module.exports = { buildAudit };
