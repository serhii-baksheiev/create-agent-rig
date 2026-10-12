import { describe, expect, it } from 'vitest';
import { runFreshnessCommand } from '../src/commands/freshness.js';
import { BMAD_TEA_VERSION } from '../src/integrations/bmad-tea.js';
import { checkFreshness } from '../src/integrations/freshness.js';
import { PLAYWRIGHT_MCP_VERSION } from '../src/integrations/playwright.js';
import { PROBITY_VERSION } from '../src/integrations/probity.js';
import { SPEC_KIT_VERSION } from '../src/integrations/spec-kit.js';

const PROBITY_URL = 'https://registry.npmjs.org/@nizos%2fprobity';
const PLAYWRIGHT_MCP_URL = 'https://registry.npmjs.org/@playwright%2fmcp';
const SPEC_KIT_RELEASE_URL = 'https://api.github.com/repos/github/spec-kit/releases/latest';
const SPEC_KIT_TAGS_URL = 'https://api.github.com/repos/github/spec-kit/tags?per_page=100';

type Route = {
  status?: number;
  body?: string | (() => ReadableStream<Uint8Array>);
  headers?: Record<string, string>;
  /** `network`: the fetch rejects; `hang`: it settles only when its signal aborts. */
  fail?: 'network' | 'hang';
};

/** A body of `size` bytes, produced lazily so a large one never sits in memory at once. */
const bytes = (size: number) => () => {
  const chunk = new Uint8Array(64 * 1024).fill(0x61);
  let left = size;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left <= 0) return controller.close();
      const next = chunk.subarray(0, Math.min(chunk.length, left));
      left -= next.length;
      controller.enqueue(next);
    },
  });
};

const npmBody = (latest: string, versions: string[]): Route => ({
  body: JSON.stringify({
    'dist-tags': { latest },
    versions: Object.fromEntries(versions.map((version) => [version, {}])),
  }),
});

/** A valid answer for every upstream; each test overrides only the routes it is about. */
const BASE_ROUTES: Record<string, Route> = {
  [PROBITY_URL]: npmBody(PROBITY_VERSION, [PROBITY_VERSION]),
  [PLAYWRIGHT_MCP_URL]: npmBody(PLAYWRIGHT_MCP_VERSION, [PLAYWRIGHT_MCP_VERSION]),
  [SPEC_KIT_RELEASE_URL]: { body: JSON.stringify({ tag_name: `v${SPEC_KIT_VERSION}` }) },
  [SPEC_KIT_TAGS_URL]: { body: JSON.stringify([{ name: `v${SPEC_KIT_VERSION}` }]) },
};

/** A fetch that answers from a URL table and never reaches the network. */
function fakeFetch(overrides: Record<string, Route>) {
  const routes = { ...BASE_ROUTES, ...overrides };
  const requests: { url: string; headers: Headers }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    const route = routes[url];
    if (route === undefined) return new Response('not found', { status: 404 });
    if (route.fail === 'network') throw new TypeError('fetch failed');
    if (route.fail === 'hang') {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }
    const body = typeof route.body === 'function' ? route.body() : route.body;
    return new Response(body, { status: route.status ?? 200, headers: route.headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
}

describe('integrations freshness (RP-445)', () => {
  it('reports dist-tag latest and highest stable separately when they disagree', async () => {
    const { fetch } = fakeFetch({
      [PROBITY_URL]: npmBody('1.10.1', ['1.9.0', '1.10.1', '1.11.0']),
    });

    const result = await checkFreshness({ fetch, userAgent: 'create-agent-rig/test' });

    expect(result.schemaVersion).toBe(1);
    const probity = result.providers.find((provider) => provider.id === 'probity');
    expect(probity).toMatchObject({
      id: 'probity',
      tested: PROBITY_VERSION,
      latest: '1.10.1',
      highestStable: '1.11.0',
    });
  });

  it('excludes prereleases by default and includes them with includePrereleases', async () => {
    const routes = {
      [PROBITY_URL]: npmBody('1.10.1', ['1.10.1', '1.11.0', '1.12.0-beta.1', '1.12.0-alpha.2']),
    };
    const probity = (report: Awaited<ReturnType<typeof checkFreshness>>) =>
      report.providers.find((provider) => provider.id === 'probity');

    const byDefault = await checkFreshness({
      fetch: fakeFetch(routes).fetch,
      userAgent: 'create-agent-rig/test',
    });
    const included = await checkFreshness({
      fetch: fakeFetch(routes).fetch,
      userAgent: 'create-agent-rig/test',
      includePrereleases: true,
    });

    expect(probity(byDefault)?.highestStable).toBe('1.11.0');
    expect(probity(included)?.highestStable).toBe('1.12.0-beta.1');
  });

  it('reports spec-kit latest release and highest tag separately', async () => {
    const { fetch, requests } = fakeFetch({
      [SPEC_KIT_RELEASE_URL]: { body: JSON.stringify({ tag_name: 'v1.0.9' }) },
      [SPEC_KIT_TAGS_URL]: {
        body: JSON.stringify([
          { name: 'v1.1.0-rc.1' },
          { name: 'v1.0.10' },
          { name: 'v1.0.9' },
          { name: 'nightly' },
        ]),
      },
    });

    const result = await checkFreshness({ fetch, userAgent: 'create-agent-rig/test' });

    const specKit = result.providers.find((provider) => provider.id === 'spec-kit');
    expect(specKit).toMatchObject({
      id: 'spec-kit',
      tested: SPEC_KIT_VERSION,
      latestRelease: '1.0.9',
      highestTag: '1.0.10',
    });
    const github = requests.filter((request) => request.url.startsWith('https://api.github.com/'));
    expect(github.map((request) => request.headers.get('accept'))).toEqual([
      'application/vnd.github+json',
      'application/vnd.github+json',
    ]);
    expect(
      github.every((request) => request.headers.get('user-agent') === 'create-agent-rig/test'),
    ).toBe(true);
  });

  it('reports a truncated tag list as unknown', async () => {
    const { fetch } = fakeFetch({
      [SPEC_KIT_TAGS_URL]: {
        body: JSON.stringify([{ name: 'v1.0.9' }]),
        headers: {
          Link: '<https://api.github.com/repositories/1/tags?per_page=100&page=2>; rel="next"',
        },
      },
    });

    const result = await checkFreshness({ fetch, userAgent: 'create-agent-rig/test' });

    const specKit = result.providers.find((provider) => provider.id === 'spec-kit');
    expect(specKit?.highestTag).toBeUndefined();
    expect(specKit?.reason).toBe('tag-list-truncated');
    expect(specKit?.latestRelease).toBe(SPEC_KIT_VERSION);
  });

  it('reports bmad-tea as unknown without a request', async () => {
    const { fetch, requests } = fakeFetch({});

    const result = await checkFreshness({ fetch, userAgent: 'create-agent-rig/test' });

    expect(result.providers.find((provider) => provider.id === 'bmad-tea')).toEqual({
      id: 'bmad-tea',
      tested: BMAD_TEA_VERSION,
      state: 'unknown',
      reason: 'upstream-not-recorded',
    });
    // Every request went to another provider's upstream; none was made for bmad-tea.
    expect(requests.filter((request) => !(request.url in BASE_ROUTES))).toEqual([]);
  });

  it('classifies current, behind and ahead against the Rig-tested version', async () => {
    const { fetch } = fakeFetch({
      [PROBITY_URL]: npmBody(PROBITY_VERSION, [PROBITY_VERSION, '999.0.0']),
      [PLAYWRIGHT_MCP_URL]: npmBody('0.0.0', ['0.0.0']),
    });

    const result = await checkFreshness({ fetch, userAgent: 'create-agent-rig/test' });

    const states = Object.fromEntries(
      result.providers.map((provider) => [provider.id, provider.state]),
    );
    expect(states).toEqual({
      probity: 'behind',
      'playwright-mcp': 'ahead',
      'spec-kit': 'current',
      'bmad-tea': 'unknown',
    });
  });

  it('reports network error, timeout, 403/429, oversize and invalid JSON as unknown with a reason', async () => {
    const reasons = async (overrides: Record<string, Route>) => {
      const { fetch } = fakeFetch(overrides);
      const result = await checkFreshness({
        fetch,
        userAgent: 'create-agent-rig/test',
        timeoutMs: 50,
      });
      return Object.fromEntries(
        result.providers
          .filter((provider) => provider.state === 'unknown')
          .map((provider) => [provider.id, provider]),
      );
    };
    const unknown = (id: string, tested: string, reason: string) => ({
      id,
      tested,
      state: 'unknown',
      reason,
    });

    expect(
      await reasons({
        [PROBITY_URL]: { fail: 'network' },
        [PLAYWRIGHT_MCP_URL]: { fail: 'hang' },
        [SPEC_KIT_RELEASE_URL]: { status: 403, body: '{}' },
      }),
    ).toEqual({
      probity: unknown('probity', PROBITY_VERSION, 'network-error'),
      'playwright-mcp': unknown('playwright-mcp', PLAYWRIGHT_MCP_VERSION, 'timeout'),
      'spec-kit': unknown('spec-kit', SPEC_KIT_VERSION, 'rate-limited'),
      'bmad-tea': unknown('bmad-tea', BMAD_TEA_VERSION, 'upstream-not-recorded'),
    });
    expect(
      await reasons({
        [PROBITY_URL]: { status: 429, body: '{}' },
        [PLAYWRIGHT_MCP_URL]: { status: 500, body: '{}' },
        [SPEC_KIT_TAGS_URL]: { body: bytes(1024 * 1024 + 1) },
      }),
    ).toMatchObject({
      probity: { reason: 'rate-limited' },
      'playwright-mcp': { reason: 'http-500' },
      'spec-kit': { reason: 'response-too-large' },
    });
    expect(
      await reasons({
        [PROBITY_URL]: { body: bytes(16 * 1024 * 1024 + 1) },
        [PLAYWRIGHT_MCP_URL]: { body: 'not json' },
        [SPEC_KIT_RELEASE_URL]: { body: JSON.stringify({ tag_name: 'nightly' }) },
      }),
    ).toMatchObject({
      probity: { reason: 'response-too-large' },
      'playwright-mcp': { reason: 'invalid-response' },
      'spec-kit': { reason: 'no-stable-version' },
    });
    // A 16 MiB npm document is within the cap; the cap is per upstream, not one shared figure.
    expect(await reasons({ [PROBITY_URL]: { body: bytes(16 * 1024 * 1024) } })).toMatchObject({
      probity: { reason: 'invalid-response' },
    });
  });

  it('never sends a credential header', async () => {
    // Assembled at runtime so no credential-shaped literal sits in the source.
    const secret = ['freshness', 'probe', String(process.pid)].join('-');
    const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, NPM_TOKEN: process.env.NPM_TOKEN };
    process.env.GITHUB_TOKEN = secret;
    process.env.NPM_TOKEN = secret;
    try {
      const { fetch, requests } = fakeFetch({});

      await checkFreshness({ fetch, userAgent: 'create-agent-rig/test' });

      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        expect(request.headers.has('authorization'), request.url).toBe(false);
        expect([...request.headers.values()].join('\n'), request.url).not.toContain(secret);
      }
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe('create-agent-rig integrations freshness (RP-445)', () => {
  it('integrations freshness --json prints the report and exits 0', async () => {
    const { fetch, requests } = fakeFetch({ [PLAYWRIGHT_MCP_URL]: { fail: 'network' } });

    const result = await runFreshnessCommand({ args: ['freshness', '--json'], fetch });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as Awaited<ReturnType<typeof checkFreshness>>;
    expect(result.stdout).toBe(`${JSON.stringify(report)}\n`);
    expect(report.schemaVersion).toBe(1);
    expect(report.providers.map((provider) => [provider.id, provider.state])).toEqual([
      ['probity', 'current'],
      ['playwright-mcp', 'unknown'],
      ['spec-kit', 'current'],
      ['bmad-tea', 'unknown'],
    ]);
    expect(requests[0]?.headers.get('user-agent')).toMatch(/^create-agent-rig\/\d+\.\d+\.\d+/);
  });

  it('integrations freshness prints one line per provider without --json', async () => {
    const { fetch } = fakeFetch({
      [PROBITY_URL]: npmBody(PROBITY_VERSION, [PROBITY_VERSION, '999.0.0']),
      [PLAYWRIGHT_MCP_URL]: { fail: 'network' },
    });

    const result = await runFreshnessCommand({ args: ['freshness'], fetch });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.split('\n')).toEqual([
      `probity: behind (tested ${PROBITY_VERSION}; latest ${PROBITY_VERSION}; highest stable 999.0.0)`,
      `playwright-mcp: unknown (tested ${PLAYWRIGHT_MCP_VERSION}; reason network-error)`,
      `spec-kit: current (tested ${SPEC_KIT_VERSION}; latest release ${SPEC_KIT_VERSION}; highest tag ${SPEC_KIT_VERSION})`,
      `bmad-tea: unknown (tested ${BMAD_TEA_VERSION}; reason upstream-not-recorded)`,
      '',
    ]);
  });
});
