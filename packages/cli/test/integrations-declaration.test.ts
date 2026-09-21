import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_DECLARATION_BYTES,
  parseDeclaration,
  serializeDeclaration,
} from '../src/integrations/declaration.js';
import { REGISTRY } from '../src/integrations/registry.js';

const h = createHash('sha256')
  .update(JSON.stringify({ type: 'http', url: 'https://mcp.figma.com/mcp' }))
  .digest('hex');
describe('integration intent declaration', () => {
  it('has only the implemented release providers', () =>
    expect(REGISTRY.map((x) => x.id)).toEqual(['spec-kit', 'figma-mcp', 'atlassian-mcp']));
  it('round trips only finite intent and target hash fields', () =>
    expect(
      parseDeclaration(
        serializeDeclaration([
          {
            id: 'figma-mcp',
            selected: true,
            harnesses: ['claude-code'],
            targets: { 'claude-code': { entryHash: h } },
          },
        ]),
        REGISTRY,
      ),
    ).toMatchObject({
      status: 'ok',
      entries: [{ id: 'figma-mcp', targets: { 'claude-code': { entryHash: h } } }],
    }));
  it('refuses a Codex entry hash until a Codex target is part of this declaration slice', () =>
    expect(
      parseDeclaration(
        JSON.stringify({
          schemaVersion: 1,
          integrations: [
            {
              id: 'figma-mcp',
              selected: true,
              harnesses: ['codex'],
              targets: { codex: { entryHash: h } },
            },
          ],
        }),
        REGISTRY,
      ),
    ).toMatchObject({
      status: 'ok',
      entries: [],
      rejected: [{ id: 'figma-mcp', reason: 'arbitrary-command-refused' }],
    }));
  it('preserves an explicit required false through serialization and parsing', () =>
    expect(
      parseDeclaration(
        serializeDeclaration([
          {
            id: 'figma-mcp',
            required: false,
            selected: true,
            harnesses: ['claude-code'],
          },
        ]),
        REGISTRY,
      ),
    ).toMatchObject({
      status: 'ok',
      entries: [{ id: 'figma-mcp', required: false }],
    }));
  it('refuses command-shaped targets and hostile bounded input', () => {
    expect(
      parseDeclaration(
        JSON.stringify({
          schemaVersion: 1,
          integrations: [
            {
              id: 'figma-mcp',
              selected: true,
              targets: { 'claude-code': { entryHash: h, command: 'curl' } },
            },
          ],
        }),
        REGISTRY,
      ),
    ).toMatchObject({ status: 'ok', rejected: [{ reason: 'arbitrary-command-refused' }] });
    expect(parseDeclaration('x'.repeat(MAX_DECLARATION_BYTES + 1), REGISTRY)).toMatchObject({
      status: 'invalid',
    });
    expect(
      parseDeclaration(
        '{"schemaVersion":1,"integrations":[{"id":"figma-mcp\\u001b","selected":true}]}',
        REGISTRY,
      ),
    ).toMatchObject({ status: 'invalid' });
  });
});
