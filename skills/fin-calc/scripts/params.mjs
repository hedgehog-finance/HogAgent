import { readFileSync, statSync } from 'node:fs';

const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const RESERVED_FLAT_NAMES = new Set(['api', 'dir', 'out', 'output']);

function parseScalar(raw, name) {
  if (raw.trim() === '') throw new Error(`--${name} requires a non-empty value`);
  if (/\r|\n/.test(raw)) throw new Error(`--${name} contains multiple lines; use --params-file <tmp-*.json>`);
  if (raw === 'null' || /^[\[{]/.test(raw.trim())) {
    throw new Error(`--${name} is not a flat scalar; use --params-file <tmp-*.json>`);
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (NUMBER_PATTERN.test(raw)) {
    const number = Number(raw);
    if (Number.isFinite(number)) return number;
  }
  return raw;
}

function parseJsonObject(raw, source) {
  let value;
  try {
    value = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    const advice = source === '--params' || source === '<params-json>'
      ? ' Use flat named parameters or write UTF-8 JSON to tmp-*.json and use --params-file.'
      : '';
    throw new Error(`Invalid JSON from ${source}: ${error.message}.${advice}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} must contain a JSON object`);
  }
  return value;
}

/** Parse one mutually exclusive payload: flat named scalars, a JSON file, or legacy inline JSON. */
export function loadJsonParams(args) {
  const flat = {};
  let inlineJson;
  let paramsFile;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      if (inlineJson !== undefined) throw new Error('Only one legacy positional JSON argument is allowed');
      inlineJson = arg;
      continue;
    }

    const equalAt = arg.indexOf('=');
    const name = arg.slice(2, equalAt === -1 ? undefined : equalAt);
    if (!name) throw new Error(`Invalid parameter name: ${arg}`);
    const raw = equalAt === -1 ? args[i + 1] : arg.slice(equalAt + 1);
    if (equalAt === -1) {
      if (raw === undefined || raw.startsWith('--')) throw new Error(`--${name} requires a value`);
      i += 1;
    }

    if (name === 'params' || name === 'params-file') {
      if (raw === '') throw new Error(`--${name} requires a value`);
      if (name === 'params') {
        if (inlineJson !== undefined) throw new Error('Legacy JSON can only be provided once');
        inlineJson = raw;
      } else {
        if (paramsFile !== undefined) throw new Error('--params-file can only be provided once');
        paramsFile = raw;
      }
      continue;
    }

    if (RESERVED_FLAT_NAMES.has(name)) throw new Error(`--${name} is reserved; use --params-file when it is a business field`);
    if (Object.prototype.hasOwnProperty.call(flat, name)) throw new Error(`Duplicate business parameter: --${name}`);
    flat[name] = parseScalar(raw, name);
  }

  const sources = [Object.keys(flat).length > 0, inlineJson !== undefined, paramsFile !== undefined].filter(Boolean).length;
  if (sources > 1) throw new Error('Flat parameters, --params-file, and legacy JSON are mutually exclusive');
  if (paramsFile !== undefined) {
    let raw;
    try {
      const fileStat = statSync(paramsFile);
      if (!fileStat.isFile() || fileStat.size > 10 * 1024 * 1024) throw new Error('parameter file must be a regular file no larger than 10MB');
      raw = readFileSync(paramsFile, 'utf8');
    } catch (error) {
      throw new Error(`Cannot read --params-file ${paramsFile}: ${error.message}`);
    }
    return parseJsonObject(raw, `--params-file ${paramsFile}`);
  }
  if (inlineJson !== undefined) return parseJsonObject(inlineJson, '<params-json>');
  return flat;
}
