/**
 * RP-445: how an installed provider version relates to the Rig-tested default
 * and to the repository's own exact declaration, if any. `tested` — it is the
 * version Rig was tested against; `overridden` — it is the different exact
 * version the repository deliberately declares; `drift` — it is neither the
 * declaration nor, without one, the Rig-tested default; `unknown` — nothing
 * installed could be read.
 */
export type VersionState = 'tested' | 'overridden' | 'drift' | 'unknown';
export type VersionClassification = {
  state: VersionState;
  tested: string;
  declared?: string;
  installed?: string;
};

export function classifyVersion(input: {
  tested: string;
  declared?: string;
  installed?: string;
}): VersionClassification {
  const { tested, declared, installed } = input;
  const state: VersionState =
    installed === undefined
      ? 'unknown'
      : installed !== (declared ?? tested)
        ? 'drift'
        : declared !== undefined && declared !== tested
          ? 'overridden'
          : 'tested';
  return {
    state,
    tested,
    ...(declared === undefined ? {} : { declared }),
    ...(installed === undefined ? {} : { installed }),
  };
}
