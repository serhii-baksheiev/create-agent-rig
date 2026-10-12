import { PROBITY_VERSION } from './probity.js';

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
};
export type FreshnessReport = { schemaVersion: 1; providers: ProviderFreshness[] };
export type FreshnessOptions = {
  fetch: typeof globalThis.fetch;
  userAgent: string;
};

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function compare(a: string, b: string): number {
  const left = SEMVER.exec(a)!.slice(1).map(Number);
  const right = SEMVER.exec(b)!.slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return 0;
}

function highest(candidates: readonly string[]): string | undefined {
  return candidates
    .filter((value) => SEMVER.test(value))
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
    highestStable: highest(Object.keys(body.versions ?? {})),
  };
}

export async function checkFreshness(options: FreshnessOptions): Promise<FreshnessReport> {
  return {
    schemaVersion: 1,
    providers: [await npmFreshness('probity', '@nizos/probity', PROBITY_VERSION, options)],
  };
}
