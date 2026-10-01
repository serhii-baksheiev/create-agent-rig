import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const queueDir = path.join(
  repoRoot,
  'templates',
  'agent-os',
  'universal',
  '.claude',
  'scripts',
  'queue',
);
const load = (file: string) => import(pathToFileURL(path.join(queueDir, file)).href);

it('preserves frozen and later markers through parsePlan to truthful deferred selection', async () => {
  const { parsePlan } = await load('plan-md.mjs');
  const { selectionOf } = await load('core.mjs');
  const [frozen, later, parked] = parsePlan(
    '# Plan\n\n## Agent queue\n\n- Freeze it [frozen]\n- Do it later [later]\n- Park it [parked]\n',
  );

  expect(frozen.labels).toEqual(['frozen']);
  expect(later.labels).toEqual(['later']);
  expect(parked.labels).toEqual(['parked']);
  expect(frozen.title).toBe('Freeze it');
  expect(later.title).toBe('Do it later');

  for (const item of [frozen, later]) {
    const selection = selectionOf(item);
    expect(selection.eligible).toBe(false);
    expect(selection.causes).toEqual(['deferred']);
    expect(selection.reasons.join(' ')).toContain(`${item.labels[0]} (deferred)`);
    expect(selection.reasons.join(' ')).not.toMatch(/human|un-?park/i);
  }

  const parkedSelection = selectionOf(parked);
  expect(parkedSelection.reasons.join(' ')).toMatch(/parked.*human.*un-?park/i);
});
