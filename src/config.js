'use strict';

/**
 * 全局配置
 *
 * 目标活动：京东「超级补贴 · 超级加倍补」今日抢购
 * 页面有两套服务端渲染（SSR）构建，商品集合完全不同：
 *   1) h5static  App 内置页：商品在 __react_data__.activityData.floorList[].tabList[].secondTabList[].floorList[].providerData[]
 *       —— 这是「今日抢购」真正的活动清单（实测 16 条，含库存/开抢时间/标签），首屏全量直出
 *   2) pro.m     H5 页：商品在 ...providerData.feeds.goodsList[]（实测 19 条），属于推荐位，
 *      且 feeds.hasNextPage=true，翻页要走带 h5st 签名的 queryBabelFeeds 接口
 *
 * 程序把 1) 作为活动清单主数据源，2) 作为补充/推荐位数据源，二者分开统计，避免把推荐流算成活动商品。
 */

const DEFAULT_ACTIVITY_ID = 'USFY4Q1KPsHd54cN8AVUPHZdHpT';
const DEFAULT_QUERY = 'babelChannel=ttt3&homepagebybt=1&secJump=1&visitScene=1';

// 支持直接传完整活动 URL：自动解析活动 ID 与查询参数（活动参数必须原样传给服务端）
const INPUT_URL = String(process.env.ACTIVITY_URL || '').trim();
let parsedId = '';
let parsedQuery = '';
if (INPUT_URL) {
  const m = /\/mall\/active\/([A-Za-z0-9]+)\/index\.html(?:\?([^#]*))?/i.exec(INPUT_URL);
  if (m) {
    parsedId = m[1];
    parsedQuery = m[2] || '';
  }
}

const ACTIVITY_ID = process.env.ACTIVITY_ID || parsedId || DEFAULT_ACTIVITY_ID;

// App 分享链接参数：不加这些参数，服务端可能返回另一套 feed（商品更少）
const ENTRY_QUERY = process.env.ENTRY_QUERY || parsedQuery || DEFAULT_QUERY;

// 用户提供的该活动实际商品总数与参考 SKU（2026-11-06：实际 29 个，参考古井贡酒 SKU）
// 仅对当前活动生效；换活动时用 EXPECTED_TOTAL=0 关闭，或显式传 --expect N
const DEFAULT_EXPECTED_TOTAL = ACTIVITY_ID === 'USFY4Q1KPsHd54cN8AVUPHZdHpT' ? 29 : 0;
const EXPECTED_TOTAL = Number(process.env.EXPECTED_TOTAL || DEFAULT_EXPECTED_TOTAL) || 0;
const REQUIRED_SKUS = String(process.env.REQUIRED_SKUS || '100238264645')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const ACTIVITY_NAME = process.env.ACTIVITY_NAME || '超级补贴·超级加倍补';

// pro.m 的 CDN 边缘：默认 DNS 偶尔会解析到“京东验证”页，换一个边缘可恢复 SSR
// 这些 IP 来自 223.5.5.5 / 1.1.1.1 的解析结果，JD 会不定期调整
const EDGE_IPS = (process.env.EDGE_IPS || '111.202.57.21,111.13.149.247')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const URLS = {
  // App 内置页（商品 SSR 直出，主数据源）
  app: `https://h5static.m.jd.com/mall/active/${ACTIVITY_ID}/index.html?${ENTRY_QUERY}`,
  // H5 页（推荐流，补充数据源）
  h5: `https://pro.m.jd.com/mall/active/${ACTIVITY_ID}/index.html?${ENTRY_QUERY}`,
};

// App WebView UA：h5static 用这个 UA 才稳定返回 App 版 SSR
const UA_APP =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 jdapp;JDAndroid;14.0.0;';

const UA_MOBILE =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Mobile Safari/537.36';

const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
  'Version/17.4 Mobile/15E148 Safari/604.1';

/**
 * 桌面 UA —— 浏览器通道必须用这个，不是 App UA。
 *
 * 实测（2026-11-06）：同一个活动页，
 *   - App UA（jdapp;JDAndroid）+ 移动视口 → 页面判定自己在 App 容器里，走 JSBridge 分支，
 *     CSR 渲染成空壳（body 高度 1034），queryBabelFeeds 全部 403；
 *   - 桌面 UA + 1440x900 视口 → 正常渲染，queryBabelFeeds 返回 200，
 *     滚动后 DOM 里「抢购价」29 个，古井/茅台都在，**且未登录**。
 * 所以「必须登录态才能看 29 条」这个结论是错的，是 UA 选错导致的。
 */
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

const UA_DESKTOP_EDGE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

const UA_DESKTOP_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36';

// 风控验证页特征（不要用 robot/captcha 这类泛词：正常页面脚本里也可能出现 robots）
const VERIFY_PHRASES = ['京东验证', '验证一下', '请完成验证', '访问频次', '安全验证'];

// 「今日抢购」tab 名称；其他 tab 原样保留（如「明日预告」）
const TAB_TODAY = '今日抢购';
const TAB_TOMORROW = '明日预告';

// 活动标签映射（原始 code -> 可读文案）
const TAG_MAP = {
  BILLION_ZXJ: '百亿补贴',
  BYBT_MARKETING: '加倍补',
};

// 默认输出目录
const DEFAULT_OUT_DIR = 'data';

module.exports = {
  ACTIVITY_ID,
  ENTRY_QUERY,
  URLS,
  UA_APP,
  UA_MOBILE,
  UA_IPHONE,
  UA_DESKTOP,
  UA_DESKTOP_EDGE,
  UA_DESKTOP_MAC,
  VERIFY_PHRASES,
  TAB_TODAY,
  TAB_TOMORROW,
  TAG_MAP,
  DEFAULT_OUT_DIR,
  EXPECTED_TOTAL,
  REQUIRED_SKUS,
  ACTIVITY_NAME,
  EDGE_IPS,
};
