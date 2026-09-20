#!/usr/bin/env node
/**
 * Hedgehog strategic valuation engine (ESM).
 *
 * Supported methods:
 *   - tam-sam-som : Estimate company value from TAM, SAM, and SOM
 *   - ltv-cac     : Estimate DCF value from LTV/CAC unit economics
 *   - nrr         : NRR-based valuation for AI SaaS companies
 *
 * Usage:
 *   node ./scripts/strategic.mjs <method> [--key value ... | --params-file <tmp-*.json>]
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

function projectionYearCount(value) {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error('projectionYears 必须是 1 到 100 之间的整数');
  }
  return value;
}

const NUMERIC_PARAMETERS = new Set([
  'tam', 'serviceableRatio', 'marketShare', 'targetNetMargin', 'industryPS', 'industryPE',
  'arpu', 'grossMargin', 'cac', 'churnRate', 'retentionPeriod', 'currentUsers',
  'userGrowthRate', 'discountRate', 'projectionYears', 'terminalGrowthRate',
  'currentARR', 'nrr',
]);

function validateNumericParameters(params) {
  for (const name of NUMERIC_PARAMETERS) {
    if (params[name] !== undefined && (typeof params[name] !== 'number' || !Number.isFinite(params[name]))) {
      throw new Error(`${name} 必须是 JSON number，不能使用数字字符串`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4.1 Company valuation from TAM, SAM, and SOM
// ═══════════════════════════════════════════════════════════════════════════

function calcTAMSAMSOM(p) {
  const tam = p.tam;
  if (tam === undefined) {
    throw new Error('缺少必填参数: tam (总潜在市场)');
  }
  const serviceableRatio = p.serviceableRatio ?? 0.3;
  const marketShare = p.marketShare;
  if (marketShare === undefined) {
    throw new Error('缺少必填参数: marketShare (预期市占率)');
  }
  const targetNetMargin = p.targetNetMargin;

  // Step 1: market size.
  const sam = tam * serviceableRatio;
  const som = sam * marketShare;
  const somRevenue = som;
  const somNetProfit = targetNetMargin === undefined ? null : somRevenue * targetNetMargin;

  // Step 2: company valuation.
  let estimatedValue = null;
  let valuationMethod = null;

  if (p.industryPS !== undefined) {
    // Valuation = expected SOM revenue * industry P/S.
    estimatedValue = somRevenue * p.industryPS;
    valuationMethod = 'P/S';
  } else if (p.industryPE !== undefined) {
    if (somNetProfit === null) {
      throw new Error('使用 industryPE 时必须提供 targetNetMargin，以便由 SOM 收入推算净利润');
    }
    // Valuation = expected SOM net profit * industry P/E.
    estimatedValue = somNetProfit * p.industryPE;
    valuationMethod = 'P/E';
  }

  const result = {
    tam,
    sam: round(sam, 2),
    som: round(som, 2),
    somRevenue: round(somRevenue, 2),
    somNetProfit: somNetProfit === null ? null : round(somNetProfit, 2),
    components: {
      step1_marketSize: {
        formula: 'SAM = TAM × serviceableRatio; SOM = SAM × marketShare',
        serviceableRatio,
        marketShare,
        sam: round(sam, 2),
        som: round(som, 2),
      },
      step2_revenue: {
        formula: 'SOM预期收入 = SOM',
        somRevenue: round(somRevenue, 2),
      },
    },
  };

  if (estimatedValue !== null) {
    result.estimatedValue = round(estimatedValue, 2);
    result.components.step3_valuation = {
      formula: `估值 = SOM预期${valuationMethod === 'P/S' ? '收入' : '净利润'} × 行业${valuationMethod}`,
      [`industry${valuationMethod}`]: p.industryPS ?? p.industryPE,
      estimatedValue: round(estimatedValue, 2),
    };
    result.valuationMethod = valuationMethod;
  } else {
    result.note = '未提供 industryPS 或 industryPE，无法计算公司估值。请传入行业 P/S 或 P/E 倍数。';
  }

  result.formula =
    'SAM = TAM × serviceableRatio; SOM收入 = SAM × marketShare; P/S估值 = SOM收入 × 行业P/S; P/E估值 = SOM收入 × 目标净利率 × 行业P/E';

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4.2 DCF valuation from LTV/CAC unit economics
// ═══════════════════════════════════════════════════════════════════════════

function calcLTVCAC(p) {
  const arpu = p.arpu;
  if (arpu === undefined) {
    throw new Error('缺少必填参数: arpu (每用户平均收入)');
  }
  const grossMargin = p.grossMargin ?? 1;
  const cac = p.cac;
  if (cac === undefined) {
    throw new Error('缺少必填参数: cac (获客成本)');
  }

  // Step 1: calculate LTV.
  let ltv;
  let retentionInfo;

  if (p.churnRate !== undefined && p.churnRate > 0) {
    // LTV = ARPU * gross margin * (1 / churn rate).
    const retentionPeriod = 1 / p.churnRate; // Retention period in years.
    ltv = arpu * grossMargin * retentionPeriod;
    retentionInfo = {
      method: 'churnRate',
      churnRate: p.churnRate,
      retentionPeriod: round(retentionPeriod, 2),
      retentionPeriodUnit: 'years',
    };
  } else if (p.retentionPeriod !== undefined) {
    // LTV = ARPU * gross margin * retention period.
    ltv = arpu * grossMargin * p.retentionPeriod;
    retentionInfo = {
      method: 'retentionPeriod',
      retentionPeriod: p.retentionPeriod,
      retentionPeriodUnit: 'months',
    };
  } else {
    throw new Error('需要提供 churnRate (流失率) 或 retentionPeriod (留存期)');
  }

  const ltvCacRatio = ltv / cac;

  let interpretation;
  if (ltvCacRatio >= 3) interpretation = '优秀 (LTV/CAC ≥ 3，单位经济健康)';
  else if (ltvCacRatio >= 1) interpretation = '一般 (1 ≤ LTV/CAC < 3，需优化)';
  else interpretation = '不健康 (LTV/CAC < 1，获客成本高于用户终身价值)';

  const result = {
    ltv: round(ltv, 2),
    cac,
    ltvCacRatio: round(ltvCacRatio, 2),
    interpretation,
    components: {
      step1_unitEconomics: {
        formula: 'LTV = ARPU × 毛利率 × (1 / churnRate)',
        arpu,
        grossMargin,
        ...retentionInfo,
        ltv: round(ltv, 2),
        cac,
        ltvCacRatio: round(ltvCacRatio, 2),
      },
    },
  };

  // Step 2: estimate DCF when user metrics are available.
  const currentUsers = p.currentUsers;
  if (currentUsers !== undefined) {
    const userGrowthRate = p.userGrowthRate ?? 0;
    const discountRate = p.discountRate ?? 0.10;
    const projectionYears = projectionYearCount(p.projectionYears ?? 5);
    const terminalGrowthRate = p.terminalGrowthRate ?? 0.03;

    // Project free cash flow for each year.
    // Year N cash flow = users * ARPU * gross margin - CAC * new users.
    const projectedCashFlows = [];
    let currentUsersCount = currentUsers;

    for (let year = 1; year <= projectionYears; year++) {
      const prevUsers = currentUsersCount;
      currentUsersCount = prevUsers * (1 + userGrowthRate);
      const newUsers = currentUsersCount - prevUsers;

      // Revenue = users * ARPU, approximated with year-end users.
      const revenue = currentUsersCount * arpu;
      // Gross profit.
      const grossProfit = revenue * grossMargin;
      // Customer acquisition cost.
      const acquisitionCost = newUsers * cac;
      // Free cash flow = gross profit - customer acquisition cost.
      const fcf = grossProfit - acquisitionCost;

      projectedCashFlows.push({
        year,
        users: round(currentUsersCount, 0),
        newUsers: round(newUsers, 0),
        revenue: round(revenue, 2),
        grossProfit: round(grossProfit, 2),
        acquisitionCost: round(acquisitionCost, 2),
        freeCashFlow: round(fcf, 2),
      });
    }

    // Discount the projected cash flows.
    const presentValues = projectedCashFlows.map((cf, i) => {
      const pv = cf.freeCashFlow / Math.pow(1 + discountRate, i + 1);
      return round(pv, 2);
    });

    const pvSum = presentValues.reduce((a, b) => a + b, 0);

    // Terminal value using perpetual growth.
    const lastFCF = projectedCashFlows[projectedCashFlows.length - 1].freeCashFlow;
    const terminalValue = lastFCF * (1 + terminalGrowthRate) / (discountRate - terminalGrowthRate);
    const pvTerminal = terminalValue / Math.pow(1 + discountRate, projectionYears);

    const dcfValuation = round(pvSum + pvTerminal, 2);

    result.projectedCashFlows = projectedCashFlows;
    result.dcfValuation = dcfValuation;
    result.components.step2_dcf = {
      formula: 'DCF = Σ [FCF_i / (1+r)^i] + [终值 / (1+r)^N]',
      currentUsers,
      userGrowthRate,
      discountRate,
      projectionYears,
      terminalGrowthRate,
      presentValues,
      pvSum: round(pvSum, 2),
      terminalValue: round(terminalValue, 2),
      pvTerminal: round(pvTerminal, 2),
      dcfValuation,
    };
  } else {
    result.note = '未提供 currentUsers，跳过 DCF 推算。如需公司估值，请传入 currentUsers、userGrowthRate 等参数。';
  }

  result.formula =
    'LTV = ARPU × 毛利率 × (1/churnRate); FCF = 用户数 × ARPU × 毛利率 - 获客成本 × 新增用户; DCF = Σ PV(FCF) + PV(终值)';

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4.3 NRR-based valuation for AI SaaS companies
// ═══════════════════════════════════════════════════════════════════════════

function calcNRR(p) {
  const currentARR = p.currentARR;
  if (currentARR === undefined) {
    throw new Error('缺少必填参数: currentARR (当前年度经常性收入)');
  }
  const nrr = p.nrr;
  if (nrr === undefined) {
    throw new Error('缺少必填参数: nrr (净收入留存率，如 1.25 表示 125%)');
  }
  const userGrowthRate = p.userGrowthRate ?? 0;
  const projectionYears = projectionYearCount(p.projectionYears ?? 3);
  const industryPS = p.industryPS;

  // Interpret the NRR level.
  let nrrInterpretation;
  if (nrr >= 1.3) nrrInterpretation = '卓越 (NRR ≥ 130%，顶级 AI SaaS 水平)';
  else if (nrr >= 1.2) nrrInterpretation = '优秀 (120% ≤ NRR < 130%，老客户增购强劲)';
  else if (nrr >= 1.0) nrrInterpretation = '良好 (100% ≤ NRR < 120%，有增购但不算突出)';
  else nrrInterpretation = '需关注 (NRR < 100%，客户流失大于增购)';

  // Step 1: project expected revenue for each year.
  // Expected revenue = current ARR * (1 + user growth rate) * NRR, compounded annually.
  const projectedRevenue = [];
  let currentRevenue = currentARR;

  for (let year = 1; year <= projectionYears; year++) {
    currentRevenue = currentRevenue * (1 + userGrowthRate) * nrr;
    projectedRevenue.push({
      year,
      revenue: round(currentRevenue, 2),
      growthFromARR: round(currentRevenue / currentARR, 4),
    });
  }

  // Step 2: company valuation.
  let estimatedValue = null;
  if (industryPS !== undefined) {
    // Use year-N expected revenue multiplied by the industry P/S.
    const finalYearRevenue = projectedRevenue[projectedRevenue.length - 1].revenue;
    estimatedValue = finalYearRevenue * industryPS;
  }

  const result = {
    nrr,
    nrrPct: pct(nrr),
    nrrInterpretation,
    currentARR,
    userGrowthRate,
    projectionYears,
    projectedRevenue,
    industryPS: industryPS ?? null,
    estimatedValue: estimatedValue !== null ? round(estimatedValue, 2) : null,
    components: {
      step1_nrr: {
        formula: 'NRR = (期初收入 + 增购 - 减购 - 流失) / 期初收入',
        nrr,
        interpretation: nrrInterpretation,
      },
      step2_revenue: {
        formula: '预期营收(第N年) = 当前ARR × (1 + 用户增长率)^N × NRR^N',
        currentARR,
        userGrowthRate,
        nrr,
        projectedRevenue,
      },
    },
    formula: '估值 = 预期营收(第N年) × 行业P/S',
  };

  if (estimatedValue === null) {
    result.note = '未提供 industryPS，无法计算公司估值。请传入行业 P/S 倍数。';
  } else {
    result.components.step3_valuation = {
      formula: '估值 = 预期营收(最终年) × 行业P/S',
      finalYearRevenue: projectedRevenue[projectedRevenue.length - 1].revenue,
      industryPS,
      estimatedValue: round(estimatedValue, 2),
    };
  }

  // Optional ARPU consistency check.
  if (p.arpu !== undefined && p.currentUsers !== undefined) {
    const calculatedARR = p.arpu * p.currentUsers;
    result.components.arrCheck = {
      arpu: p.arpu,
      currentUsers: p.currentUsers,
      calculatedARR: round(calculatedARR, 2),
      providedARR: currentARR,
      match: Math.abs(calculatedARR - currentARR) / currentARR < 0.05,
    };
  }

  return result;
}

// ─── Method routing ──────────────────────────────────────────────────────────

const METHODS = {
  'tam-sam-som': { desc: 'TAM/SAM/SOM 空间测算法 → 公司估值', required: ['tam', 'marketShare'], exec: calcTAMSAMSOM },
  'ltv-cac': { desc: 'LTV/CAC 单位经济模型 → DCF 推算估值', required: ['arpu', 'cac'], exec: calcLTVCAC },
  'nrr': { desc: 'NRR 净收入留存率估值法（AI SaaS 专用）', required: ['currentARR', 'nrr'], exec: calcNRR },
};

const VALID_METHODS = Object.keys(METHODS);

function main() {
  const argv = process.argv.slice(2);

  if (argv.length < 1 || argv[0] === '--help' || argv[0] === '-h') {
    const help = VALID_METHODS.map((m) => `  ${m.padEnd(20)} ${METHODS[m].desc}`).join('\n');
    console.log(`用法: node strategic.mjs <method> [--key value ... | --params-file <tmp-*.json>]\n   人工兼容: node strategic.mjs <method> '<params-json>'\n\n支持方法:\n${help}`);
    return;
  }

  const method = argv[0].toLowerCase();
  const def = METHODS[method];
  if (!def) {
    throw new Error(`不支持的方法: ${method}\n支持: ${VALID_METHODS.join(', ')}`);
  }

  const params = loadJsonParams(argv.slice(1));
  validateNumericParameters(params);

  const missing = def.required.filter((k) => params[k] === undefined);
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

export { METHODS, VALID_METHODS };
