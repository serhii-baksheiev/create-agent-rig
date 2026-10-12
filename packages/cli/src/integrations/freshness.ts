import { PROBITY_VERSION } from './probity.js';
import { SPEC_KIT_VERSION } from './spec-kit.js';

/**
 * RP-445: how a provider's newest upstream release relates to the version Rig
 * was tested against. Read-only and explicitly networked — the one place the
 * CLI asks a registry anything; doctor and release evidence stay offline.
 */
export type ProviderFreshness = {
  id: string;
  tested: string;
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
  return candidates
    .filter((value) => {
      const match = SEMVER.exec(value);
      return match !== null && (includePrereleases || match[4] === undefined);
    })
    .sort(compare)
    .at(-1);
}

async function npmFreshness(
  id: string,
  pkg: string,
  tested: string,
  options: FreshnessOptions,
): Promise<ProviderFreshness> {
  const response = await options.fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2f')}`, {
    headers: {
      Accept: 'application/vnd.npm.install-v1+json',
      'User-Agent': options.userAgent,
    },
  });
  const body = (await response.json()) as {
    'dist-tags'?: { latest?: unknown };
    versions?: Record<string, unknown>;
  };
  const latest = body['dist-tags']?.latest;
  return {
    id,
    tested,
    ...(typeof latest === 'string' && SEMVER.test(latest) ? { latest } : {}),
    highestStable: highest(Object.keys(body.versions ?? {}), options.includePrereleases ?? false),
  };
}

async function githubFreshness(
  id: string,
  repo: string,
  tested: string,
  options: FreshnessOptions,
): Promise<ProviderFreshness> {
  const get = (url: string): Promise<Response> =>
    options.fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': options.userAgent },
    });
  const unv = (value: unknown) => (typeof value === 'string' ? value.replace(/^v/, '') : '');
  const release = (await (
    await get(`https://api.github.com/repos/${repo}/releases/latest`)
  ).json()) as { tag_name?: unknown };
  const tagsResponse = await get(`https://api.github.com/repos/${repo}/tags?per_page=100`);
  const latestRelease = unv(release.tag_name);
  const entry: ProviderFreshness = {
    id,
    tested,
    ...(SEMVER.test(latestRelease) ? { latestRelease } : {}),
  };
  // One page only: a list with a next page cannot name its highest tag.
  if (/\brel="next"/.test(tagsResponse.headers.get('link') ?? '')) {
    return { ...entry, reason: 'tag-list-truncated' };
  }
  const tags = (await tagsResponse.json()) as { name?: unknown }[];
  return {
    ...entry,
    highestTag: highest(
      tags.map((tag) => unv(tag.name)),
      options.includePrereleases ?? false,
    ),
  };
}

export async function checkFreshness(options: FreshnessOptions): Promise<FreshnessReport> {
  return {
    schemaVersion: 1,
    providers: [
      await npmFreshness('probity', '@nizos/probity', PROBITY_VERSION, options),
      await githubFreshness('spec-kit', 'github/spec-kit', SPEC_KIT_VERSION, options),
    ],
  };
}
