import { describe, expect, it } from 'vitest';
import { checkFreshness } from '../src/integrations/freshness.js';
import { PROBITY_VERSION } from '../src/integrations/probity.js';

const PROBITY_URL = 'https://registry.npmjs.org/@nizos%2fprobity';

type Route = { status?: number; body: string; headers?: Record<string, string> };

/** A fetch that answers from a URL table and never reaches the network. */
function fakeFetch(routes: Record<string, Route>) {
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

const npmBody = (latest: string, versions: string[]): Route => ({
  body: JSON.stringify({
    'dist-tags': { latest },
    versions: Object.fromEntries(versions.map((version) => [version, {}])),
  }),
});

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
});
