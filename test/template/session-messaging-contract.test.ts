import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const docsDir = path.join(repoRoot, 'docs');
const PUBLIC_TYPES = [
  'SessionIdentity',
  'Envelope',
  'DeliveryIntent',
  'DeliveryClass',
  'SessionCapabilities',
  'DeliveryReceipt',
  'ProbeResult',
] as const;

type Contract = { file: string; content: string; publicTypes: string };
type Requirement = readonly [description: string, pattern: RegExp];

const expectTerms = (content: string, terms: readonly Requirement[]) => {
  for (const [description, pattern] of terms) expect(content, description).toMatch(pattern);
};

const section = (content: string, heading: RegExp): string => {
  const lines = content.split('\n');
  const start = lines.findIndex((line) => heading.test(line));
  expect(start, `missing Markdown section matching ${heading}`).toBeGreaterThan(-1);
  const level = /^(#+)/.exec(lines[start]!)?.[1]?.length ?? 0;
  const end = lines.findIndex((line, index) => {
    const next = /^(#+)\s+/.exec(line)?.[1]?.length;
    return index > start && next !== undefined && next <= level;
  });
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
};

async function loadContract(): Promise<Contract> {
  const files = (await readdir(docsDir)).filter((name) => name.endsWith('.md'));
  const markdown = await Promise.all(
    files.map(async (name) => ({
      file: path.join(docsDir, name),
      content: await readFile(path.join(docsDir, name), 'utf8'),
    })),
  );
  const candidates = markdown.filter(({ content }) =>
    PUBLIC_TYPES.every((type) => content.includes(type)),
  );
  expect(
    candidates.map(({ file }) => path.relative(repoRoot, file)),
    'exactly one canonical Contract v0 Markdown must define every public type under docs/',
  ).toHaveLength(1);
  const contract = candidates[0]!;
  return {
    ...contract,
    publicTypes: section(contract.content, /^#{2,6}\s+.*Contract v0 types\b/i),
  };
}

describe('the canonical session messaging Contract v0', () => {
  it('is one English Markdown document with every required public type', async () => {
    const contract = await loadContract();
    expect(contract.file).toMatch(/\.md$/);
    expect(contract.content).toMatch(/^#\s+.*Contract v0/im);
    expect(contract.content, 'the English document contains Cyrillic text').not.toMatch(
      /[А-Яа-яЁё]/,
    );
    expectTerms(
      contract.publicTypes,
      PUBLIC_TYPES.map((type) => [
        `${type} is absent from the public type boundary`,
        new RegExp(`\\b${type}\\b`),
      ]),
    );
  });

  it('keeps sender identity authoritative at the transport and public types transport-neutral', async () => {
    const { content, publicTypes } = await loadContract();
    expectTerms(content, [
      [
        'SessionIdentity is not defined per concrete instance',
        /SessionIdentity[\s\S]{0,500}\b(instance|per-instance)\b/i,
      ],
      [
        'sender identity is not bound to an authenticated transport principal',
        /authenticated[\s-]+transport[\s\S]{0,180}\b(principal|identity)\b|\b(principal|identity)\b[\s\S]{0,180}authenticated[\s-]+transport/i,
      ],
      [
        'self-asserted payload identity is not explicitly non-authoritative',
        /\b(descriptive|self-asserted)\b[\s\S]{0,180}\b(not authoritative|never authoritative|not trusted)\b/i,
      ],
      [
        'NATS is not identified as the MVP transport',
        /NATS[\s\S]{0,100}\bMVP transport\b|\bMVP transport\b[\s\S]{0,100}NATS/i,
      ],
      [
        'transport subjects are not derived by adapters or runtime',
        /subjects?[\s\S]{0,160}\b(derived|adapter|runtime)\b|\b(derived|adapter|runtime)\b[\s\S]{0,160}subjects?/i,
      ],
    ]);
    expect(publicTypes, 'transport or harness details leaked into public types').not.toMatch(
      /\b(NATS|Claude|Codex|hooks?|channel|thread\/inject_items|turn\/(?:start|steer))\b/i,
    );
    expect(publicTypes, 'a public type declares trust or transport subject as a field').not.toMatch(
      /(?:^|\n)\s*(?:[-*]\s*)?(?:\|\s*)?[`"']?(?:readonly\s+)?(?:trust|subject)[`"']?\??\s*(?::|\|)/im,
    );
  });

  it('keeps delivery intent orthogonal to mechanism and receipts truthful', async () => {
    const { content, publicTypes } = await loadContract();
    const values = [
      'notify',
      'wake',
      'PUSH',
      'TURN_BOUNDARY',
      'POLL',
      'OFFLINE',
      'accepted',
      'routed',
      'surfaced',
      'handled',
      'declined',
    ];
    expectTerms(
      publicTypes,
      values.map((value) => [`public types omit ${value}`, new RegExp(`\\b${value}\\b`, 'i')]),
    );
    expectTerms(content, [
      [
        'DeliveryIntent and DeliveryClass are not explicitly orthogonal',
        /DeliveryIntent[\s\S]{0,220}\b(orthogonal|independent)\b[\s\S]{0,220}DeliveryClass|DeliveryClass[\s\S]{0,220}\b(orthogonal|independent)\b[\s\S]{0,220}DeliveryIntent/i,
      ],
      [
        'declined is not a terminal alternative to the receipt progression',
        /\bdeclined\b[\s\S]{0,140}\bterminal\b|\bterminal\b[\s\S]{0,140}\bdeclined\b/i,
      ],
      [
        'handled is not tied to an explicit bus-visible reaction',
        /\bhandled\b[\s\S]{0,220}\b(reply|ack|decline|explicit reaction|bus-visible)\b/i,
      ],
      [
        'the contract does not forbid inferred model read or cognition',
        /\b(model-read|model read|model cognition|cognition)\b[\s\S]{0,140}\b(never|not inferred|must not infer)\b|\b(never|not inferred|must not infer)\b[\s\S]{0,140}\b(model-read|model read|model cognition|cognition)\b/i,
      ],
    ]);
  });

  it('makes wake receiver-authorized with visible downgrade, decline and safe admission', async () => {
    const { content } = await loadContract();
    expectTerms(content, [
      [
        'wake is not receiver-authorized',
        /\bwake\b[\s\S]{0,140}\breceiver[- ]authorized\b|\breceiver[- ]authorized\b[\s\S]{0,140}\bwake\b/i,
      ],
      [
        'reply wake does not bind to an open request correlationId',
        /\bcorrelationId\b[\s\S]{0,180}\b(open request|receiver-originated|reply)\b|\b(open request|receiver-originated|reply)\b[\s\S]{0,180}\bcorrelationId\b/i,
      ],
      [
        'allowlisted engineers or principals are not named as the other authorization route',
        /\ballowlist(ed)?\b[\s\S]{0,120}\b(engineer|principal)\b|\b(engineer|principal)\b[\s\S]{0,120}\ballowlist(ed)?\b/i,
      ],
      [
        'wake-to-notify downgrade does not preserve requested and effective intent',
        /requestedIntent[\s\S]{0,180}effectiveIntent|effectiveIntent[\s\S]{0,180}requestedIntent/,
      ],
      [
        'a fully forbidden message does not terminate declined with a reason',
        /\bforbidden\b[\s\S]{0,180}\bdeclined\b[\s\S]{0,120}\breason\b|\bdeclined\b[\s\S]{0,180}\bforbidden\b/i,
      ],
      [
        'uncertain idle admission does not downgrade to notify',
        /\b(uncertain|cannot atomically|not atomically)\b[\s\S]{0,220}\bidle\b[\s\S]{0,220}\b(downgrade|notify)\b/i,
      ],
      [
        'busy steer is not conditional on a safe active-turn primitive',
        /\bbusy\b[\s\S]{0,220}\bsteer\b[\s\S]{0,220}\b(safe|active-turn primitive)\b/i,
      ],
    ]);
  });

  it('scopes observed capabilities and forbids periodic synthetic probes', async () => {
    const { content, publicTypes } = await loadContract();
    expectTerms(publicTypes, [
      ...(['verifiedAt', 'verifiedBy', 'lastAckAt'] as const).map(
        (field) => [`SessionCapabilities omits ${field}`, new RegExp(`\\b${field}\\b`)] as const,
      ),
      [
        'verifiedBy does not distinguish probe from traffic',
        /\bprobe\b[\s\S]{0,100}\btraffic\b|\btraffic\b[\s\S]{0,100}\bprobe\b/i,
      ],
      [
        'capability state does not distinguish verified, degraded and unverified',
        /\bverified\b[\s\S]{0,160}\bdegraded\b[\s\S]{0,160}\bunverified\b|\bunverified\b[\s\S]{0,160}\bdegraded\b[\s\S]{0,160}\bverified\b/i,
      ],
      [
        'capabilities do not count consecutive expected-observation failures',
        /consecutive[\s\S]{0,120}(expected[- ]observation|failure)/i,
      ],
    ]);
    expectTerms(content, [
      [
        'capabilities are not runtime-observed per session instance',
        /\bruntime[- ]observed\b[\s\S]{0,220}\bsession instance\b|\bsession instance\b[\s\S]{0,220}\bruntime[- ]observed\b/i,
      ],
      [
        'evidence does not name harness surface, version, OS and observation date',
        /harness surface[\s\S]{0,180}\bversion\b[\s\S]{0,180}\bOS\b[\s\S]{0,180}\b(observation|observed) date\b/i,
      ],
      [
        'active probing is not limited to registration and reconnect',
        /\b(active probe|probing)\b[\s\S]{0,180}\bregistration\b[\s\S]{0,120}\breconnect\b/i,
      ],
      [
        'periodic synthetic probes are not explicitly forbidden',
        /\bperiodic synthetic (?:re-)?probes?\b[\s\S]{0,120}\b(forbidden|prohibited|must not|never)\b|\b(forbidden|prohibited|must not|never)\b[\s\S]{0,120}\bperiodic synthetic (?:re-)?probes?\b/i,
      ],
      [
        'post-registration verification is not passive and based on real traffic',
        /\bpassive\b[\s\S]{0,180}\breal traffic\b|\breal traffic\b[\s\S]{0,180}\bpassive\b/i,
      ],
      [
        'absence of traffic is not explicitly excluded as a failure',
        /\babsence of traffic\b[\s\S]{0,140}\b(never|not a failure|must not)\b|\b(never|not a failure|must not)\b[\s\S]{0,140}\babsence of traffic\b/i,
      ],
    ]);
  });

  it('keeps attached and managed harness details optional and outside public types', async () => {
    const { content, publicTypes } = await loadContract();
    expectTerms(content, [
      [
        'attached Claude baseline notify does not use turn-boundary hooks',
        /Claude attached[\s\S]{0,180}\b(hooks?|TURN_BOUNDARY)\b/i,
      ],
      [
        'Claude channel wake is not optional and traffic/ack verified',
        /Claude channel[\s\S]{0,220}\b(optional|candidate)\b[\s\S]{0,220}\b(traffic|ack)\b/i,
      ],
      [
        'attached ordinary Codex does not stay at notify or turn-boundary best effort',
        /Codex attached[\s\S]{0,220}\b(notify|TURN_BOUNDARY|best-effort)\b/i,
      ],
      [
        'managed Codex notify does not use thread/inject_items',
        /Codex managed[\s\S]{0,220}thread\/inject_items/i,
      ],
      [
        'managed Codex wake does not distinguish idle start from busy steer',
        /turn\/start[\s\S]{0,220}\bidle\b[\s\S]{0,220}turn\/steer[\s\S]{0,220}\bbusy\b|\bidle\b[\s\S]{0,220}turn\/start[\s\S]{0,220}\bbusy\b[\s\S]{0,220}turn\/steer/i,
      ],
      ['the non-enterprise-first constraint is missing', /\bnon-enterprise-first\b/i],
      [
        'local/self-hosted/public-subscription use is not a complete first-class path',
        /\b(local|self-hosted|public subscription|public-subscription)\b[\s\S]{0,260}\b(local|self-hosted|public subscription|public-subscription)\b[\s\S]{0,260}\b(first-class|complete)\b/i,
      ],
      [
        'enterprise capabilities are not optional upgrades or enhancements',
        /\benterprise[\s-]+(?:managed )?(?:capabilities|integrations|features)\b[\s\S]{0,220}\boptional\b[\s\S]{0,160}\b(upgrade|enhancement|not (?:a )?prerequisite)\b/i,
      ],
    ]);
    expect(publicTypes, 'attached/managed vendor integration leaked into public types').not.toMatch(
      /\b(attached|managed|app-server|remote path)\b/i,
    );
  });
});
