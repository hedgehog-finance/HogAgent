#!/usr/bin/env node
/**
 * Hedgehog Fincalc — Local Financial Calculator (ESM).
 *
 * Usage:
 *   node ./scripts/call-api.mjs <method> [--key value ... | --params-file <tmp-*.json>]
 */

import FinMaster from 'finmaster';
import { fileURLToPath } from 'node:url';
import { loadJsonParams } from './params.mjs';

const fm = new FinMaster();
const MAX_CASH_FLOWS = 100000;

function finiteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite JSON number, not a numeric string`);
  }
}

function validateParams(params) {
  for (const name of ['rate', 'nper', 'pmt', 'fv', 'type', 'pv', 'guess', 'precision', 'loanTerm']) {
    if (params[name] !== undefined) finiteNumber(params[name], name);
  }
  if (params.cashFlows !== undefined) {
    if (!Array.isArray(params.cashFlows) || params.cashFlows.length === 0 || params.cashFlows.length > MAX_CASH_FLOWS) {
      throw new Error(`cashFlows must contain between 1 and ${MAX_CASH_FLOWS} values`);
    }
    params.cashFlows.forEach((value, index) => finiteNumber(value, `cashFlows[${index}]`));
  }
  for (const name of ['startDateStr', 'loanTermUnit']) {
    if (params[name] !== undefined && (typeof params[name] !== 'string' || params[name].length === 0 || params[name].length > 64)) {
      throw new Error(`${name} must be a non-empty string of at most 64 characters`);
    }
  }
}

// Method whitelist and parameter mapping
const METHODS = {
  pv: {
    required: ['rate', 'nper', 'pmt'],
    exec: (p) => fm.PV(p.rate, p.nper, p.pmt, p.fv ?? 0, p.type ?? 0),
  },
  fv: {
    required: ['rate', 'nper', 'pmt'],
    exec: (p) => fm.FV(p.rate, p.nper, p.pmt, p.pv ?? 0, p.type ?? 0),
  },
  pmt: {
    required: ['rate', 'nper', 'pv'],
    exec: (p) => fm.PMT(p.rate, p.nper, p.pv, p.fv ?? 0, p.type ?? 0),
  },
  npv: {
    required: ['rate', 'cashFlows'],
    exec: (p) => fm.NPV(p.rate, p.cashFlows),
  },
  irr: {
    required: ['cashFlows'],
    exec: (p) => fm.IRR(p.cashFlows, p.guess ?? 0.1),
  },
  rate: {
    required: ['nper', 'pmt', 'pv'],
    exec: (p) => fm.RATE(p.nper, p.pmt, p.pv, p.fv ?? 0, p.type ?? 0, p.guess ?? 0.1),
  },
  'remaining-loan-term': {
    required: ['startDateStr', 'loanTerm', 'loanTermUnit'],
    exec: (p) => fm.getRemainingLoanTerm(p.startDateStr, p.loanTerm, p.loanTermUnit),
  },
};

const VALID_METHODS = Object.keys(METHODS);

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log(
      `Usage: node call-api.mjs <method> [--key value ... | --params-file <tmp-*.json>]\n` +
      `Supported methods: ${VALID_METHODS.join(', ')}`
    );
    return;
  }
  if (argv.length < 1) {
    throw new Error(
      `Usage: node call-api.mjs <method> [--key value ... | --params-file <tmp-*.json>]\n` +
      `   manual compatibility: node call-api.mjs <method> '<params-json>'\n` +
      `Supported methods: ${VALID_METHODS.join(', ')}`
    );
  }

  const method = argv[0].toLowerCase();
  const def = METHODS[method];
  if (!def) {
    throw new Error(
      `Unsupported method: ${method}\nSupported methods: ${VALID_METHODS.join(', ')}`
    );
  }

  const params = loadJsonParams(argv.slice(1));
  validateParams(params);

  // Validate required parameters
  const missing = def.required.filter((k) => params[k] === undefined);
  if (missing.length > 0) {
    throw new Error(`Method '${method}' missing required parameters: ${missing.join(', ')}`);
  }

  const precision = params.precision ?? 6;
  if (!Number.isInteger(precision) || precision < 0 || precision > 15) {
    throw new Error('precision must be an integer between 0 and 15');
  }

  const result = def.exec(params);
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new Error(`Method '${method}' did not produce a finite numeric result`);
  }
  const formatted = Number.isInteger(result)
    ? result.toString()
    : result.toFixed(precision).replace(/0+$/, '').replace(/\.$/, '');

  console.log(JSON.stringify({ method, result, formatted, precision }, null, 2));
}

// Run if executed directly (not imported)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

export { METHODS, VALID_METHODS };
