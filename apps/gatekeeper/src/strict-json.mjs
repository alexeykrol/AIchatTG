function jsonPath(segments) {
  let result = String(segments[0] || 'root');
  for (const segment of segments.slice(1)) {
    if (Number.isInteger(segment)) result += `[${segment}]`;
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(segment)) result += `.${segment}`;
    else result += `[${JSON.stringify(segment)}]`;
  }
  return result;
}

export class DuplicateJsonKeyError extends Error {
  constructor(path) {
    super(`duplicate JSON key at ${path}`);
    this.name = 'DuplicateJsonKeyError';
    this.path = path;
  }
}

export function assertNoDuplicateJsonKeys(rawJson) {
  let index = 0;

  function skipWhitespace() {
    while (index < rawJson.length && /\s/u.test(rawJson[index])) index += 1;
  }

  function scannerSyntaxError() {
    throw new SyntaxError('raw JSON scanner stopped at invalid syntax');
  }

  function parseString() {
    if (rawJson[index] !== '"') scannerSyntaxError();
    const start = index;
    index += 1;
    while (index < rawJson.length) {
      const character = rawJson[index];
      if (character === '"') {
        index += 1;
        return JSON.parse(rawJson.slice(start, index));
      }
      if (character === '\\') {
        index += 2;
        continue;
      }
      index += 1;
    }
    scannerSyntaxError();
  }

  function parseLiteral(pattern) {
    const match = pattern.exec(rawJson.slice(index));
    if (!match) scannerSyntaxError();
    index += match[0].length;
  }

  function parseArray(path) {
    index += 1;
    skipWhitespace();
    if (rawJson[index] === ']') {
      index += 1;
      return;
    }
    let itemIndex = 0;
    while (index < rawJson.length) {
      parseValue([...path, itemIndex]);
      itemIndex += 1;
      skipWhitespace();
      if (rawJson[index] === ']') {
        index += 1;
        return;
      }
      if (rawJson[index] !== ',') scannerSyntaxError();
      index += 1;
      skipWhitespace();
    }
    scannerSyntaxError();
  }

  function parseObject(path) {
    index += 1;
    skipWhitespace();
    if (rawJson[index] === '}') {
      index += 1;
      return;
    }
    const keys = new Set();
    while (index < rawJson.length) {
      const key = parseString();
      if (keys.has(key)) throw new DuplicateJsonKeyError(jsonPath([...path, key]));
      keys.add(key);
      skipWhitespace();
      if (rawJson[index] !== ':') scannerSyntaxError();
      index += 1;
      parseValue([...path, key]);
      skipWhitespace();
      if (rawJson[index] === '}') {
        index += 1;
        return;
      }
      if (rawJson[index] !== ',') scannerSyntaxError();
      index += 1;
      skipWhitespace();
    }
    scannerSyntaxError();
  }

  function parseValue(path) {
    skipWhitespace();
    const character = rawJson[index];
    if (character === '{') parseObject(path);
    else if (character === '[') parseArray(path);
    else if (character === '"') parseString();
    else if (character === 't') parseLiteral(/^true/u);
    else if (character === 'f') parseLiteral(/^false/u);
    else if (character === 'n') parseLiteral(/^null/u);
    else parseLiteral(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
  }

  try {
    parseValue(['root']);
    skipWhitespace();
    if (index !== rawJson.length) scannerSyntaxError();
  } catch (error) {
    if (error instanceof DuplicateJsonKeyError) throw error;
    if (error instanceof SyntaxError) return;
    throw new Error(`raw JSON duplicate-key scan failed closed: ${error.message}`, { cause: error });
  }
}
