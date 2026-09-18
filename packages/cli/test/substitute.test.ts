import { describe, expect, it } from 'vitest';
import * as substitutions from '../src/lib/substitute.js';
import { substituteContent } from '../src/lib/substitute.js';

const ctx = {
  projectName: 'my-app',
};

describe('substituteContent', () => {
  it('replaces __PROJECT_NAME__ everywhere', () => {
    expect(substituteContent('# __PROJECT_NAME__\n__PROJECT_NAME__!', ctx)).toBe(
      '# my-app\nmy-app!',
    );
  });

  it('supports only __PROJECT_NAME__', () => {
    expect(
      substituteContent(
        'name=__PROJECT_NAME__ scope=__PROJECT_SCOPE__ region=__REGION__ @app/core',
        ctx,
      ),
    ).toBe('name=my-app scope=__PROJECT_SCOPE__ region=__REGION__ @app/core');
  });

  it('leaves opaque non-token text untouched for byte-level ownership checks', () => {
    const opaqueText = '\u0000\u00ff\u2066not a path\u2069';

    expect(substituteContent(opaqueText, ctx)).toBe(opaqueText);
  });

  it('does not expose obsolete filename substitution or reverse-tokenization', () => {
    expect(substitutions).not.toHaveProperty('substituteFileName');
    expect(substitutions).not.toHaveProperty('detokenizeContent');
  });

  it('leaves unrelated content untouched', () => {
    const content = 'const app = "app"; // @application/other';
    expect(substituteContent(content, ctx)).toBe(content);
  });
});
