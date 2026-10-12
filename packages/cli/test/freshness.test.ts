import { describe, expect, it } from 'vitest';
import { checkFreshness } from '../src/integrations/freshness.js';
import { PROBITY_VERSION } from '../src/integrations/probity.js';
import { SPEC_KIT_VERSION } from '../src/integrations/spec-kit.js';

const PROBITY_URL = 'https://registry.npmjs.org/@nizos%2fprobity';
const SPEC_KIT_RELEASE_URL = 'https://api.github.com/repos/github/spec-kit/releases/latest';
const SPEC_KIT_TAGS_URL = 'https://api.github.com/repos/github/spec-kit/tags?per_page=100';

type Route = { status?: number; body: string; headers?: Record<string, string> };

const npmBody = (latest: string, versions: string[]): Route => ({
  body: JSON.stringify({
    'dist-tags': { latest },
    versions: Object.fromEntries(versions.map((version) => [version, {}])),
  }),
});

/** A valid answer for every upstream; each test overrides only the routes it is about. */
const BASE_ROUTES: Record<string, Route> = {
  [PROBITY_URL]: npmBody(PROBITY_VERSION, [PROBITY_VERSION]),
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
    return new Response(route.body, { status: route.status ?? 200, headers: route.headers });
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
});
