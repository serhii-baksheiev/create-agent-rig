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
    // RP-313 adds `playwright-mcp` (Playwright MCP, routed `automatic` for
    // both harnesses) grouped with the other plain MCP providers, ahead of
    // `probity` which is neither an MCP server nor upstream-managed.
    // RP-315 adds `bmad-tea` (BMAD Method's Test Architecture Enterprise
    // module) after `probity` — an advisory evidence provider, like Probity,
    // that Rig never installs and never wires into any harness's MCP config.
    expect(REGISTRY.map((x) => x.id)).toEqual([
      'basic-memory',
      'spec-kit',
      'figma-mcp',
      'atlassian-mcp',
      'playwright-mcp',
      'probity',
      'bmad-tea',
    ]));
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
  // RP-416: Probity's declaration entry carries a `configHash` of the Rig-
  // generated `probity.config.mjs` bytes, the same ownership shape every
  // other provider's `targets.*.entryHash` already uses — a well-formed one
  // round-trips through serializeDeclaration, and a malformed one is
  // rejected the same way a malformed version string already is.
  it('accepts a well-formed probity configHash and keeps it through serializeDeclaration, but rejects a malformed one as malformed', () => {
    const configHash = 'a'.repeat(64);
    const accepted = parseDeclaration(
      JSON.stringify({
        schemaVersion: 1,
        integrations: [
          {
            id: 'probity',
            version: '1.10.1',
            harnesses: ['claude-code'],
            selected: true,
            configHash,
          },
        ],
      }),
      REGISTRY,
    );
    expect(accepted).toMatchObject({
      status: 'ok',
      rejected: [],
      entries: [
        {
          id: 'probity',
          version: '1.10.1',
          harnesses: ['claude-code'],
          configHash,
        },
      ],
    });
    expect(
      parseDeclaration(
        serializeDeclaration(accepted.status === 'ok' ? accepted.entries : []),
        REGISTRY,
      ),
    ).toMatchObject({
      status: 'ok',
      entries: [{ id: 'probity', configHash }],
    });

    expect(
      parseDeclaration(
        JSON.stringify({
          schemaVersion: 1,
          integrations: [
            {
              id: 'probity',
              version: '1.10.1',
              harnesses: ['claude-code'],
              selected: true,
              configHash: 'not-sixty-four-hex-characters',
            },
          ],
        }),
        REGISTRY,
      ),
    ).toMatchObject({
      status: 'ok',
      entries: [],
      rejected: [{ id: 'probity', reason: 'malformed' }],
    });
  });
  // RP-445: a repository may declare a different exact version of a pinned
  // provider, never a range or a tag — the doctor compares installed bytes
  // against one exact version, and a range names none.
  it('rejects a range or tag as the declared version of a pinned provider as malformed, accepts an exact one, and leaves unpinned providers alone', () => {
    const declare = (id: string, version: string) =>
      parseDeclaration(
        JSON.stringify({ schemaVersion: 1, integrations: [{ id, version, selected: true }] }),
        REGISTRY,
      );
    for (const id of ['probity', 'playwright-mcp', 'spec-kit', 'bmad-tea']) {
      for (const version of ['latest', '1.x', '^1.2.3', '~1.2.3', 'v1.2.3', '1.2', '01.2.3'])
        expect(declare(id, version), `${id}@${version}`).toMatchObject({
          status: 'ok',
          entries: [],
          rejected: [{ id, reason: 'malformed' }],
        });
      for (const version of ['1.2.3', '0.0.83', '2.0.0-rc.1'])
        expect(declare(id, version), `${id}@${version}`).toMatchObject({
          status: 'ok',
          rejected: [],
          entries: [{ id, version }],
        });
    }
    expect(declare('figma-mcp', 'latest')).toMatchObject({
      status: 'ok',
      rejected: [],
      entries: [{ id: 'figma-mcp', version: 'latest' }],
    });
  });
});
