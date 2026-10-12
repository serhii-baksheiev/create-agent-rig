import { BMAD_TEA_VERSION } from './bmad-tea.js';
import { PLAYWRIGHT_MCP_VERSION } from './playwright.js';
import { PROBITY_VERSION } from './probity.js';
import { SPEC_KIT_VERSION } from './spec-kit.js';

/**
 * RP-445: how a provider's newest upstream release relates to the version Rig
 * was tested against. Read-only and explicitly networked — the one place the
 * CLI asks a registry anything; doctor and release evidence stay offline.
 */
export type FreshnessState = 'current' | 'behind' | 'ahead' | 'unknown';
export type ProviderFreshness = {
  id: string;
  tested: string;
  state: FreshnessState;
  latest?: string;
  highestStable?: string;
  latestRelease?: string;
  highestTag?: string;
  reason?: string;
};
export type FreshnessReport = { schemaVersion: 1; providers: ProviderFreshness[] };
export type FreshnessOptions = {
  fetch: typeof globalThis.fetch;
  userAgent: string;
  includePrereleases?: boolean;
  /** Per request, body included; a request that outlives it is reported as `timeout`. */
  timeoutMs?: number;
};

/** semver.org's grammar without build metadata: no leading zeros, dot-separated prerelease. */
const IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER = new RegExp(
  `^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?$`,
);
const NUMERIC = /^\d+$/;

/** Digit strings without leading zeros order by length first — no Number() precision loss. */
function compareNumeric(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function compare(a: string, b: string): number {
  const left = SEMVER.exec(a)!;
  const right = SEMVER.exec(b)!;
  for (let i = 1; i <= 3; i++) {
    const order = compareNumeric(left[i]!, right[i]!);
    if (order !== 0) return order;
  }
  const leftPre = left[4]?.split('.') ?? [];
  const rightPre = right[4]?.split('.') ?? [];
  if (leftPre.length === 0 || rightPre.length === 0) return rightPre.length - leftPre.length;
  for (let i = 0; i < Math.min(leftPre.length, rightPre.length); i++) {
    const x = leftPre[i]!;
    const y = rightPre[i]!;
    if (x === y) continue;
    const xNumeric = NUMERIC.test(x);
    const yNumeric = NUMERIC.test(y);
    if (xNumeric && yNumeric) return compareNumeric(x, y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return leftPre.length - rightPre.length;
}

function highest(candidates: readonly string[], includePrereleases: boolean): string | undefined {
  let best: string | undefined;
  for (const value of candidates) {
    const match = SEMVER.exec(value);
    if (match === null || (!includePrereleases && match[4] !== undefined)) continue;
    if (best === undefined || compare(value, best) > 0) best = value;
  }
  return best;
}

/** Where the provider's newest upstream version stands relative to the Rig-tested one. */
function classify(tested: string, newest: string | undefined): FreshnessState {
  if (newest === undefined) return 'unknown';
  const order = compare(newest, tested);
  return order === 0 ? 'current' : order > 0 ? 'behind' : 'ahead';
}

/** A provider whose freshness could not be decided; `reason` is the report's word for why. */
class Unknown extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const NPM_MAX_BYTES = 16 * 1024 * 1024;
const GITHUB_MAX_BYTES = 1024 * 1024;

/** One GET; a rejected fetch or a non-2xx answer becomes the reason word, never a throw upward. */
async function request(url: string, accept: string, options: FreshnessOptions): Promise<Response> {
  let response: Response;
  try {
    response = await options.fetch(url, {
      headers: { Accept: accept, 'User-Agent': options.userAgent },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (error) {
    throw transportFailure(error);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Unknown(
      response.status === 403 || response.status === 429
        ? 'rate-limited'
        : `http-${response.status}`,
    );
  }
  return response;
}

function transportFailure(error: unknown): Unknown {
  return new Unknown(
    (error as Error | undefined)?.name === 'TimeoutError' ? 'timeout' : 'network-error',
  );
}

/** The body as JSON, read no further than `maxBytes`. */
async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  try {
    for (;;) {
      const next = await reader?.read();
      if (next === undefined || next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader?.cancel().catch(() => undefined);
        throw new Unknown('response-too-large');
      }
      chunks.push(next.value);
    }
  } catch (error) {
    throw error instanceof Unknown ? error : transportFailure(error);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Unknown('invalid-response');
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function npmFreshness(
  id: string,
  pkg: string,
  tested: string,
  options: FreshnessOptions,
): Promise<ProviderFreshness> {
  const response = await request(
    `https://registry.npmjs.org/${pkg.replace('/', '%2f')}`,
    'application/vnd.npm.install-v1+json',
    options,
  );
  const body = await readJson(response, NPM_MAX_BYTES);
  if (!isRecord(body)) throw new Unknown('invalid-response');
  const tags = body['dist-tags'];
  const latest = isRecord(tags) ? tags.latest : undefined;
  const highestStable = highest(
    isRecord(body.versions) ? Object.keys(body.versions) : [],
    options.includePrereleases ?? false,
  );
  if (highestStable === undefined) throw new Unknown('no-stable-version');
  return {
    id,
    tested,
    state: classify(tested, highestStable),
    ...(typeof latest === 'string' && SEMVER.test(latest) ? { latest } : {}),
    highestStable,
  };
}

async function githubFreshness(
  id: string,
  repo: string,
  tested: string,
  options: FreshnessOptions,
): Promise<ProviderFreshness> {
  const get = (url: string) => request(url, 'application/vnd.github+json', options);
  const unv = (value: unknown) => (typeof value === 'string' ? value.replace(/^v/, '') : '');
  const release = await readJson(
    await get(`https://api.github.com/repos/${repo}/releases/latest`),
    GITHUB_MAX_BYTES,
  );
  const tagName = unv(isRecord(release) ? release.tag_name : undefined);
  if (!SEMVER.test(tagName)) throw new Unknown('no-stable-version');
  const entry: ProviderFreshness = {
    id,
    tested,
    state: classify(tested, tagName),
    latestRelease: tagName,
  };
  const tagsResponse = await get(`https://api.github.com/repos/${repo}/tags?per_page=100`);
  // One page only: a list with a next page cannot name its highest tag.
  if (/\brel="next"/.test(tagsResponse.headers.get('link') ?? '')) {
    await tagsResponse.body?.cancel().catch(() => undefined);
    return { ...entry, reason: 'tag-list-truncated' };
  }
  const tags = await readJson(tagsResponse, GITHUB_MAX_BYTES);
  if (!Array.isArray(tags)) throw new Unknown('invalid-response');
  const highestTag = highest(
    tags.map((tag: unknown) => unv(isRecord(tag) ? tag.name : undefined)),
    options.includePrereleases ?? false,
  );
  return highestTag === undefined
    ? { ...entry, reason: 'no-stable-version' }
    : { ...entry, highestTag };
}

/** Every failure inside one provider is that provider's unknown, never the whole report's. */
async function settle(
  id: string,
  tested: string,
  run: () => Promise<ProviderFreshness>,
): Promise<ProviderFreshness> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof Unknown)) throw error;
    return { id, tested, state: 'unknown', reason: error.reason };
  }
}

export async function checkFreshness(options: FreshnessOptions): Promise<FreshnessReport> {
  return {
    schemaVersion: 1,
    providers: [
      await settle('probity', PROBITY_VERSION, () =>
        npmFreshness('probity', '@nizos/probity', PROBITY_VERSION, options),
      ),
      await settle('playwright-mcp', PLAYWRIGHT_MCP_VERSION, () =>
        npmFreshness('playwright-mcp', '@playwright/mcp', PLAYWRIGHT_MCP_VERSION, options),
      ),
      await settle('spec-kit', SPEC_KIT_VERSION, () =>
        githubFreshness('spec-kit', 'github/spec-kit', SPEC_KIT_VERSION, options),
      ),
      // Rig records no upstream repository for TEA, so there is nothing to ask.
      {
        id: 'bmad-tea',
        tested: BMAD_TEA_VERSION,
        state: 'unknown',
        reason: 'upstream-not-recorded',
      },
    ],
  };
}
