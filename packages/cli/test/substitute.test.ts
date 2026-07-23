import { describe, expect, it } from 'vitest';
import { substituteContent, substituteFileName } from '../src/lib/substitute.js';

const ctx = {
  projectName: 'my-app',
  projectScope: 'my-app',
  region: 'eu-central-1',
};

describe('substituteContent', () => {
  it('replaces __PROJECT_NAME__ everywhere', () => {
    expect(substituteContent('# __PROJECT_NAME__\n__PROJECT_NAME__!', ctx)).toBe(
      '# my-app\nmy-app!',
    );
  });

  it('replaces __PROJECT_SCOPE__ and __REGION__', () => {
    expect(substituteContent('scope=__PROJECT_SCOPE__ region=__REGION__', ctx)).toBe(
      'scope=my-app region=eu-central-1',
    );
  });

  it('rewrites the @app/ placeholder scope to the project scope', () => {
    expect(substituteContent('import { x } from "@app/core";', ctx)).toBe(
      'import { x } from "@my-app/core";',
    );
    expect(substituteContent('"name": "@app/db"', ctx)).toBe('"name": "@my-app/db"');
  });

  it('leaves unrelated content untouched', () => {
    const content = 'const app = "app"; // @application/other';
    expect(substituteContent(content, ctx)).toBe(content);
  });
});

describe('substituteFileName', () => {
  it('replaces tokens in file names', () => {
    expect(substituteFileName('__PROJECT_NAME__.config.ts', ctx)).toBe('my-app.config.ts');
  });

  it('leaves plain names untouched', () => {
    expect(substituteFileName('package.json', ctx)).toBe('package.json');
  });
});
