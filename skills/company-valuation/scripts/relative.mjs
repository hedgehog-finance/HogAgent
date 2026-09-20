#!/usr/bin/env node
/**
 * Hedgehog relative valuation engine (ESM).
 *
 * Supported methods:
 *   - pe            : Static price-to-earnings ratio
 *   - pe-ttm        : Trailing price-to-earnings ratio; see company-valuation.md
 *   - pb            : Price-to-book ratio; see company-valuation.md
 *   - ps            : Static price-to-sales ratio
 *   - ps-ttm        : Trailing price-to-sales ratio; see company-valuation.md
 *   - ev-ebitda     : Enterprise value to EBITDA
 *   - ev-revenue    : Enterprise value to revenue
 *   - peg           : PEG valuation
 *   - arr           : ARR multiple
 *   - p-active-user : Value per active user using MAU or DAU
 *   - p-gmv         : Market capitalization to GMV
 *   - ev-fcf        : Enterprise value to free cash flow
 *
 * Usage:
 *   node ./scripts/relative.mjs <method> [--key value ... | --params-file <tmp-*.json>]
 */

import { fileURLToPath } from 'node:url';
import { loadJsonParams } from './params.mjs';

// ─── Utility functions ───────────────────────────────────────────────────────

function round(v, d = 2) {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

function pct(v, d = 2) {
  return `${(v * 100).toFixed(d)}%`;
}

function assertFiniteOutput(value, path = 'result') {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`${path} is not finite; check zero denominators and parameter ranges`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteOutput(item, `${path}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertFiniteOutput(item, `${path}.${key}`);
    }
  }
}

function finiteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} 必须是有限数字`);
  }
  return value;
}

const NUMERIC_PARAMETERS = new Set([
  'marketCap', 'netIncome', 'price', 'eps', 'totalShare', 'pe', 'industryPE',
  'peLowFactor', 'peHighFactor', 'currentPrice', 'ttmNetProfit', 'equityToParent',
  'industryPB', 'pbLowFactor', 'pbHighFactor', 'revenue', 'ttmRevenue', 'industryPS',
  'peerPS', 'psLowFactor', 'psHighFactor', 'totalDebt', 'cash', 'ebitda',
  'earningsGrowthRate', 'targetPEG', 'arr', 'industryARRMultiple', 'arrLowFactor',
  'arrHighFactor', 'activeUsers', 'industryValuePerUser', 'userLowFactor',
  'userHighFactor', 'gmv', 'industryPGmv', 'gmvLowFactor', 'gmvHighFactor',
  'freeCashFlow', 'industryEvFcf', 'fcfLowFactor', 'fcfHighFactor',
]);

function validateNumericParameters(params) {
  for (const name of NUMERIC_PARAMETERS) {
    if (params[name] !== undefined) {
      finiteNumber(params[name], `${name}（必须使用 JSON number，不能使用数字字符串）`);
    }
  }
}

/** Calculate a discount or premium range. */
function applyFactorRange(baseValue, lowFactor, highFactor, decimals = 2) {
  return {
    low: round(baseValue * lowFactor, decimals),
    high: round(baseValue * highFactor, decimals),
  };
}

/** Calculate a share-price range from a valuation range and total shares. */
function calcPriceRange(valLow, valHigh, totalShare, decimals = 2) {
  if (!totalShare) return null;
  return {
    low: round(valLow / totalShare, decimals),
    high: round(valHigh / totalShare, decimals),
  };
}

/** Assign a valuation rating. */
function calcRating(currentPrice, priceLow, priceHigh) {
  if (currentPrice === undefined) return null;
  if (currentPrice < priceLow) return '低估 (Undervalued)';
  if (currentPrice > priceHigh) return '高估 (Overvalued)';
  return '合理 (Fair Value)';
}

// ─── Shared TTM calculation for PE-TTM and PS-TTM ────────────────────────────

/**
 * Calculate a TTM value from reporting-period records.
 * @param {Array} reports - Records containing end_date (YYYYMMDD) and financial fields.
 * @param {string} field - Financial field to aggregate.
 * @returns {number} Calculated TTM value.
 */
function calcTTM(reports, field) {
  if (!Array.isArray(reports) || reports.length === 0) {
    throw new Error('reports 数组不能为空');
  }
  if (reports.length > 10000) {
    throw new Error('reports 最多支持 10000 条记录');
  }
  if (typeof field !== 'string' || field.length === 0 || field.length > 128) {
    throw new Error('reportField 必须是长度为 1 到 128 的字符串');
  }
  const normalized = reports.map((report, index) => {
    if (!report || typeof report !== 'object' || Array.isArray(report)) {
      throw new Error(`reports[${index}] 必须是对象`);
    }
    const endDate = String(report.end_date ?? '');
    if (!/^\d{8}$/.test(endDate)) {
      throw new Error(`reports[${index}].end_date 必须是 YYYYMMDD 格式`);
    }
    return { report, endDate };
  });
  // Sort by end_date in descending order.
  const sorted = normalized.sort((a, b) => b.endDate.localeCompare(a.endDate));
  const latest = sorted[0].report;
  const endDate = sorted[0].endDate;
  const monthDay = endDate.slice(4, 8);

  const latestValue = latest[field];
  if (latestValue === undefined || latestValue === null) {
    throw new Error(`报告期 ${endDate} 缺少字段: ${field}`);
  }
  finiteNumber(latestValue, `报告期 ${endDate} 的 ${field}`);

  // Return an annual report value directly.
  if (monthDay === '1231') {
    return latestValue;
  }

  // Find the previous annual report.
  const lastYear = endDate.slice(0, 4);
  const lastYearEndDate = `${Number(lastYear) - 1}1231`;
  const lastYearReport = sorted.find((entry) => entry.endDate === lastYearEndDate)?.report;

  if (!lastYearReport) {
    throw new Error(`无法找到去年年报 (${lastYearEndDate})，请确保 reports 包含去年同期数据`);
  }

  const lastYearValue = lastYearReport[field];
  if (lastYearValue === undefined || lastYearValue === null) {
    throw new Error(`去年年报 (${lastYearEndDate}) 缺少字段: ${field}`);
  }
  finiteNumber(lastYearValue, `去年年报 (${lastYearEndDate}) 的 ${field}`);

  // Find the matching period from the previous year.
  const lastYearSamePeriod = `${Number(lastYear) - 1}${monthDay}`;
  const lastYearSameReport = sorted.find((entry) => entry.endDate === lastYearSamePeriod)?.report;

  if (!lastYearSameReport) {
    throw new Error(`无法找到去年同期报告 (${lastYearSamePeriod})，请确保 reports 包含去年同期数据`);
  }

  const lastYearSameValue = lastYearSameReport[field];
  if (lastYearSameValue === undefined || lastYearSameValue === null) {
    throw new Error(`去年同期报告 (${lastYearSamePeriod}) 缺少字段: ${field}`);
  }
  finiteNumber(lastYearSameValue, `去年同期报告 (${lastYearSamePeriod}) 的 ${field}`);

  // TTM = current period + previous annual report - matching prior-year period.
  return latestValue + lastYearValue - lastYearSameValue;
}

// ─── 2.1 PE (static price-to-earnings ratio) ─────────────────────────────────

function calcPE(p) {
  let pe;
  let netIncome = p.netIncome;

  if (p.pe !== undefined) {
    pe = p.pe;
  } else {
    if (p.marketCap !== undefined && p.netIncome !== undefined) {
      pe = p.marketCap / netIncome;
    } else if (p.price !== undefined && p.eps !== undefined) {
      pe = p.price / p.eps;
      // Derive market capitalization and net income.
      if (p.totalShare) {
        // marketCap = pe * eps * totalShare when eps is earnings per share.
      }
    } else {
      throw new Error('需要提供 marketCap+netIncome 或 price+eps 或 pe');
    }
  }

  const result = {
    pe: round(pe, 2),
    formula: 'P/E = 总市值 / 净利润 = 股价 / EPS',
  };

  // Optional valuation range.
  if (p.industryPE !== undefined && netIncome !== undefined) {
    const lowFactor = p.peLowFactor ?? 0.8;
    const highFactor = p.peHighFactor ?? 1.1;
    const valRange = applyFactorRange(netIncome * p.industryPE, lowFactor, highFactor);
    result.valuationRange = {
      industryPE: p.industryPE,
      low: valRange.low,
      high: valRange.high,
    };
    if (p.totalShare) {
      result.priceRange = calcPriceRange(valRange.low, valRange.high, p.totalShare);
    }
    if (p.currentPrice !== undefined && p.totalShare) {
      result.rating = calcRating(p.currentPrice, result.priceRange.low, result.priceRange.high);
    }
  }

  return result;
}

// ─── 2.2 PE-TTM (trailing price-to-earnings ratio) ───────────────────────────

function calcPETTM(p) {
  let ttmNetProfit;

  if (p.ttmNetProfit !== undefined) {
    ttmNetProfit = p.ttmNetProfit;
  } else if (Array.isArray(p.reports)) {
    ttmNetProfit = calcTTM(p.reports, p.reportField || 'n_income_attr_p');
  } else {
    throw new Error('需要提供 ttmNetProfit 或 reports 数组');
  }

  const marketCap = p.marketCap;
  if (marketCap === undefined) {
    throw new Error('需要提供 marketCap (总市值)');
  }

  const peTtm = marketCap / ttmNetProfit;

  const result = {
    peTtm: round(peTtm, 2),
    ttmNetProfit: round(ttmNetProfit, 2),
    marketCap,
    formula: 'PE-TTM = 总市值 / 近4个季度净利润之和',
  };

  // Valuation range.
  if (p.industryPE !== undefined) {
    const lowFactor = p.peLowFactor ?? 0.8;
    const highFactor = p.peHighFactor ?? 1.1;
    const valRange = applyFactorRange(ttmNetProfit * p.industryPE, lowFactor, highFactor);
    result.valuationRange = {
      industryPE: p.industryPE,
      low: valRange.low,
      high: valRange.high,
    };
    if (p.totalShare) {
      result.priceRange = calcPriceRange(valRange.low, valRange.high, p.totalShare);
    }
    if (p.currentPrice !== undefined && result.priceRange) {
      result.rating = calcRating(p.currentPrice, result.priceRange.low, result.priceRange.high);
    }
  }

  return result;
}

// ─── 2.3 PB (price-to-book ratio) ────────────────────────────────────────────

function calcPB(p) {
  const { marketCap, equityToParent } = p;
  if (marketCap === undefined || equityToParent === undefined) {
    throw new Error('需要提供 marketCap 和 equityToParent (归母权益)');
  }

  const pb = marketCap / equityToParent;

  const result = {
    pb: round(pb, 2),
    formula: 'P/B = 总市值 / 归属于母公司所有者权益',
  };

  // Valuation range.
  if (p.industryPB !== undefined) {
    const lowFactor = p.pbLowFactor ?? 0.8;
    const highFactor = p.pbHighFactor ?? 1.1;
    const valRange = applyFactorRange(equityToParent * p.industryPB, lowFactor, highFactor);
    result.valuationRange = {
      industryPB: p.industryPB,
      low: valRange.low,
      high: valRange.high,
    };
    if (p.totalShare) {
      result.priceRange = calcPriceRange(valRange.low, valRange.high, p.totalShare);
    }
    if (p.currentPrice !== undefined && result.priceRange) {
      result.rating = calcRating(p.currentPrice, result.priceRange.low, result.priceRange.high);
    }
  }

  return result;
}

// ─── 2.4 PS (static price-to-sales ratio) ────────────────────────────────────

function calcPS(p) {
  const { marketCap, revenue } = p;
  if (marketCap === undefined || revenue === undefined) {
    throw new Error('需要提供 marketCap 和 revenue');
  }

  const ps = marketCap / revenue;

  const result = {
    ps: round(ps, 2),
    formula: 'P/S = 总市值 / 营业收入',
  };

  // Valuation range.
  if (p.industryPS !== undefined) {
    const lowFactor = p.psLowFactor ?? 0.8;
    const highFactor = p.psHighFactor ?? 1.1;
    const valRange = applyFactorRange(revenue * p.industryPS, lowFactor, highFactor);
    result.valuationRange = {
      industryPS: p.industryPS,
      low: valRange.low,
      high: valRange.high,
    };
    if (p.totalShare) {
      result.priceRange = calcPriceRange(valRange.low, valRange.high, p.totalShare);
    }
    if (p.currentPrice !== undefined && result.priceRange) {
      result.rating = calcRating(p.currentPrice, result.priceRange.low, result.priceRange.high);
    }
  }

  return result;
}

// ─── 2.5 PS-TTM (trailing price-to-sales ratio) ──────────────────────────────

function calcPSTTM(p) {
  let ttmRevenue;

  if (p.ttmRevenue !== undefined) {
    ttmRevenue = p.ttmRevenue;
  } else if (Array.isArray(p.reports)) {
    ttmRevenue = calcTTM(p.reports, p.reportField || 'total_revenue');
  } else {
    throw new Error('需要提供 ttmRevenue 或 reports 数组');
  }

  const marketCap = p.marketCap;
  if (marketCap === undefined) {
    throw new Error('需要提供 marketCap (总市值)');
  }

  const psTtm = marketCap / ttmRevenue;

  const result = {
    psTtm: round(psTtm, 2),
    ttmRevenue: round(ttmRevenue, 2),
    marketCap,
    formula: 'PS-TTM = 总市值 / 近4个季度营业总收入之和',
  };

  // Valuation range based on a comparable-company or industry PS multiple.
  const benchmarkPS = p.peerPS ?? p.industryPS;
  if (benchmarkPS !== undefined) {
    const lowFactor = p.psLowFactor ?? 0.8;
    const highFactor = p.psHighFactor ?? 1.1;
    const valRange = applyFactorRange(ttmRevenue * benchmarkPS, lowFactor, highFactor);
    result.valuationRange = {
      benchmarkPS,
      low: valRange.low,
      high: valRange.high,
    };
    if (p.totalShare) {
      result.priceRange = calcPriceRange(valRange.low, valRange.high, p.totalShare);
    }
    if (p.currentPrice !== undefined && result.priceRange) {
      result.rating = calcRating(p.currentPrice, result.priceRange.low, result.priceRange.high);
    }
  }

  return result;
}

// ─── 2.6 EV/EBITDA ──────────────────────────────────────────────────────────

function calcEVEBITDA(p) {
  const { marketCap, totalDebt = 0, cash = 0, ebitda } = p;
  if (marketCap === undefined || ebitda === undefined) {
    throw new Error('需要提供 marketCap 和 ebitda');
  }

  const ev = marketCap + totalDebt - cash;
  const evEbitda = ev / ebitda;

  return {
    ev: round(ev, 2),
    ebitda,
    evEbitda: round(evEbitda, 2),
    formula: 'EV = 市值 + 总债务 - 现金; EV/EBITDA = EV / EBITDA',
  };
}

// ─── 2.7 EV/Revenue ─────────────────────────────────────────────────────────

function calcEVRevenue(p) {
  const { marketCap, totalDebt = 0, cash = 0, revenue } = p;
  if (marketCap === undefined || revenue === undefined) {
    throw new Error('需要提供 marketCap 和 revenue');
  }

  const ev = marketCap + totalDebt - cash;
  const evRevenue = ev / revenue;

  return {
    ev: round(ev, 2),
    revenue,
    evRevenue: round(evRevenue, 2),
    formula: 'EV = 市值 + 总债务 - 现金; EV/Revenue = EV / 营业收入',
  };
}

// ─── 2.8 PEG ─────────────────────────────────────────────────────────────────

function calcPEG(p) {
  let pe = p.pe;
  let netIncome = p.netIncome;

  if (pe === undefined) {
    if (p.marketCap !== undefined && p.netIncome !== undefined) {
      pe = p.marketCap / p.netIncome;
    } else {
      throw new Error('需要提供 pe 或 marketCap+netIncome');
    }
  }

  const growthRate = p.earningsGrowthRate;
  if (growthRate === undefined || growthRate === 0) {
    throw new Error('需要提供 earningsGrowthRate (净利润增长率，不能为0)');
  }

  const peg = pe / (growthRate * 100);
  const targetPEG = p.targetPEG ?? 1.0;
  const fairPE = targetPEG * growthRate * 100;

  let interpretation;
  if (peg < 1) interpretation = '低估 (PEG < 1)';
  else if (peg > 1) interpretation = '高估 (PEG > 1)';
  else interpretation = '合理 (PEG = 1)';

  const result = {
    peg: round(peg, 4),
    pe: round(pe, 2),
    earningsGrowthRate: growthRate,
    targetPEG,
    fairPE: round(fairPE, 2),
    interpretation,
    formula: 'PEG = P/E / 净利润增长率; 合理PE = 目标PEG × 增长率',
  };

  // Optional valuation.
  if (netIncome !== undefined) {
    const estimatedValue = netIncome * fairPE;
    result.estimatedValue = round(estimatedValue, 2);
    if (p.totalShare) {
      const pricePerShare = estimatedValue / p.totalShare;
      result.priceRange = {
        fairPrice: round(pricePerShare, 2),
      };
    }
  }

  return result;
}

// ─── 2.9 ARR Multiples ───────────────────────────────────────────────────────

function calcARR(p) {
  const { marketCap, totalDebt = 0, cash = 0, arr } = p;
  if (marketCap === undefined || arr === undefined) {
    throw new Error('需要提供 marketCap 和 arr (年度经常性收入)');
  }

  const ev = marketCap + totalDebt - cash;
  const arrMultiple = ev / arr;

  const result = {
    ev: round(ev, 2),
    arr,
    arrMultiple: round(arrMultiple, 2),
    formula: 'ARR Multiple = EV / ARR; EV = 市值 + 总债务 - 现金',
  };

  // Optional valuation.
  if (p.industryARRMultiple !== undefined) {
    const lowFactor = p.arrLowFactor ?? 0.8;
    const highFactor = p.arrHighFactor ?? 1.2;
    const evLow = arr * p.industryARRMultiple * lowFactor;
    const evHigh = arr * p.industryARRMultiple * highFactor;
    result.estimatedValue = {
      industryARRMultiple: p.industryARRMultiple,
      evLow: round(evLow, 2),
      evHigh: round(evHigh, 2),
    };
    // Equity value = enterprise value - net debt.
    const netDebt = totalDebt - cash;
    result.equityValue = {
      low: round(evLow - netDebt, 2),
      high: round(evHigh - netDebt, 2),
    };
  }

  return result;
}

// ─── 2.10 P/Active-User (value per active user) ──────────────────────────────

function calcPActiveUser(p) {
  const { marketCap, activeUsers } = p;
  if (marketCap === undefined || activeUsers === undefined) {
    throw new Error('需要提供 marketCap 和 activeUsers');
  }

  const userType = p.userType ?? 'MAU';
  const valuePerUser = marketCap / activeUsers;

  const result = {
    valuePerUser: round(valuePerUser, 4),
    userType,
    marketCap,
    activeUsers,
    formula: `P/${userType} = 市值 / ${userType === 'MAU' ? '月' : '日'}活跃用户数`,
  };

  // Optional valuation.
  if (p.industryValuePerUser !== undefined) {
    const lowFactor = p.userLowFactor ?? 0.8;
    const highFactor = p.userHighFactor ?? 1.2;
    const valLow = activeUsers * p.industryValuePerUser * lowFactor;
    const valHigh = activeUsers * p.industryValuePerUser * highFactor;
    result.estimatedValue = {
      industryValuePerUser: p.industryValuePerUser,
      low: round(valLow, 2),
      high: round(valHigh, 2),
    };
  }

  return result;
}

// ─── 2.11 P/GMV ──────────────────────────────────────────────────────────────

function calcPGMV(p) {
  const { marketCap, gmv } = p;
  if (marketCap === undefined || gmv === undefined) {
    throw new Error('需要提供 marketCap 和 gmv');
  }

  const pGmv = marketCap / gmv;

  const result = {
    pGmv: round(pGmv, 4),
    marketCap,
    gmv,
    formula: 'P/GMV = 市值 / 成交总额',
  };

  // Optional valuation.
  if (p.industryPGmv !== undefined) {
    const lowFactor = p.gmvLowFactor ?? 0.8;
    const highFactor = p.gmvHighFactor ?? 1.2;
    const valLow = gmv * p.industryPGmv * lowFactor;
    const valHigh = gmv * p.industryPGmv * highFactor;
    result.estimatedValue = {
      industryPGmv: p.industryPGmv,
      low: round(valLow, 2),
      high: round(valHigh, 2),
    };
  }

  return result;
}

// ─── 2.12 EV/FCF ────────────────────────────────────────────────────────────

function calcEVFCF(p) {
  const { marketCap, totalDebt = 0, cash = 0, freeCashFlow } = p;
  if (marketCap === undefined || freeCashFlow === undefined) {
    throw new Error('需要提供 marketCap 和 freeCashFlow');
  }

  const ev = marketCap + totalDebt - cash;
  const evFcf = ev / freeCashFlow;

  const result = {
    ev: round(ev, 2),
    freeCashFlow,
    evFcf: round(evFcf, 2),
    formula: 'EV/FCF = 企业价值 / 自由现金流; EV = 市值 + 总债务 - 现金',
  };

  // Optional valuation.
  if (p.industryEvFcf !== undefined) {
    const lowFactor = p.fcfLowFactor ?? 0.8;
    const highFactor = p.fcfHighFactor ?? 1.2;
    const evLow = freeCashFlow * p.industryEvFcf * lowFactor;
    const evHigh = freeCashFlow * p.industryEvFcf * highFactor;
    result.estimatedValue = {
      industryEvFcf: p.industryEvFcf,
      evLow: round(evLow, 2),
      evHigh: round(evHigh, 2),
    };
    const netDebt = totalDebt - cash;
    result.equityValue = {
      low: round(evLow - netDebt, 2),
      high: round(evHigh - netDebt, 2),
    };
  }

  return result;
}

// ─── Method routing ──────────────────────────────────────────────────────────

const METHODS = {
  pe: { desc: '静态市盈率', required: [], exec: calcPE },
  'pe-ttm': { desc: '滚动市盈率（TTM）', required: ['marketCap'], exec: calcPETTM },
  pb: { desc: '市净率', required: ['marketCap', 'equityToParent'], exec: calcPB },
  ps: { desc: '静态市销率', required: ['marketCap', 'revenue'], exec: calcPS },
  'ps-ttm': { desc: '滚动市销率（TTM）', required: ['marketCap'], exec: calcPSTTM },
  'ev-ebitda': { desc: '企业价值/EBITDA', required: ['marketCap', 'ebitda'], exec: calcEVEBITDA },
  'ev-revenue': { desc: '企业价值/营业收入', required: ['marketCap', 'revenue'], exec: calcEVRevenue },
  peg: { desc: 'PEG估值法', required: ['earningsGrowthRate'], exec: calcPEG },
  arr: { desc: 'ARR倍数', required: ['marketCap', 'arr'], exec: calcARR },
  'p-active-user': { desc: '单用户价值（MAU/DAU）', required: ['marketCap', 'activeUsers'], exec: calcPActiveUser },
  'p-gmv': { desc: '市值/GMV', required: ['marketCap', 'gmv'], exec: calcPGMV },
  'ev-fcf': { desc: '企业价值/自由现金流', required: ['marketCap', 'freeCashFlow'], exec: calcEVFCF },
};

const VALID_METHODS = Object.keys(METHODS);

function main() {
  const argv = process.argv.slice(2);

  if (argv.length < 1 || argv[0] === '--help' || argv[0] === '-h') {
    const help = VALID_METHODS.map((m) => `  ${m.padEnd(20)} ${METHODS[m].desc}`).join('\n');
    console.log(`用法: node relative.mjs <method> [--key value ... | --params-file <tmp-*.json>]\n   人工兼容: node relative.mjs <method> '<params-json>'\n\n支持方法:\n${help}`);
    return;
  }

  const method = argv[0].toLowerCase();
  const def = METHODS[method];
  if (!def) {
    throw new Error(`不支持的方法: ${method}\n支持: ${VALID_METHODS.join(', ')}`);
  }

  const params = loadJsonParams(argv.slice(1));
  validateNumericParameters(params);

  const missing = def.required.filter((key) => params[key] === undefined);
  if (missing.length > 0) {
    throw new Error(`方法 '${method}' 缺少必填参数: ${missing.join(', ')}`);
  }

  const result = def.exec(params);
  assertFiniteOutput(result);
  console.log(JSON.stringify({ method, ...result }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

export { METHODS, VALID_METHODS, calcTTM };
