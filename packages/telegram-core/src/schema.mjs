/**
 * A deliberately small JSON Schema walker: it interprets exactly the keywords
 * the two package contracts use (`contracts/retrieval_pack.v1.schema.json` and
 * `contracts/retrieval_request.v1.schema.json`) and nothing else. It mirrors the
 * lab's stdlib validator (`retrieval.py:375 _walk_schema`) rather than pulling a
 * general implementation into the runtime, because the artefact it must police
 * is fixed and signed: an unknown keyword here is a contract change, which is a
 * review event, not a dependency upgrade.
 *
 * `additionalProperties: false` is enforced strictly on purpose — the contract
 * forbids extra fields, so a stray field is a defect of our own projection
 * rather than a tolerable extension (agentic-pipeline P3).
 */

const TYPE_CHECKS = Object.freeze({
  object: (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === 'string',
  integer: (v) => Number.isInteger(v) && typeof v === 'number',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
});

const MAX_ERRORS = 20;

function equalValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => equalValue(item, b[index]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return keysA.length === keysB.length && keysA.every((key) => equalValue(a[key], b[key]));
  }
  return false;
}

function walk(value, schema, path, errors) {
  if (errors.length >= MAX_ERRORS || !schema || typeof schema !== 'object') return;

  const types = schema.type;
  if (types != null) {
    const allowed = Array.isArray(types) ? types : [types];
    // An unknown type name is a schema we do not understand; refusing is the
    // only honest answer, because silently passing would defeat the contract.
    if (!allowed.every((name) => Object.hasOwn(TYPE_CHECKS, name))) {
      errors.push(`${path}: unsupported schema type ${JSON.stringify(types)}`);
      return;
    }
    if (!allowed.some((name) => TYPE_CHECKS[name](value))) {
      errors.push(`${path}: expected type ${allowed.join('|')}`);
      return;
    }
  }
  if (Object.hasOwn(schema, 'const') && !equalValue(value, schema.const)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => equalValue(value, option))) {
    errors.push(`${path}: value outside enum`);
  }
  if (typeof value === 'string') {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) {
      errors.push(`${path}: shorter than ${schema.minLength}`);
    }
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) {
      errors.push(`${path}: longer than ${schema.maxLength}`);
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    }
    if (Number.isFinite(schema.maximum) && value > schema.maximum) {
      errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
    }
  }
  if (TYPE_CHECKS.object(value)) {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, name)) errors.push(`${path}: missing required field ${JSON.stringify(name)}`);
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!Object.hasOwn(properties, name)) errors.push(`${path}: unknown field ${JSON.stringify(name)}`);
      }
    }
    for (const [name, sub] of Object.entries(properties)) {
      if (Object.hasOwn(value, name)) walk(value[name], sub, `${path}.${name}`, errors);
    }
  }
  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) {
      errors.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) {
      errors.push(`${path}: more than ${schema.maxItems} items`);
    }
    if (schema.items) {
      value.forEach((item, index) => walk(item, schema.items, `${path}[${index}]`, errors));
    }
  }
  for (const sub of Array.isArray(schema.allOf) ? schema.allOf : []) walk(value, sub, path, errors);
  if (schema.if) {
    // `if/then` selects a branch: failures of the probe are not errors, they
    // only mean this branch does not apply.
    const probe = [];
    walk(value, schema.if, path, probe);
    if (!probe.length && schema.then) walk(value, schema.then, path, errors);
  }
}

/**
 * Validate a value against a schema subset. Errors are returned, never thrown:
 * the runtime distinguishes definitive from uncertain exits by reason code, and
 * an exception at this layer would be indistinguishable from a real crash.
 */
export function validateAgainstSchema(value, schema) {
  const errors = [];
  walk(value, schema, '$', errors);
  return { valid: errors.length === 0, errors: Object.freeze(errors) };
}

/**
 * Apply the top-level property defaults a schema declares, exactly as the lab's
 * `validate_request` does before validating. Only the outermost level is filled:
 * both contracts declare defaults nowhere else.
 */
export function applySchemaDefaults(value, schema) {
  if (!TYPE_CHECKS.object(value) || !TYPE_CHECKS.object(schema?.properties)) return value;
  const filled = { ...value };
  for (const [name, sub] of Object.entries(schema.properties)) {
    if (Object.hasOwn(sub || {}, 'default') && !Object.hasOwn(filled, name)) filled[name] = sub.default;
  }
  return filled;
}
