import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Annotations as CdkAnnotations, App } from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import {
  AppStack,
  type AppStackProps,
  nothingGiven,
  resolveAllowedOrigins,
} from '../lib/app-stack.js';

// Who may call the API is a security decision with exactly two safe outcomes:
// the right origins, or a refusal loud enough that somebody fixes it. An empty
// allow-list is neither — it synthesises, deploys, and blocks every call.
//
// Resolving that list is a pure function of (props, context), so it is tested
// as one. The previous shape of this file built a whole AppStack per case —
// twelve synths, each bundling three Lambdas with esbuild — which cost ~9.3s
// and left the generated project's `beforeAll` hooks racing vitest's 10s
// default hookTimeout on a saturated CPU. Only the CDK-level behaviour below
// (the wildcard annotation) needs a stack, and it builds one per case.

const resolved = (given: { props?: string[]; context?: unknown } = {}): string[] =>
  resolveAllowedOrigins(given.props, given.context);

const thrownBy = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The port `apps/web` is actually started on, read from the script that starts it.
 *
 * The localhost default in `app-stack.ts` is a restated copy of a number owned
 * by another file, and a restated constant drifts: it shipped `:3000` while the
 * only dev server in this repository has always been launched with
 * `--port 3001`, so the default named an origin nothing here ever sends —
 * configured-looking, and working for nobody. Reading the source of truth is
 * what stops that happening a second time.
 *
 * The read is deliberately loud. A `dev` script this cannot parse fails the
 * suite rather than falling back to a port of its own, because a correspondence
 * test that quietly supplies both sides of the correspondence checks nothing.
 */
const webDevServerPort = (): string => {
  const manifest = path.join(workspaceRoot, 'apps', 'web', 'package.json');
  const scripts = (JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: Record<string, string> })
    .scripts;
  const dev = scripts?.dev;
  expect(dev, 'apps/web/package.json has no dev script to take the origin port from').toBeTypeOf(
    'string',
  );
  const port = /--port[=\s]+(\d+)/.exec(dev as string)?.[1];
  expect(
    port,
    `the dev script ${JSON.stringify(dev)} names no --port, so nothing pins the default to it`,
  ).toBeTypeOf('string');
  return port as string;
};

/** Every refusal must name the flag that carried the bad value, and be an Error. */
const refusalFrom = (run: () => unknown): Error => {
  const error = thrownBy(run);
  expect(error, 'the value was accepted instead of refused').toBeInstanceOf(Error);
  expect(
    (error as Error).message,
    'the message must name the flag that was wrong',
  ).toMatch(/allowedOrigins/);
  return error as Error;
};

describe('choosing the allowed origins', () => {
  it('falls back to localhost only when nothing at all was given', () => {
    expect(resolved()).toEqual(['http://localhost:3001']);
  });

  it('defaults to the port the web dev server is actually started on', () => {
    // The correspondence, not a second copy of the number. `apps/web` owns the
    // port; a default that restates it is only correct until somebody changes
    // one of the two, which is exactly how it came to name :3000.
    expect(resolved()).toEqual([`http://localhost:${webDevServerPort()}`]);
  });

  it('prefers the origins passed in props over the localhost default', () => {
    expect(resolved({ props: ['https://app.example.com'] })).toEqual(['https://app.example.com']);
  });

  it('prefers the origins passed in props over a context value', () => {
    // Both are "given"; props are the programmatic wiring and win. `bin/app.ts`
    // depends on this ordering being decided in one place.
    expect(
      resolved({ props: ['https://app.example.com'], context: 'https://ctx.example.com' }),
    ).toEqual(['https://app.example.com']);
  });

  it('reads a comma-separated -c allowedOrigins as one origin each, trimmed', () => {
    expect(resolved({ context: ' https://a.example.com , https://b.example.com ' })).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('treats a null context as nothing given, exactly as bin/app.ts does', () => {
    // A JSON `null` is writable in `cdk.json`, `cdk.context.json` or
    // `CDK_CONTEXT_JSON`. If the two files disagree about it, the entrypoint
    // drops the wired CloudFront origin while the stack falls back to a
    // localhost no deploy is served from — green synth, blocked browser.
    expect(nothingGiven(null)).toBe(true);
    expect(nothingGiven(undefined)).toBe(true);
    expect(resolved({ context: null })).toEqual(['http://localhost:3001']);
  });
});

describe('an allow-list that names nobody is a broken deploy, not a default', () => {
  it('refuses a context value that parses to no origin at all', () => {
    // `-c allowedOrigins=" , , "` is a typo, and an empty allow-list means
    // every browser call fails — whose only obvious repair is putting `*` back.
    refusalFrom(() => resolved({ context: ' , , ' }));
  });

  it('refuses an explicitly empty allowedOrigins prop for the same reason', () => {
    // `?? DEFAULT` does not catch `[]` — an empty array is not nullish, so it
    // travels all the way to CorsConfiguration.
    refusalFrom(() => resolved({ props: [] }));
  });

  it('refuses a non-string context value instead of crashing inside the stack', () => {
    // `cdk.json` holds JSON, so `"allowedOrigins": ["https://a"]` is a natural
    // thing to write. Chosen behaviour: REFUSE it and name the flag — one code
    // path for "the flag was given something unusable", rather than quietly
    // widening what the stack accepts.
    const error = refusalFrom(() => resolved({ context: ['https://a.example.com'] }));
    expect(error.message, 'a TypeError from .split is a crash, not a refusal').not.toMatch(
      /is not a function/,
    );
  });
});

// A browser's `Origin` header is always `scheme://host[:port]` — so an entry
// without a scheme cannot match one, ever, and the failure surfaces in a
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
    refusalFrom(() => resolved({ context: value }));
  });

  it('refuses the same shapes when they arrive through props', () => {
    // Two entry points, one standard: a prop is not a trusted channel just
    // because it is typed `string[]`.
    refusalFrom(() => resolved({ props: ['app.example.com'] }));
  });

  it('accepts the origins a browser can actually send', () => {
    // The refusal above must stay narrow: a real deploy origin and the local
    // dev one are the two shapes this project is built around. The second is
    // spelled as THIS project's dev origin on purpose — an arbitrary port would
    // prove the same thing about the parser while quietly reading as "the dev
    // origin" to the next person, which is the confusion that produced the
    // :3000 default in the first place.
    expect(resolved({ context: 'https://a.example.com' })).toEqual(['https://a.example.com']);
    expect(resolved({ context: 'http://localhost:3001' })).toEqual(['http://localhost:3001']);
  });
});

// An entry that synthesises but can never equal a browser's `Origin` header is
// the same failure as a typo, only quieter: CORS compares the header to the
// allow-list byte for byte. The near-misses below all survive `new URL()`, so
// nothing downstream objects — the API just refuses every call.
describe('an origin is stored the way a browser would actually send it', () => {
  it.each([
    // Copying the site's root URL out of the address bar adds the slash. This
    // is the likeliest of the five by a wide margin.
    ['a trailing slash', 'https://app.example.com/', 'https://app.example.com'],
    ['an uppercase scheme', 'HTTPS://app.example.com', 'https://app.example.com'],
    ['a path left on the end', 'https://app.example.com/notes', 'https://app.example.com'],
    // A browser resolves an IDN to punycode before it builds the header, so
    // the unicode spelling never appears on the wire.
    ['a unicode host', 'https://héllo.example.com', 'https://xn--hllo-bpa.example.com'],
    // Also strips a credential that has no business in a synthesised template.
    ['userinfo', 'https://user:secret@app.example.com', 'https://app.example.com'],
    // Browsers omit the default port; a literal `:443` never matches.
    ['a redundant default port', 'https://app.example.com:443/', 'https://app.example.com'],
  ])('normalises %s to what the Origin header carries', (_case, given, expected) => {
    expect(resolved({ context: given }), 'through -c allowedOrigins').toEqual([expected]);
    expect(resolved({ props: [given] }), 'and through props, identically').toEqual([expected]);
  });

  it('keeps a non-default port, which a browser does send', () => {
    expect(resolved({ context: 'https://app.example.com:8443/' })).toEqual([
      'https://app.example.com:8443',
    ]);
  });

  it('trims a props entry the way it trims a context entry', () => {
    // The context branch trims before checking; the props branch never did, so
    // a stray space from a shell array reached CorsConfiguration intact.
    expect(resolved({ props: [' https://a.example.com ', 'https://b.example.com\t'] })).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('never stores the literal string null, whatever it was handed', () => {
    // `URL.origin` is the string "null" for every opaque scheme. An allow-list
    // entry of `null` matches the `Origin: null` a sandboxed iframe sends —
    // granting exactly the caller nobody meant to grant.
    for (const value of ['null', 'file:///tmp/x', 'data:text/html,x']) {
      expect(thrownBy(() => resolved({ context: value })), value).toBeInstanceOf(Error);
    }
  });
});

// These are real `Origin` header values — a Chrome extension, and the two
// WebView schemes Capacitor and Ionic use on device. Refusing them is a
// DECISION, recorded here rather than left to be rediscovered: the http(s)
// check is what makes the scheme-less typo above catchable, the refusal is
// loud and names the flag, and an app that genuinely serves a WebView client
// widens `checkedOrigin` in one place. Changing this must change this test.
describe('a non-http(s) origin is refused, and that is a decision on record', () => {
  it.each([
    ['a browser extension', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'],
    ['a Capacitor WebView', 'capacitor://localhost'],
    ['an Ionic WebView', 'ionic://localhost'],
    ['a blob URL whose inner origin looks real', 'blob:https://example.com/uuid'],
  ])('refuses %s, saying which schemes it does take', (_case, value) => {
    const error = refusalFrom(() => resolved({ context: value }));
    expect(error.message, 'the refusal must say what it would have accepted').toMatch(/http/);
  });
});

// `*` is a decision, not a defect: an operator who types it into a flag has
// chosen it, and refusing outright would push people to edit the stack instead
// — a worse outcome, invisible to this test file. So it is accepted AND it is
// loud.
describe('a wildcard allow-list is honoured, but never silently', () => {
  const namesTheWildcardRisk = Match.stringLikeRegexp('allowedOrigins');
  /** Acknowledgeable warnings need a stable id; changing it is a breaking change. */
  const wildcardWarningId = '@app/allowed-origins:wildcard';

  it('keeps the wildcard the operator asked for', () => {
    expect(resolved({ context: '*' })).toEqual(['*']);
    expect(resolved({ props: ['*'] })).toEqual(['*']);
  });

  it('keeps a wildcard hidden among real origins, rather than dropping it', () => {
    // `https://a.example.com,*` reads like an allow-list; the `*` makes every
    // other entry decorative, which is exactly why it must not slip past.
    expect(resolved({ context: 'https://a.example.com,*' })).toEqual([
      'https://a.example.com',
      '*',
    ]);
  });

  // Everything below builds a real AppStack — three esbuild bundles and a synth
  // apiece. One stack per case, and nothing in a `beforeAll`: the generated
  // project's vitest config raises `testTimeout`, not `hookTimeout`, so a hook
  // that synthesises is a 10s fuse on a loaded machine.
  const stackWith = (options: { context?: Record<string, unknown>; props?: AppStackProps }) =>
    new AppStack(new App({ context: options.context }), 'TestStack', options.props);

  it('warns about a wildcard from -c allowedOrigins, acknowledgeably', () => {
    // "Honoured, but loud" only holds if the operator can then proceed. A bare
    // `addWarning` cannot be acknowledged, so `cdk synth --strict` — the flag
    // CI reaches for — turns a deliberate `*` into a hard failure with no way
    // past it short of editing the stack: the outcome this design refuses.
    // Emission and acknowledgeability are one behaviour and share one stack;
    // a second one costs another three esbuild bundles.
    const stack = stackWith({ context: { allowedOrigins: '*' } });
    Annotations.fromStack(stack).hasWarning('*', namesTheWildcardRisk);

    CdkAnnotations.of(stack).acknowledgeWarning(wildcardWarningId);

    Annotations.fromStack(stack).hasNoWarning('*', namesTheWildcardRisk);
  });

  it('warns just the same when the wildcard arrives through props', () => {
    // `bin/app.ts` passes props, so this is the path a composed app takes —
    // and it was the untested half: a wildcard wired in code warned nobody.
    Annotations.fromStack(stackWith({ props: { allowedOrigins: ['*'] } })).hasWarning(
      '*',
      namesTheWildcardRisk,
    );
  });
});
