import { App } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { AppStack, type AppStackProps } from '../lib/app-stack.js';

// Who may call the API is a security decision with exactly two safe outcomes:
// the right origins, or a refusal loud enough that somebody fixes it. An empty
// allow-list is neither — it synthesises, deploys, and blocks every call.

const buildAppStack = (options: { context?: Record<string, unknown>; props?: AppStackProps } = {}) =>
  new AppStack(new App({ context: options.context }), 'TestStack', options.props);

const originsOf = (options: Parameters<typeof buildAppStack>[0]): unknown[] => {
  const apis = Template.fromStack(buildAppStack(options)).findResources('AWS::ApiGatewayV2::Api');
  return Object.values(apis).flatMap(
    (api) =>
      (api.Properties as { CorsConfiguration?: { AllowOrigins?: unknown[] } }).CorsConfiguration
        ?.AllowOrigins ?? [],
  );
};

const thrownBy = (build: () => unknown): unknown => {
  try {
    build();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('choosing the allowed origins', () => {
  it('prefers the origins passed in props over the localhost default', () => {
    // The name claims a contrast, so both halves are pinned: what the default
    // IS when nothing is given, and that a prop displaces it.
    expect(originsOf({})).toEqual(['http://localhost:3000']);
    expect(originsOf({ props: { allowedOrigins: ['https://app.example.com'] } })).toEqual([
      'https://app.example.com',
    ]);
  });

  it('reads a comma-separated -c allowedOrigins as one origin each, trimmed', () => {
    expect(
      originsOf({ context: { allowedOrigins: ' https://a.example.com , https://b.example.com ' } }),
    ).toEqual(['https://a.example.com', 'https://b.example.com']);
  });
});

describe('an allow-list that names nobody is a broken deploy, not a default', () => {
  it('refuses a context value that parses to no origin at all', () => {
    // `-c allowedOrigins=" , , "` is a typo, and today it synthesises an API
    // with an empty allow-list: every browser call fails, and the only obvious
    // repair a hurried reader finds is putting `*` back.
    const error = thrownBy(() => buildAppStack({ context: { allowedOrigins: ' , , ' } }));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message, 'the message must name the flag that was wrong').toMatch(
      /allowedOrigins/,
    );
  });

  it('refuses an explicitly empty allowedOrigins prop for the same reason', () => {
    // `?? DEFAULT` does not catch `[]` — an empty array is not nullish, so it
    // travels all the way to CorsConfiguration.
    const error = thrownBy(() => buildAppStack({ props: { allowedOrigins: [] } }));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/allowedOrigins/);
  });

  it('refuses a non-string context value instead of crashing inside the stack', () => {
    // `cdk.json` holds JSON, so `"allowedOrigins": ["https://a"]` is a natural
    // thing to write. Chosen behaviour: REFUSE it and name the flag — one code
    // path for "the flag was given something unusable", rather than quietly
    // widening what the stack accepts.
    const error = thrownBy(() =>
      buildAppStack({ context: { allowedOrigins: ['https://a.example.com'] } }),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/allowedOrigins/);
    expect(
      (error as Error).message,
      'a TypeError from .split is a crash, not a refusal',
    ).not.toMatch(/is not a function/);
  });
});

// A browser's `Origin` header is always `scheme://host[:port]` — so an entry
// without a scheme cannot match one, ever. Today any non-empty scrap survives
// the trim and synthesises into the allow-list, and the failure surfaces in a
// browser console days later, far from the flag that caused it.
describe('an origin no browser could ever send is refused at synth', () => {
  it.each([
    // The likeliest operator typo: the host as it appears in the address bar.
    ['a host with the scheme left off', 'app.example.com'],
    // `-c allowedOrigins=null` is a string; the JSON null this branch also
    // handles goes through a different path entirely.
    ['the literal string null', 'null'],
    // A quoting artifact from a shell or a CI variable: non-empty after trim,
    // and meaningless as an origin.
    ['a quoting artifact left over from the shell', '" "'],
  ])('refuses %s and names the flag that carried it', (_case, value) => {
    const error = thrownBy(() => buildAppStack({ context: { allowedOrigins: value } }));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/allowedOrigins/);
  });

  it('accepts the origins a browser can actually send', () => {
    // The refusal above must stay narrow: a real deploy origin and the local
    // dev one are the two shapes this project is built around.
    expect(originsOf({ context: { allowedOrigins: 'https://a.example.com' } })).toEqual([
      'https://a.example.com',
    ]);
    expect(originsOf({ context: { allowedOrigins: 'http://localhost:3000' } })).toEqual([
      'http://localhost:3000',
    ]);
  });
});

// `*` is a decision, not a defect: an operator who types it into a flag has
// chosen it, and refusing outright would push people to edit the stack instead
// — a worse outcome, invisible to this test file. So it is accepted AND it is
// loud. The composition test only pins the absence of a wildcard when no
// context is set, so today a one-line `cdk.json` edit ships wildcard CORS past
// synth, the suite and CI without a word.
describe('a wildcard allow-list is honoured, but never silently', () => {
  const namesTheWildcardRisk = Match.stringLikeRegexp('allowedOrigins');

  it('keeps the wildcard the operator asked for', () => {
    expect(originsOf({ context: { allowedOrigins: '*' } })).toEqual(['*']);
  });

  it('warns on the stack when the allow-list is a wildcard', () => {
    const stack = buildAppStack({ context: { allowedOrigins: '*' } });
    Annotations.fromStack(stack).hasWarning('*', namesTheWildcardRisk);
  });

  it('warns just the same when the wildcard is hidden among real origins', () => {
    // `https://a.example.com,*` reads like an allow-list; the `*` makes every
    // other entry decorative, which is exactly why it must not slip past.
    const context = { allowedOrigins: 'https://a.example.com,*' };
    expect(originsOf({ context })).toEqual(['https://a.example.com', '*']);
    Annotations.fromStack(buildAppStack({ context })).hasWarning('*', namesTheWildcardRisk);
  });
});
