#!/usr/bin/env node
/**
 * Hedgehog absolute valuation engine (ESM).
 *
 * Includes DCF methods migrated from dcf-valuation and additional absolute valuation methods:
 *   - dcf            : Base growth-driven DCF with a 10-year projection
 *   - dcf-per-share  : Intrinsic value per share
 *   - wacc           : Weighted average cost of capital using CAPM
 *   - sensitivity    : Sensitivity analysis matrix
 *   - fcf-series     : Valuation from a custom FCF series
 *   - ddm            : Single-, two-, or three-stage dividend discount model
 *   - rnpv           : Risk-adjusted net present value for pipeline valuation
 *   - black-scholes  : Option pricing model
 *
 * Usage:
 *   node ./scripts/absolute.mjs <method> [--key value ... | --params-file <tmp-*.json>]
 */

import DCF from 'discounted-cash-flow';
import { fileURLToPath } from 'node:url';
import { loadJsonParams } from './params.mjs';

const MAX_YEARS = 10;

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

function boundedInteger(value, name, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return value;
}

function finiteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} 必须是有限数字`);
  }
  return value;
}

const NUMERIC_PARAMETERS = new Set([
  'firstFreeCashFlow', 'growthRate', 'terminalFcfMultiple', 'terminalMultiple',
  'discountRate', 'decimals', 'sharesOutstanding', 'totalShares', 'netDebt', 'cash',
  'totalDebt', 'marketCap', 'currentPrice', 'marginOfSafety', 'riskFreeRate', 'beta',
  'equityRiskPremium', 'costOfDebt', 'taxRate', 'equityWeight', 'debtWeight',
  'discountRateRange', 'discountRateStep', 'terminalMultipleRange', 'terminalMultipleStep',
  'dividend', 'highGrowthRate', 'highGrowthYears', 'transitionYears', 'S', 'K', 'T',
  'r', 'sigma', 'q',
]);

function validateNumericParameters(params) {
  for (const name of NUMERIC_PARAMETERS) {
    if (params[name] !== undefined) finiteNumber(params[name], `${name}（必须使用 JSON number，不能使用数字字符串）`);
  }
}

function finiteNumberArray(value, name, maximumLength) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumLength) {
    throw new Error(`${name} 必须是包含 1 到 ${maximumLength} 个元素的数组`);
  }
  value.forEach((item, index) => finiteNumber(item, `${name}[${index}]`));
  return value;
}

// ─── Standard normal cumulative distribution function N(x) ──────────────────

function normalCDF(x) {
  // Abramowitz and Stegun approximation
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

function normalPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// ═══════════════════════════════════════════════════════════════════════════
// DCF methods migrated from dcf-valuation without logic changes
// ═══════════════════════════════════════════════════════════════════════════

// ─── 3.3 WACC (CAPM) ────────────────────────────────────────────────────────

function calcWACC(p) {
  const Rf = p.riskFreeRate ?? 0.03;
  const beta = p.beta ?? 1.0;
  const ERP = p.equityRiskPremium ?? 0.055;
  const Re = Rf + beta * ERP;

  const Rd = p.costOfDebt ?? 0.04;
  const Tc = p.taxRate ?? 0.25;

  let E, D;
  if (p.equityWeight !== undefined && p.debtWeight !== undefined) {
    E = p.equityWeight;
    D = p.debtWeight;
  } else if (p.marketCap !== undefined && p.totalDebt !== undefined) {
    E = p.marketCap;
    D = p.totalDebt;
  } else {
    E = p.equityWeight ?? 0.7;
    D = p.debtWeight ?? 0.3;
  }
  const total = E + D;
  const wE = E / total;
  const wD = D / total;

  const wacc = wE * Re + wD * Rd * (1 - Tc);

  return {
    wacc: round(wacc, 6),
    waccPct: pct(wacc),
    costOfEquity: round(Re, 6),
    costOfEquityPct: pct(Re),
    components: {
      riskFreeRate: Rf,
      beta,
      equityRiskPremium: ERP,
      costOfDebt: Rd,
      taxRate: Tc,
      equityWeight: round(wE, 4),
      debtWeight: round(wD, 4),
    },
    formula: 'WACC = E/(E+D)x Re + D/(E+D) x Rd x (1-Tc)',
    capm: 'Re = Rf + beta x ERP',
  };
}

// ─── 3.1 Base DCF ───────────────────────────────────────────────────────────

function calcDCF(p) {
  const fcf = p.firstFreeCashFlow;
  if (fcf === undefined || fcf === null) {
    throw new Error('缺少必填参数: firstFreeCashFlow (首期自由现金流)');
  }
  const growthRates = p.growthRates ?? [p.growthRate ?? 0.05];
  finiteNumberArray(growthRates, 'growthRates', MAX_YEARS);
  const terminalMultiple = p.terminalFcfMultiple ?? p.terminalMultiple ?? 15;
  const discountRate = p.discountRate ?? 0.10;
  const decimals = boundedInteger(p.decimals ?? 2, 'decimals', 0, 15);

  const result = DCF.calculate(fcf, growthRates, terminalMultiple, discountRate, decimals);

  const pvFCF = result.presentValueFutureCashFlows.reduce((a, b) => a + b, 0);
  const terminalValueShare = result.presentValueFutureSale / result.totalPresentValue;

  return {
    ...result,
    inputs: {
      firstFreeCashFlow: fcf,
      growthRates,
      terminalFcfMultiple: terminalMultiple,
      discountRate,
    },
    summary: {
      presentValueOfFCFs: round(pvFCF, decimals),
      presentValueOfTerminal: result.presentValueFutureSale,
      totalPresentValue: result.totalPresentValue,
      terminalValueShare: round(terminalValueShare, 4),
      terminalValueSharePct: pct(terminalValueShare),
      projectionYears: MAX_YEARS,
    },
    yearLabels: Array.from({ length: MAX_YEARS }, (_, i) => `Y${i + 1}`),
  };
}

// ─── 3.2 Intrinsic value per share DCF ───────────────────────────────────────

function calcDCFPerShare(p) {
  const dcf = calcDCF(p);

  const sharesOutstanding = p.sharesOutstanding ?? p.totalShares;
  if (!sharesOutstanding) {
    throw new Error('缺少必填参数: sharesOutstanding (总股本，股数)');
  }
  const netDebt = p.netDebt ?? 0;
  const cash = p.cash ?? 0;
  const totalDebt = p.totalDebt ?? 0;
  const effectiveNetDebt = p.netDebt !== undefined ? netDebt : totalDebt - cash;

  const enterpriseValue = dcf.totalPresentValue;
  const equityValue = enterpriseValue - effectiveNetDebt;
  const intrinsicValuePerShare = equityValue / sharesOutstanding;

  let upside = null;
  let rating = null;
  if (p.currentPrice !== undefined) {
    upside = (intrinsicValuePerShare - p.currentPrice) / p.currentPrice;
    if (upside > 0.20) rating = '低估 (Undervalued)';
    else if (upside < -0.20) rating = '高估 (Overvalued)';
    else rating = '合理 (Fair Value)';
  }

  const marginOfSafety = p.marginOfSafety ?? 0.20;
  const buyPrice = intrinsicValuePerShare * (1 - marginOfSafety);

  return {
    ...dcf,
    equity: {
      enterpriseValue: round(enterpriseValue, 2),
      netDebt: round(effectiveNetDebt, 2),
      equityValue: round(equityValue, 2),
      sharesOutstanding,
      intrinsicValuePerShare: round(intrinsicValuePerShare, 4),
    },
    ...(p.currentPrice !== undefined
      ? {
          market: {
            currentPrice: p.currentPrice,
            upside: round(upside, 4),
            upsidePct: pct(upside),
            rating,
          },
        }
      : {}),
    safetyMargin: {
      marginOfSafety: pct(marginOfSafety),
      suggestedBuyPrice: round(buyPrice, 4),
    },
  };
}

// ─── 3.5 Custom FCF series valuation ─────────────────────────────────────────

function calcFCFSeries(p) {
  const fcfSeries = p.fcfSeries;
  if (!Array.isArray(fcfSeries) || fcfSeries.length === 0) {
    throw new Error('缺少必填参数: fcfSeries (自由现金流数组，每年一个值)');
  }
  if (fcfSeries.length > MAX_YEARS) {
    throw new Error(`fcfSeries 最多支持 ${MAX_YEARS} 年，当前传入 ${fcfSeries.length} 年`);
  }
  finiteNumberArray(fcfSeries, 'fcfSeries', MAX_YEARS);

  const discountRate = p.discountRate ?? 0.10;
  const terminalMultiple = p.terminalFcfMultiple ?? p.terminalMultiple ?? 15;
  const decimals = boundedInteger(p.decimals ?? 2, 'decimals', 0, 15);

  const presentValues = fcfSeries.map((fcf, i) => {
    const year = i + 1;
    const pv = fcf / Math.pow(1 + discountRate, year);
    return round(pv, decimals);
  });

  const lastFCF = fcfSeries[fcfSeries.length - 1];
  const valueFutureSale = round(lastFCF * terminalMultiple, decimals);
  const pvFutureSale = round(
    valueFutureSale / Math.pow(1 + discountRate, fcfSeries.length),
    decimals
  );

  const pvFCFs = presentValues.reduce((a, b) => a + b, 0);
  const totalPresentValue = round(pvFCFs + pvFutureSale, decimals);
  const terminalShare = pvFutureSale / totalPresentValue;

  let perShare = null;
  if (p.sharesOutstanding) {
    const netDebt = p.netDebt ?? (p.totalDebt ?? 0) - (p.cash ?? 0);
    const equityValue = totalPresentValue - netDebt;
    perShare = {
      enterpriseValue: totalPresentValue,
      netDebt: round(netDebt, decimals),
      equityValue: round(equityValue, decimals),
      sharesOutstanding: p.sharesOutstanding,
      intrinsicValuePerShare: round(equityValue / p.sharesOutstanding, 4),
    };
  }

  return {
    fcfSeries,
    presentValueFCFs: presentValues,
    valueFutureSale,
    presentValueFutureSale: pvFutureSale,
    totalPresentValue,
    inputs: {
      discountRate,
      terminalFcfMultiple: terminalMultiple,
      projectionYears: fcfSeries.length,
    },
    summary: {
      presentValueOfFCFs: round(pvFCFs, decimals),
      presentValueOfTerminal: pvFutureSale,
      terminalValueShare: round(terminalShare, 4),
      terminalValueSharePct: pct(terminalShare),
    },
    ...(perShare ? { equity: perShare } : {}),
    yearLabels: fcfSeries.map((_, i) => `Y${i + 1}`),
  };
}

// ─── 3.4 Sensitivity analysis ────────────────────────────────────────────────

function calcSensitivity(p) {
  const fcf = p.firstFreeCashFlow;
  if (fcf === undefined) {
    throw new Error('缺少必填参数: firstFreeCashFlow');
  }
  const growthRates = p.growthRates ?? [p.growthRate ?? 0.05];
  finiteNumberArray(growthRates, 'growthRates', MAX_YEARS);
  const baseDiscount = p.discountRate ?? 0.10;
  const baseTerminal = p.terminalFcfMultiple ?? p.terminalMultiple ?? 15;
  const sharesOutstanding = p.sharesOutstanding;
  const netDebt = p.netDebt ?? 0;

  const drRange = p.discountRateRange ?? 0.03;
  const drStep = p.discountRateStep ?? 0.01;
  const drStart = Math.max(0.01, baseDiscount - drRange);
  const drEnd = baseDiscount + drRange;

  const tmRange = p.terminalMultipleRange ?? 5;
  const tmStep = p.terminalMultipleStep ?? 1;
  finiteNumber(drRange, 'discountRateRange');
  finiteNumber(drStep, 'discountRateStep');
  finiteNumber(tmRange, 'terminalMultipleRange');
  finiteNumber(tmStep, 'terminalMultipleStep');
  if (drRange < 0 || tmRange < 0) throw new Error('敏感性分析范围不能为负数');
  if (drStep <= 0 || tmStep <= 0) throw new Error('敏感性分析步长必须大于 0');
  const tmStart = Math.max(1, baseTerminal - tmRange);
  const tmEnd = baseTerminal + tmRange;
  const drPoints = Math.floor((drEnd - drStart) / drStep) + 1;
  const tmPoints = Math.floor((tmEnd - tmStart) / tmStep) + 1;
  if (drPoints > 101 || tmPoints > 101 || drPoints * tmPoints > 10000) {
    throw new Error('敏感性分析网格过大；每个维度最多 101 个点，总计最多 10000 个点');
  }

  const discountRates = [];
  for (let r = drStart; r <= drEnd + 1e-9; r += drStep) {
    discountRates.push(round(r, 4));
  }

  const terminalMultiples = [];
  for (let m = tmStart; m <= tmEnd + 1e-9; m += tmStep) {
    terminalMultiples.push(round(m, 1));
  }

  const chartData = [];
  for (const dr of discountRates) {
    for (const tm of terminalMultiples) {
      const res = DCF.calculate(fcf, growthRates, tm, dr, 2);
      let val = res.totalPresentValue;
      if (sharesOutstanding) {
        val = round((val - netDebt) / sharesOutstanding, 4);
      }
      chartData.push({
        discountRate: pct(dr),
        terminalMultiple: tm,
        value: val,
      });
    }
  }

  const metric = sharesOutstanding ? '每股内在价值' : '企业总现值';
  const formattedDiscountRates = discountRates.map((r) => pct(r));
  const vegaLiteSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    description: `DCF敏感性分析：${metric}`,
    data: { values: chartData },
    mark: 'rect',
    encoding: {
      x: {
        field: 'terminalMultiple',
        type: 'ordinal',
        sort: terminalMultiples,
        title: '终端倍数',
      },
      y: {
        field: 'discountRate',
        type: 'ordinal',
        sort: formattedDiscountRates,
        title: '折现率',
      },
      color: {
        field: 'value',
        type: 'quantitative',
        title: metric,
      },
      tooltip: [
        { field: 'discountRate', type: 'ordinal', title: '折现率' },
        { field: 'terminalMultiple', type: 'ordinal', title: '终端倍数' },
        { field: 'value', type: 'quantitative', title: metric },
      ],
    },
  };

  return {
    sensitivity: {
      metric,
      chartData,
      vegaLiteSpec,
      baseCase: {
        discountRate: pct(baseDiscount),
        terminalMultiple: baseTerminal,
      },
    },
    inputs: {
      firstFreeCashFlow: fcf,
      growthRates,
      sharesOutstanding: sharesOutstanding ?? null,
      netDebt,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Additional absolute valuation methods
// ═══════════════════════════════════════════════════════════════════════════

// ─── 3.6 DDM (dividend discount model) ───────────────────────────────────────

function calcDDM(p) {
  const D0 = p.dividend;
  if (D0 === undefined) {
    throw new Error('缺少必填参数: dividend (当前股利 D0)');
  }
  const g = p.growthRate;
  if (g === undefined) {
    throw new Error('缺少必填参数: growthRate (永续增长率)');
  }
  const r = p.discountRate;
  if (r === undefined) {
    throw new Error('缺少必填参数: discountRate (要求回报率)');
  }
  if (g >= r) {
    throw new Error(`永续增长率 (${g}) 必须小于要求回报率 (${r})`);
  }

  // Three-stage model: high growth, transition, then perpetual growth
  if (p.highGrowthRate !== undefined && p.highGrowthYears !== undefined && p.transitionYears !== undefined) {
    const highYears = boundedInteger(p.highGrowthYears, 'highGrowthYears', 1, 100);
    const transitionYears = boundedInteger(p.transitionYears, 'transitionYears', 1, 100);
    return calcDDMThreeStage(D0, p.highGrowthRate, highYears, g, transitionYears, r);
  }

  // Two-stage model: high growth followed by perpetual growth
  if (p.highGrowthRate !== undefined && p.highGrowthYears !== undefined) {
    const highYears = boundedInteger(p.highGrowthYears, 'highGrowthYears', 1, 100);
    return calcDDMTwoStage(D0, p.highGrowthRate, highYears, g, r);
  }

  // Single-stage Gordon Growth model
  const D1 = D0 * (1 + g);
  const intrinsicValue = D1 / (r - g);

  return {
    intrinsicValue: round(intrinsicValue, 4),
    model: 'single-stage (Gordon Growth)',
    formula: 'P = D1 / (r - g), D1 = D0 x (1 + g)',
    components: {
      D0,
      D1: round(D1, 4),
      growthRate: g,
      discountRate: r,
    },
  };
}

function calcDDMTwoStage(D0, highG, highYears, permG, r) {
  const highDividends = [];
  const highPVs = [];
  let currentDiv = D0;

  for (let i = 1; i <= highYears; i++) {
    currentDiv *= (1 + highG);
    const pv = currentDiv / Math.pow(1 + r, i);
    highDividends.push(round(currentDiv, 4));
    highPVs.push(round(pv, 4));
  }

  // Perpetual value based on the final high-growth-year dividend
  const finalDiv = currentDiv * (1 + permG);
  const terminalValue = finalDiv / (r - permG);
  const pvTerminal = terminalValue / Math.pow(1 + r, highYears);

  const intrinsicValue = highPVs.reduce((a, b) => a + b, 0) + pvTerminal;

  return {
    intrinsicValue: round(intrinsicValue, 4),
    model: 'two-stage',
    formula: 'P = sum(D_i / (1+r)^i) + [D_n x (1+g) / (r-g)] / (1+r)^n',
    components: {
      D0,
      highGrowthRate: highG,
      highGrowthYears: highYears,
      perpetualGrowthRate: permG,
      discountRate: r,
      highGrowthDividends: highDividends,
      highGrowthPVs: highPVs,
      terminalValue: round(terminalValue, 4),
      pvTerminal: round(pvTerminal, 4),
    },
  };
}

function calcDDMThreeStage(D0, highG, highYears, permG, transYears, r) {
  const allDividends = [];
  const allPVs = [];
  let currentDiv = D0;

  // Stage 1: high growth
  for (let i = 1; i <= highYears; i++) {
    currentDiv *= (1 + highG);
    const pv = currentDiv / Math.pow(1 + r, i);
    allDividends.push({ year: i, dividend: round(currentDiv, 4), pv: round(pv, 4), stage: 'high' });
    allPVs.push(pv);
  }

  // Stage 2: transition with linear growth-rate decline
  const growthStep = (permG - highG) / transYears;
  for (let i = 1; i <= transYears; i++) {
    const transG = highG + growthStep * i;
    currentDiv *= (1 + transG);
    const year = highYears + i;
    const pv = currentDiv / Math.pow(1 + r, year);
    allDividends.push({ year, dividend: round(currentDiv, 4), pv: round(pv, 4), stage: 'transition', growthRate: round(transG, 4) });
    allPVs.push(pv);
  }

  // Stage 3: perpetual growth
  const finalDiv = currentDiv * (1 + permG);
  const terminalYear = highYears + transYears;
  const terminalValue = finalDiv / (r - permG);
  const pvTerminal = terminalValue / Math.pow(1 + r, terminalYear);

  const intrinsicValue = allPVs.reduce((a, b) => a + b, 0) + pvTerminal;

  return {
    intrinsicValue: round(intrinsicValue, 4),
    model: 'three-stage',
    formula: 'P = sum(高增长期PV) + sum(过渡期PV) + [永续期终端价值PV]',
    components: {
      D0,
      highGrowthRate: highG,
      highGrowthYears: highYears,
      transitionYears: transYears,
      perpetualGrowthRate: permG,
      discountRate: r,
      dividends: allDividends,
      terminalValue: round(terminalValue, 4),
      pvTerminal: round(pvTerminal, 4),
    },
  };
}

// ─── 3.7 rNPV (risk-adjusted net present value) ──────────────────────────────

function calcRNPV(p) {
  const pipeline = p.pipeline;
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    throw new Error('缺少必填参数: pipeline (管线数组)');
  }
  if (pipeline.length > 1000) throw new Error('pipeline 最多支持 1000 个项目');

  let totalRNPV = 0;
  const details = pipeline.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`管线 ${i}: 必须是 JSON 对象`);
    }
    if (!Array.isArray(item.cashFlows) || item.cashFlows.length === 0) {
      throw new Error(`管线 ${i}: 缺少 cashFlows 数组`);
    }
    finiteNumberArray(item.cashFlows, `pipeline[${i}].cashFlows`, 100);
    const dr = item.discountRate ?? 0.10;
    const probability = item.probability;
    if (probability === undefined) {
      throw new Error(`管线 ${i}: 缺少 probability (成功率)`);
    }
    const initialCost = item.initialCost ?? 0;
    finiteNumber(dr, `pipeline[${i}].discountRate`);
    finiteNumber(probability, `pipeline[${i}].probability`);
    finiteNumber(initialCost, `pipeline[${i}].initialCost`);
    if (probability < 0 || probability > 1) {
      throw new Error(`pipeline[${i}].probability 必须在 0 到 1 之间`);
    }

    // Calculate NPV
    let npv = -initialCost;
    const pvDetails = item.cashFlows.map((cf, year) => {
      const pv = cf / Math.pow(1 + dr, year + 1);
      npv += pv;
      return { year: year + 1, cashFlow: cf, pv: round(pv, 2) };
    });

    const riskAdjustedNPV = npv * probability;
    totalRNPV += riskAdjustedNPV;

    return {
      name: item.name ?? `管线${i + 1}`,
      probability,
      discountRate: dr,
      initialCost,
      npv: round(npv, 2),
      riskAdjustedNPV: round(riskAdjustedNPV, 2),
      cashFlowDetails: pvDetails,
    };
  });

  return {
    rnpv: round(totalRNPV, 2),
    pipelineDetails: details,
    formula: 'rNPV = sum(NPV_i x P_success_i)',
  };
}

// ─── 3.8 Black-Scholes option pricing model ──────────────────────────────────

function calcBlackScholes(p) {
  const S = p.S;
  const K = p.K;
  const T = p.T;
  const r = p.r;
  const sigma = p.sigma;
  const q = p.q ?? 0;

  if (S === undefined || K === undefined || T === undefined || r === undefined || sigma === undefined) {
    throw new Error('需要提供 S, K, T, r, sigma (q 可选)');
  }
  if (T <= 0) {
    throw new Error('T (到期时间) 必须大于 0');
  }
  if (S <= 0 || K <= 0 || sigma <= 0) {
    throw new Error('S、K 和 sigma 必须大于 0');
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const Nd1 = normalCDF(d1);
  const Nd2 = normalCDF(d2);
  const NnegD1 = normalCDF(-d1);
  const NnegD2 = normalCDF(-d2);

  const callPrice = S * Math.exp(-q * T) * Nd1 - K * Math.exp(-r * T) * Nd2;
  const putPrice = K * Math.exp(-r * T) * NnegD2 - S * Math.exp(-q * T) * NnegD1;

  // Greeks
  const deltaCall = Math.exp(-q * T) * Nd1;
  const deltaPut = -Math.exp(-q * T) * NnegD1;
  const gamma = Math.exp(-q * T) * normalPDF(d1) / (S * sigma * sqrtT);
  const vega = S * Math.exp(-q * T) * normalPDF(d1) * sqrtT;
  const thetaCall = (-S * normalPDF(d1) * sigma * Math.exp(-q * T)) / (2 * sqrtT)
    - r * K * Math.exp(-r * T) * Nd2 + q * S * Math.exp(-q * T) * Nd1;
  const thetaPut = (-S * normalPDF(d1) * sigma * Math.exp(-q * T)) / (2 * sqrtT)
    + r * K * Math.exp(-r * T) * NnegD2 - q * S * Math.exp(-q * T) * NnegD1;
  const rhoCall = K * T * Math.exp(-r * T) * Nd2;
  const rhoPut = -K * T * Math.exp(-r * T) * NnegD2;

  return {
    callPrice: round(callPrice, 4),
    putPrice: round(putPrice, 4),
    d1: round(d1, 6),
    d2: round(d2, 6),
    N_d1: round(Nd1, 6),
    N_d2: round(Nd2, 6),
    greeks: {
      deltaCall: round(deltaCall, 6),
      deltaPut: round(deltaPut, 6),
      gamma: round(gamma, 6),
      vega: round(vega, 4),
      thetaCall: round(thetaCall, 4),
      thetaPut: round(thetaPut, 4),
      rhoCall: round(rhoCall, 4),
      rhoPut: round(rhoPut, 4),
    },
    formula: 'Call = S x N(d1) - K x e^(-rT) x N(d2); Put = K x e^(-rT) x N(-d2) - S x N(-d1)',
  };
}

// ─── Method routing ──────────────────────────────────────────────────────────

const METHODS = {
  dcf: { desc: '基础DCF估值（10年增长率驱动投影）', required: ['firstFreeCashFlow'], exec: calcDCF },
  'dcf-per-share': { desc: '每股内在价值DCF（需总股本+净债务）', required: ['firstFreeCashFlow'], exec: calcDCFPerShare },
  wacc: { desc: 'WACC加权平均资本成本（CAPM模型）', required: [], exec: calcWACC },
  sensitivity: { desc: '敏感性分析矩阵（折现率 x 终端倍数）', required: ['firstFreeCashFlow'], exec: calcSensitivity },
  'fcf-series': { desc: '自定义FCF序列估值（非增长率驱动）', required: ['fcfSeries'], exec: calcFCFSeries },
  ddm: { desc: '股利贴现模型（单阶段/两阶段/三阶段）', required: ['dividend', 'growthRate', 'discountRate'], exec: calcDDM },
  rnpv: { desc: '风险调整净现值（管线估值法）', required: ['pipeline'], exec: calcRNPV },
  'black-scholes': { desc: '期权定价模型', required: ['S', 'K', 'T', 'r', 'sigma'], exec: calcBlackScholes },
};

const VALID_METHODS = Object.keys(METHODS);

function main() {
  const argv = process.argv.slice(2);

  if (argv.length < 1 || argv[0] === '--help' || argv[0] === '-h') {
    const help = VALID_METHODS.map((m) => `  ${m.padEnd(20)} ${METHODS[m].desc}`).join('\n');
    console.log(`用法: node absolute.mjs <method> [--key value ... | --params-file <tmp-*.json>]\n   人工兼容: node absolute.mjs <method> '<params-json>'\n\n支持方法:\n${help}`);
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

export { METHODS, VALID_METHODS, normalCDF, normalPDF };
