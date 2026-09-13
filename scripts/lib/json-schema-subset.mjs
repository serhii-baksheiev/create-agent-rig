// A dependency-free validator for the closed JSON Schema subset the
// conformance payload uses (RP-13). The subset is deliberately small — `type`
// (object / string / integer / array), `properties`, `required`,
// `additionalProperties: false`, `enum`, `const`, `items`, `pattern`, plus the
// annotation keywords `$schema`, `$id`, `title`, `description` — so that a
// schema shipped to every rig can be checked by a rig with no dependency, and
// so nobody quietly leans on a keyword (`$ref`, `oneOf`, `if`) this validator
// does not implement: an unknown keyword THROWS rather than being ignored,
// because a keyword silently skipped is a check that reports a pass it never
// made. Pinned in test/template/json-schema-subset.test.ts.
//
// Bounded work: one pass over the value, recursion bounded by the schema's own
// depth (a schema is repository data, not input), no rescanning.

const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description', 'examples']);
const KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'const',
  'items',
  'pattern',
  'minLength',
]);
const TYPES = new Set(['object', 'string', 'integer', 'array', 'number', 'boolean']);

const assertSubset = (schema, at) => {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema))
    throw new Error(`json-schema-subset: the schema at ${at} must be an object`);
  for (const key of Object.keys(schema)) {
    if (ANNOTATIONS.has(key) || KEYWORDS.has(key)) continue;
    throw new Error(
      `json-schema-subset: keyword "${key}" at ${at} is outside the supported subset ` +
        `(${[...KEYWORDS].join(', ')})`,
    );
  }
  if (schema.type !== undefined && !TYPES.has(schema.type))
    throw new Error(`json-schema-subset: type "${schema.type}" at ${at} is outside the subset`);
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
    throw new Error(
      `json-schema-subset: additionalProperties at ${at} may only be false (omit it to allow)`,
    );
  if (schema.properties !== undefined)
    for (const [name, child] of Object.entries(schema.properties))
      assertSubset(child, `${at}.properties.${name}`);
  if (schema.items !== undefined) assertSubset(schema.items, `${at}.items`);
};

const typeOf = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
};

const check = (schema, value, at, errors) => {
  if (schema.type !== undefined) {
    const actual = typeOf(value);
    const accepted =
      schema.type === 'number'
        ? actual === 'number' || actual === 'integer'
        : actual === schema.type;
    if (!accepted) {
      errors.push(`${at}: expected ${schema.type}, got ${actual}`);
      return;
    }
  }
  if (schema.const !== undefined && value !== schema.const)
    errors.push(`${at}: expected the constant ${JSON.stringify(schema.const)}`);
  if (schema.enum !== undefined && !schema.enum.includes(value))
    errors.push(`${at}: expected one of ${JSON.stringify(schema.enum)}`);
  if (
    schema.pattern !== undefined &&
    typeof value === 'string' &&
    !new RegExp(schema.pattern).test(value)
  )
    errors.push(`${at}: does not match ${schema.pattern}`);
  if (
    schema.minLength !== undefined &&
    typeof value === 'string' &&
    value.length < schema.minLength
  )
    errors.push(`${at}: shorter than ${schema.minLength}`);
  if (typeOf(value) === 'object') {
    for (const name of schema.required ?? [])
      if (!(name in value)) errors.push(`${at}.${name}: required`);
    const properties = schema.properties ?? {};
    for (const [name, child] of Object.entries(value)) {
      if (name in properties) check(properties[name], child, `${at}.${name}`, errors);
      else if (schema.additionalProperties === false)
        errors.push(`${at}.${name}: additional property not allowed`);
    }
  }
  if (typeOf(value) === 'array' && schema.items !== undefined)
    value.forEach((item, index) => check(schema.items, item, `${at}[${index}]`, errors));
};

/**
 * @param {object} schema a schema inside the subset (throws otherwise)
 * @param {unknown} value
 * @returns {{ ok: boolean, errors: string[] }} errors name the JSON path, e.g. `checks[0].fix: required`
 */
export const validate = (schema, value) => {
  assertSubset(schema, '$');
  const errors = [];
  check(schema, value, '$', errors);
  return { ok: errors.length === 0, errors: errors.map((error) => error.replace(/^\$\.?/, '')) };
};
