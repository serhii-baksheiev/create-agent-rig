import { describe, expect, it } from 'vitest';
import { detectCollisions } from '../src/lib/composition.js';

describe('detectCollisions', () => {
  it('returns nothing when layers claim disjoint paths', () => {
    expect(
      detectCollisions(
        [
          { name: 'skeleton', files: ['package.json', 'src/a.ts'] },
          { name: 'universal', files: ['CLAUDE.md', '.claude/settings.json'] },
        ],
        new Set(),
      ),
    ).toEqual([]);
  });

  it('reports a path claimed by two layers, naming both', () => {
    const collisions = detectCollisions(
      [
        { name: 'universal', files: ['.claude/rules/workflow.md'] },
        { name: 'stack/node-ts', files: ['.claude/rules/workflow.md'] },
      ],
      new Set(),
    );
    expect(collisions).toEqual([
      { path: '.claude/rules/workflow.md', layers: ['universal', 'stack/node-ts'] },
    ]);
  });

  it('lets an explicitly allowed overwrite through', () => {
    const collisions = detectCollisions(
      [
        { name: 'skeleton', files: ['README.md'] },
        { name: 'universal', files: ['README.md'] },
      ],
      new Set(['README.md']),
    );
    expect(collisions).toEqual([]);
  });

  it('reports three-way collisions once, with every claimant', () => {
    const collisions = detectCollisions(
      [
        { name: 'a', files: ['x'] },
        { name: 'b', files: ['x'] },
        { name: 'c', files: ['x'] },
      ],
      new Set(),
    );
    expect(collisions).toEqual([{ path: 'x', layers: ['a', 'b', 'c'] }]);
  });
});
