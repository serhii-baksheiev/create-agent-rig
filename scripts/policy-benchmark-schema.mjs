import { createRequire } from 'node:module';

const requireFromHere = createRequire(import.meta.url);
const typescript = requireFromHere('typescript');

const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_AST_NODES = 50_000;
const MAX_VALUE_DEPTH = 100;
const MAX_ALLOCATED_MEMBERS = 50_000;
const MAX_SEMANTIC_VALUE_NODES = 50_000;

const fail = (message) => {
  throw new Error(`session schema must be inert: ${message}`);
};

const propertyName = (name) => {
  if (
    typescript.isIdentifier(name) ||
    typescript.isStringLiteral(name) ||
    typescript.isNumericLiteral(name)
  )
    return name.text;
  fail('computed property keys are not allowed');
};

const isConstAssertion = (node, source) =>
  source.text.slice(node.type.getStart(source), node.type.end).trim() === 'const';

const countNodes = (source) => {
  let count = 0;
  const pending = [[source, 0]];
  while (pending.length > 0) {
    const [node, depth] = pending.pop();
    count += 1;
    if (count > MAX_AST_NODES) fail('node budget exceeded');
    if (depth > MAX_VALUE_DEPTH * 4) fail('syntax depth exceeded');
    const children = [];
    typescript.forEachChild(node, (child) => children.push(child));
    for (const child of children) pending.push([child, depth + 1]);
  }
};

const define = (object, key, value) => {
  if (Object.hasOwn(object, key)) fail(`duplicate property ${JSON.stringify(key)}`);
  Object.defineProperty(object, key, {
    configurable: false,
    enumerable: true,
    value,
    writable: false,
  });
};

const parseSource = (sourceText) => {
  if (typeof sourceText !== 'string') fail('source must be text');
  if (Buffer.byteLength(sourceText, 'utf8') > MAX_SOURCE_BYTES) fail('source is too large');
  const source = typescript.createSourceFile(
    'schema.ts',
    sourceText,
    typescript.ScriptTarget.ES2022,
    true,
    typescript.ScriptKind.TS,
  );
  if (source.parseDiagnostics.length > 0) fail('source has syntax errors');
  countNodes(source);
  return source;
};

const hasExportModifier = (statement) =>
  typescript
    .getModifiers(statement)
    ?.some((modifier) => modifier.kind === typescript.SyntaxKind.ExportKeyword) ?? false;

const assertSemanticValueBudget = (value) => {
  let count = 0;
  const pending = [[value, 0]];
  while (pending.length > 0) {
    const [next, depth] = pending.pop();
    count += 1;
    if (count > MAX_SEMANTIC_VALUE_NODES) fail('semantic value-node budget exceeded');
    if (depth > MAX_VALUE_DEPTH) fail('semantic value depth exceeded');
    if (Array.isArray(next)) {
      for (const item of next) pending.push([item, depth + 1]);
    } else if (next !== null && typeof next === 'object') {
      for (const key of Object.keys(next)) pending.push([next[key], depth + 1]);
    }
  }
};

export const parseSessionSchema = (sourceText) => {
  const source = parseSource(sourceText);

  const values = new Map();
  let allocatedMembers = 0;
  const reserveMembers = (count) => {
    if (count > MAX_ALLOCATED_MEMBERS - allocatedMembers) fail('allocation member budget exceeded');
    allocatedMembers += count;
  };
  const evaluate = (node, depth = 0) => {
    if (depth > MAX_VALUE_DEPTH) fail('value depth exceeded');
    if (typescript.isParenthesizedExpression(node)) return evaluate(node.expression, depth + 1);
    if (typescript.isAsExpression(node)) {
      if (!isConstAssertion(node, source)) fail('only as const assertions are allowed');
      return evaluate(node.expression, depth + 1);
    }
    if (typescript.isSatisfiesExpression?.(node)) fail('satisfies expressions are not allowed');
    if (typescript.isStringLiteral(node) || typescript.isNoSubstitutionTemplateLiteral(node))
      return node.text;
    if (typescript.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === typescript.SyntaxKind.TrueKeyword) return true;
    if (node.kind === typescript.SyntaxKind.FalseKeyword) return false;
    if (node.kind === typescript.SyntaxKind.NullKeyword) return null;
    if (typescript.isPrefixUnaryExpression(node)) {
      if (
        (node.operator === typescript.SyntaxKind.MinusToken ||
          node.operator === typescript.SyntaxKind.PlusToken) &&
        typescript.isNumericLiteral(node.operand)
      )
        return node.operator === typescript.SyntaxKind.MinusToken
          ? -Number(node.operand.text)
          : Number(node.operand.text);
      fail('only signed numeric literals are allowed');
    }
    if (typescript.isIdentifier(node)) {
      if (!values.has(node.text)) fail(`reference ${node.text} must name an earlier const`);
      return values.get(node.text);
    }
    if (typescript.isArrayLiteralExpression(node)) {
      const result = [];
      for (const element of node.elements) {
        if (typescript.isOmittedExpression(element)) fail('array holes are not allowed');
        if (typescript.isSpreadElement(element)) {
          const spread = evaluate(element.expression, depth + 1);
          if (!Array.isArray(spread)) fail('array spreads must reference arrays');
          reserveMembers(spread.length);
          result.push(...spread);
        } else {
          const value = evaluate(element, depth + 1);
          reserveMembers(1);
          result.push(value);
        }
      }
      return result;
    }
    if (typescript.isObjectLiteralExpression(node)) {
      const result = Object.create(null);
      for (const member of node.properties) {
        if (typescript.isSpreadAssignment(member)) {
          if (!typescript.isIdentifier(member.expression))
            fail('object spreads must reference earlier consts');
          const spread = evaluate(member.expression, depth + 1);
          if (spread === null || typeof spread !== 'object' || Array.isArray(spread))
            fail('object spreads must reference objects');
          const keys = Object.keys(spread);
          reserveMembers(keys.length);
          for (const key of keys) define(result, key, spread[key]);
        } else if (typescript.isPropertyAssignment(member)) {
          const value = evaluate(member.initializer, depth + 1);
          reserveMembers(1);
          define(result, propertyName(member.name), value);
        } else fail('object methods, accessors, and shorthand properties are not allowed');
      }
      return result;
    }
    fail(`expression ${typescript.SyntaxKind[node.kind]} is not allowed`);
  };

  let schema;
  let schemaIsExported = false;
  for (const statement of source.statements) {
    if (
      typescript.isInterfaceDeclaration(statement) ||
      typescript.isTypeAliasDeclaration(statement)
    )
      continue;
    if (!typescript.isVariableStatement(statement)) fail('top-level statement is not allowed');
    if ((statement.declarationList.flags & typescript.NodeFlags.Const) === 0)
      fail('top-level declarations must be const');
    for (const declaration of statement.declarationList.declarations) {
      if (!typescript.isIdentifier(declaration.name) || declaration.initializer === undefined)
        fail('const declarations must have identifier names and initializers');
      const value = evaluate(declaration.initializer);
      if (values.has(declaration.name.text)) fail(`duplicate const ${declaration.name.text}`);
      values.set(declaration.name.text, value);
      if (declaration.name.text === 'sessionMessagingSchema') {
        schema = value;
        schemaIsExported = hasExportModifier(statement);
      }
    }
  }
  if (schema === undefined) fail('missing exported sessionMessagingSchema const');
  if (!schemaIsExported) fail('sessionMessagingSchema must be exported');
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema))
    fail('sessionMessagingSchema must be an object literal');
  assertSemanticValueBudget(schema);
  return schema;
};

export const parseFlagBasename = (sourceText) => {
  const source = parseSource(sourceText);
  const matches = [];
  for (const statement of source.statements) {
    if (!typescript.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations)
      if (typescript.isIdentifier(declaration.name) && declaration.name.text === 'FLAG_BASENAME')
        matches.push({ declaration, statement });
  }
  if (matches.length !== 1) fail('flag basename requires exactly one exported const');
  const [{ declaration, statement }] = matches;
  if (
    (statement.declarationList.flags & typescript.NodeFlags.Const) === 0 ||
    !hasExportModifier(statement) ||
    declaration.initializer === undefined ||
    !typescript.isStringLiteral(declaration.initializer)
  )
    fail('flag basename must be an exported string literal const');
  const value = declaration.initializer.text;
  if (!/^[A-Za-z0-9_-]{1,128}-loop-UNATTENDED$/.test(value))
    fail('flag basename is not a safe literal');
  return value;
};
