import { isPlainObject } from '../lib/safe-text.js';

type Member = { key: string; start: number; valueStart: number; end: number; comma?: number };
type ObjectSpan = { start: number; members: Member[] };
type Config = Record<string, unknown> & { mcpServers: Record<string, unknown> };

const whitespace = (text: string, from: number): number => {
  while (' \t\r\n'.includes(text[from] ?? '\0')) from++;
  return from;
};
const stringEnd = (text: string, from: number): number => {
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i + 1;
  }
  throw new Error('mcp-config-invalid');
};

// JSON.parse validates the complete document first. This bounded, iterative
// walk only locates member spans; it never decodes or reserializes foreign values.
function valueEnd(text: string, from: number): number {
  if (text[from] === '"') return stringEnd(text, from);
  if (text[from] === '{' || text[from] === '[') {
    let depth = 0;
    for (let i = from; i < text.length; i++) {
      if (text[i] === '"') i = stringEnd(text, i) - 1;
      else if (text[i] === '{' || text[i] === '[') depth++;
      else if ((text[i] === '}' || text[i] === ']') && --depth === 0) return i + 1;
    }
    throw new Error('mcp-config-invalid');
  }
  let end = from;
  while (end < text.length && !' \t\r\n,}]'.includes(text[end]!)) end++;
  return end;
}

function objectSpan(text: string, start: number): ObjectSpan {
  const members: Member[] = [];
  const keys = new Set<string>();
  let offset = whitespace(text, start + 1);
  while (text[offset] !== '}') {
    const endOfKey = stringEnd(text, offset);
    const key = JSON.parse(text.slice(offset, endOfKey)) as string;
    if (keys.has(key)) throw new Error('mcp-config-ambiguous');
    keys.add(key);
    const valueStart = whitespace(text, whitespace(text, endOfKey) + 1);
    const end = valueEnd(text, valueStart);
    const separator = whitespace(text, end);
    const comma = text[separator] === ',' ? separator : undefined;
    members.push({
      key,
      start: offset,
      valueStart,
      end,
      ...(comma === undefined ? {} : { comma }),
    });
    offset = comma === undefined ? separator : whitespace(text, comma + 1);
  }
  return { start, members };
}

function document(text: string) {
  const value: unknown = JSON.parse(text);
  if (
    !isPlainObject(value) ||
    (Object.hasOwn(value, 'mcpServers') && !isPlainObject(value.mcpServers))
  )
    throw new Error('mcp-config-invalid');
  const root = objectSpan(text, whitespace(text, 0));
  const servers = root.members.find((member) => member.key === 'mcpServers');
  const serverSpan = servers === undefined ? undefined : objectSpan(text, servers.valueStart);
  return { config: { ...value, mcpServers: value.mcpServers ?? {} } as Config, root, serverSpan };
}

export function readMcpConfig(text: string): Config {
  return document(text).config;
}

function editMember(
  text: string,
  span: ObjectSpan,
  key: string,
  value: unknown | undefined,
): string {
  const index = span.members.findIndex((member) => member.key === key);
  const existing = span.members[index];
  if (existing !== undefined) {
    if (value !== undefined)
      return text.slice(0, existing.valueStart) + JSON.stringify(value) + text.slice(existing.end);
    const precedingComma = span.members[index - 1]?.comma;
    const start =
      existing.comma !== undefined || precedingComma === undefined
        ? existing.start
        : precedingComma;
    const end = existing.comma === undefined ? existing.end : existing.comma + 1;
    return text.slice(0, start) + text.slice(end);
  }
  if (value === undefined) return text;
  // Prepend only owned text. In particular, retain the original leading
  // whitespace before foreign members so removing this entry restores it.
  const inserted = `${JSON.stringify(key)}:${JSON.stringify(value)}${span.members.length ? ',' : ''}`;
  return text.slice(0, span.start + 1) + inserted + text.slice(span.start + 1);
}

export function editMcpServers(
  text: string,
  changes: ReadonlyMap<string, unknown | undefined>,
): string {
  for (const [key, value] of changes) {
    const parsed = document(text);
    text =
      parsed.serverSpan === undefined
        ? value === undefined
          ? text
          : editMember(text, parsed.root, 'mcpServers', { [key]: value })
        : editMember(text, parsed.serverSpan, key, value);
  }
  return text;
}
