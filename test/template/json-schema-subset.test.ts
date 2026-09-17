import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RP-13: the dependency-free JSON-Schema-subset validator
 * `scripts/lib/json-schema-subset.mjs` exports `validate(schema, value) ->
 * { ok, errors }` for exactly: `type` (object/string/integer/number/boolean/
 * array), `properties`, `required`, `additionalProperties: false`, `enum`,
 * `const`, `items`, `pattern`, `minLength`. A schema keyword outside that subset is refused by
 * throwing, so nobody silently relies on `$ref`/`oneOf`/etc, which a full
 * JSON-Schema engine such as ajv would need — this validator is deliberately
 * narrower and dependency-free, matching the zero-runtime-dependency rule
 * `memory-conformance.mjs` (its one caller) ships under.
 *
 * Loaded through a file URL, the way `secrets-lib.test.ts` and
 * `subagent-routing.test.ts` load plain `.mjs` modules with no type
 * declarations: its absence is a failing test here, not a failing typecheck.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const modulePath = path.join(repoRoot, 'scripts', 'lib', 'json-schema-subset.mjs');

interface ValidationResult {
  ok: boolean;
  errors: string[];
}
type Validate = (schema: unknown, value: unknown) => ValidationResult;

const loadValidate = async (): Promise<Validate> =>
  ((await import(pathToFileURL(modulePath).href)) as { validate: Validate }).validate;

describe('scripts/lib/json-schema-subset.mjs — type keyword', () => {
  it('accepts an object for type: object and rejects a non-object', async () => {
    const validate = await loadValidate();
    expect(validate({ type: 'object' }, {})).toEqual({ ok: true, errors: [] });
    const result = validate({ type: 'object' }, 'nope');
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('accepts a string for type: string and rejects a non-string', async () => {
    const validate = await loadValidate();
    expect(validate({ type: 'string' }, 'ok').ok).toBe(true);
    expect(validate({ type: 'string' }, 1).ok).toBe(false);
    expect(validate({ type: 'string' }, null).ok).toBe(false);
  });

  it('accepts a whole number for type: integer and rejects a float or a numeric string', async () => {
    const validate = await loadValidate();
    expect(validate({ type: 'integer' }, 3).ok).toBe(true);
    expect(validate({ type: 'integer' }, 0).ok).toBe(true);
    expect(validate({ type: 'integer' }, 3.5).ok).toBe(false);
    expect(validate({ type: 'integer' }, '3').ok).toBe(false);
  });

  it('accepts an array for type: array and rejects a non-array, including a plain object', async () => {
    const validate = await loadValidate();
    expect(validate({ type: 'array' }, []).ok).toBe(true);
    expect(validate({ type: 'array' }, {}).ok).toBe(false);
    expect(validate({ type: 'array' }, 'not an array').ok).toBe(false);
  });
});

describe('scripts/lib/json-schema-subset.mjs — properties, required, additionalProperties', () => {
  const schema = {
    type: 'object',
    required: ['id', 'status'],
    properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['ok', 'warn', 'fail'] },
    },
    additionalProperties: false,
  };

  it('accepts an object carrying every required property in its declared shape', async () => {
    const validate = await loadValidate();
    expect(validate(schema, { id: 'x', status: 'ok' })).toEqual({ ok: true, errors: [] });
  });

  it('rejects an object missing a required property, and names it in an error', async () => {
    const validate = await loadValidate();
    const result = validate(schema, { id: 'x' });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('status'))).toBe(true);
  });

  it('rejects a key additionalProperties: false does not declare', async () => {
    const validate = await loadValidate();
    const result = validate(schema, { id: 'x', status: 'ok', extra: 1 });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('extra'))).toBe(true);
  });

  it('tolerates an undeclared key when additionalProperties is not stated at all', async () => {
    const validate = await loadValidate();
    const open = { type: 'object', properties: { id: { type: 'string' } } };
    expect(validate(open, { id: 'x', extra: 1 }).ok).toBe(true);
  });
});

describe('scripts/lib/json-schema-subset.mjs — enum and const', () => {
  it('rejects a value outside a declared enum', async () => {
    const validate = await loadValidate();
    const schema = { type: 'string', enum: ['ok', 'warn', 'fail'] };
    expect(validate(schema, 'warn').ok).toBe(true);
    expect(validate(schema, 'unknown').ok).toBe(false);
  });

  it('rejects a value that is not the exact const, without coercion', async () => {
    const validate = await loadValidate();
    expect(validate({ const: 1 }, 1).ok).toBe(true);
    expect(validate({ const: 1 }, '1').ok).toBe(false);
    expect(validate({ const: 1 }, 2).ok).toBe(false);
  });
});

describe('scripts/lib/json-schema-subset.mjs — items and pattern', () => {
  it('validates every array element against items, not merely the array itself', async () => {
    const validate = await loadValidate();
    const schema = { type: 'array', items: { type: 'string' } };
    expect(validate(schema, ['a', 'b']).ok).toBe(true);
    expect(validate(schema, ['a', 1]).ok).toBe(false);
    expect(validate(schema, []).ok).toBe(true);
  });

  it('rejects a string that does not match pattern', async () => {
    const validate = await loadValidate();
    const schema = { type: 'string', pattern: '^\\d+\\.\\d+$' };
    expect(validate(schema, '1.0').ok).toBe(true);
    expect(validate(schema, 'v1').ok).toBe(false);
  });
});

describe('scripts/lib/json-schema-subset.mjs — nested paths in error messages', () => {
  const doctorLikeSchema = {
    type: 'object',
    required: ['checks'],
    properties: {
      checks: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'status', 'detail', 'fix'],
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: ['ok', 'warn', 'fail'] },
            detail: { type: 'string' },
            fix: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  };

  it('names the JSON path of a missing nested field, not just "invalid"', async () => {
    const validate = await loadValidate();
    const result = validate(doctorLikeSchema, {
      checks: [{ id: 'x', status: 'ok', detail: 'fine' }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('checks[0].fix'))).toBe(true);
  });

  it('names the JSON path of a nested type mismatch', async () => {
    const validate = await loadValidate();
    const result = validate(doctorLikeSchema, {
      checks: [{ id: 'x', status: 'ok', detail: 'fine', fix: 7 }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('checks[0].fix'))).toBe(true);
  });
});

describe('scripts/lib/json-schema-subset.mjs — minLength and boolean, the keywords the contract schemas lean on', () => {
  it('rejects a string shorter than minLength, so an empty name cannot pass a handshake', async () => {
    const validate = await loadValidate();
    const schema = { type: 'string', minLength: 1 };
    expect(validate(schema, 'memory').ok).toBe(true);
    expect(validate(schema, '').ok).toBe(false);
    expect(validate({ type: 'string', minLength: 3 }, 'ab').ok).toBe(false);
    expect(validate({ type: 'string', minLength: 3 }, 'abc').ok).toBe(true);
  });

  it('accepts true and false for type: boolean and rejects a string or a number', async () => {
    const validate = await loadValidate();
    expect(validate({ type: 'boolean' }, true).ok).toBe(true);
    expect(validate({ type: 'boolean' }, false).ok).toBe(true);
    expect(validate({ type: 'boolean' }, 'true').ok).toBe(false);
    expect(validate({ type: 'boolean' }, 0).ok).toBe(false);
  });
});

describe('scripts/lib/json-schema-subset.mjs — bounded by the schema', () => {
  it('walks the schema, not the value — a payload nested far deeper than the schema is judged without recursing into it', async () => {
    const validate = await loadValidate();
    let deep: unknown = 'leaf';
    for (let level = 0; level < 20_000; level += 1) deep = { child: deep };
    const shallow = {
      type: 'object',
      required: ['child'],
      properties: { child: { type: 'object' } },
    };
    expect(validate(shallow, deep)).toEqual({ ok: true, errors: [] });
    const deepArray = { type: 'array', items: { type: 'object' } };
    expect(validate(deepArray, [deep, deep]).ok).toBe(true);
  });
});

describe('scripts/lib/json-schema-subset.mjs — the subset is closed', () => {
  it('throws on a schema keyword outside the documented subset', async () => {
    const validate = await loadValidate();
    expect(() => validate({ oneOf: [{ type: 'string' }] }, 'x')).toThrow();
    expect(() => validate({ $ref: '#/$defs/Foo' }, {})).toThrow();
    expect(() => validate({ type: 'object', if: {}, then: {} }, {})).toThrow();
  });
});
