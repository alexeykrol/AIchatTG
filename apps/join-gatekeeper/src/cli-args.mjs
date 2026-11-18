// Tiny `--key value` / `--flag` parser for the operator CLIs.
export function parseArgs(argv, { flags = [], options = [] } = {}) {
  const [command, ...rest] = argv;
  const result = { command, flags: {}, options: {} };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (flags.includes(name)) {
      result.flags[name] = true;
    } else if (options.includes(name)) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value`);
      result.options[name] = value;
      i += 1;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return result;
}

export function requireOption(parsed, name) {
  const value = parsed.options[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}
