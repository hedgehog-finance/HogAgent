function parseOptions(argv, allowedNames) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === "-h" || argument === "--help") {
      if (argv.length !== 1) throw new Error("--help cannot be combined with other arguments");
      return { options, positionals, help: true };
    }
    if (!argument.startsWith("-")) {
      positionals.push(argument);
      continue;
    }

    const isShortOutput = argument === "-o";
    const separator = argument.indexOf("=");
    const name = isShortOutput ? "output" : argument.slice(2, separator === -1 ? undefined : separator);
    if (!isShortOutput && !argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    if (!allowedNames.has(name)) throw new Error(`Unknown option: ${argument}`);
    if (Object.prototype.hasOwnProperty.call(options, name)) throw new Error(`Duplicate option: --${name}`);

    const value = separator === -1 ? argv[i + 1] : argument.slice(separator + 1);
    if (separator === -1) {
      if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
      i++;
    }
    if (value.trim() === "") throw new Error(`--${name} requires a non-empty value`);
    options[name] = value;
  }
  return { options, positionals, help: false };
}

function assignPositional(options, name, value) {
  if (value === undefined) return;
  if (options[name] !== undefined) throw new Error(`Duplicate ${name}: positional value and --${name}`);
  options[name] = value;
}

export function parseChartRenderArgs(argv) {
  const parsed = parseOptions(argv, new Set(["spec", "output", "format", "palette", "theme"]));
  if (parsed.help) return parsed;
  if (parsed.positionals.length > 2) throw new Error(`Unexpected positional argument: ${parsed.positionals[2]}`);
  assignPositional(parsed.options, "spec", parsed.positionals[0]);
  assignPositional(parsed.options, "output", parsed.positionals[1]);
  return parsed;
}

export function parseEchartsArgs(argv) {
  const parsed = parseOptions(argv, new Set(["spec", "theme", "width", "height"]));
  if (parsed.help) return parsed;
  if (parsed.positionals.length > 1) throw new Error(`Unexpected positional argument: ${parsed.positionals[1]}`);
  assignPositional(parsed.options, "spec", parsed.positionals[0]);
  return parsed;
}

export function positiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`--${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 32768) {
    throw new Error(`--${name} must be between 1 and 32768`);
  }
  return parsed;
}
