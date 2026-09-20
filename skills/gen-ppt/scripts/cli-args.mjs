function parseArgs(argv, { valueOptions = [], booleanOptions = [], maxPositionals = Infinity } = {}) {
  const valueNames = new Set(valueOptions);
  const booleanNames = new Set(booleanOptions);
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
      if (positionals.length > maxPositionals) throw new Error(`Unexpected positional argument: ${argument}`);
      continue;
    }
    if (!argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);

    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator === -1 ? undefined : separator);
    if (!valueNames.has(name) && !booleanNames.has(name)) throw new Error(`Unknown option: --${name}`);
    if (Object.prototype.hasOwnProperty.call(options, name)) throw new Error(`Duplicate option: --${name}`);
    if (booleanNames.has(name)) {
      if (separator !== -1) throw new Error(`--${name} does not take a value`);
      options[name] = true;
      continue;
    }

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

export function parseGenPptArgs(argv) {
  return parseArgs(argv, { valueOptions: ["theme", "target"], maxPositionals: 2 });
}

export function parseMarkdownSlidesArgs(argv) {
  return parseArgs(argv, { valueOptions: ["theme", "title"], maxPositionals: 2 });
}

export function parseViewerArgs(argv, { requireFile = true } = {}) {
  const parsed = parseArgs(argv, {
    booleanOptions: ["libreoffice", "keynote", "powerpoint"],
    maxPositionals: requireFile ? 1 : 0,
  });
  if (!parsed.help && requireFile && parsed.positionals.length !== 1) {
    throw new Error("Exactly one PPTX file path is required");
  }
  return parsed;
}
