# Reproducing a candidate's source identity

A freeze record can identify the exact commit and tree, together with the
accepted package's `npm pack --json` shasum, integrity and file count. Preserve
the produced tarball and pack output. A source-archive digest is useful when
its exact production recipe and artifact are retained with that evidence.
Package and source archives describe different file sets: `npm pack` uses the
package's `files` and lifecycle, while `git archive` reads the selected Git tree.

This recipe supplies source-archive evidence. Candidate tests, installation,
upgrade, packed acceptance, independent reviews and the owner's publication
boundary retain their existing requirements.

## An explicit archive recipe

Run the following in Bash from this repository. The worked example selects
the already frozen 1.7.1 source. For a future candidate, replace `candidate_sha`
with its full accepted 40-character commit SHA and retain the resulting command
and output with that candidate's evidence.

```bash
set -euo pipefail
candidate_sha=3e927da1389f205acc1406f2b431379cedd931fe
if [[ ! "$candidate_sha" =~ ^[0-9a-f]{40}$ ]]; then
  printf '%s\n' 'candidate_sha must be a full lowercase 40-character commit SHA' >&2
  exit 2
fi
resolved_sha=$(git rev-parse --verify "${candidate_sha}^{commit}")
[[ "$resolved_sha" == "$candidate_sha" ]]
source_tree=$(git rev-parse --verify "${candidate_sha}^{tree}")
artifact_dir=$(mktemp -d "${TMPDIR:-/tmp}/rig-source-archive.XXXXXX")
git --version > "$artifact_dir/git-version.txt"
printf 'commit=%s\ntree=%s\n' "$candidate_sha" "$source_tree" \
  > "$artifact_dir/source-identity.txt"
git archive --format=tar --prefix="create-agent-rig-${candidate_sha}/" \
  --output="$artifact_dir/source.tar" "$candidate_sha"
git archive --format=tar --prefix="create-agent-rig-${candidate_sha}/" \
  --output="$artifact_dir/source-repeated.tar" "$candidate_sha"
cmp "$artifact_dir/source.tar" "$artifact_dir/source-repeated.tar"
git get-tar-commit-id < "$artifact_dir/source.tar" \
  > "$artifact_dir/archive-commit.txt"
[[ "$(cat "$artifact_dir/archive-commit.txt")" == "$candidate_sha" ]]
shasum -a 256 "$artifact_dir/source.tar" "$artifact_dir/source-repeated.tar" \
  > "$artifact_dir/source-sha256.txt"
printf 'Evidence directory: %s\n' "$artifact_dir"
```

Retain the exact expanded `git archive` command, Git version, commit, tree,
format, prefix, digest, byte-comparison result and archive itself. The command
selects tracked content from the named commit independently of working-tree
edits. Its explicit uncompressed tar format avoids an unspecified compressor;
changing the prefix, format, source or Git implementation requires a fresh
measurement. Matching outputs here establish repeatability for that recipe
and environment, without promising identical archive bytes across Git versions.

## Measured 1.7.1 example and historical limit

On 2026-10-19, Git 2.47.1 produced two byte-identical tar archives using the
command above, for:

- Commit: `3e927da1389f205acc1406f2b431379cedd931fe`.
- Tree: `25eb9595543e1128d62591a7e234bda32ca522e7`.
- Prefix: `create-agent-rig-3e927da1389f205acc1406f2b431379cedd931fe/`.
- SHA-256: `923899496ce5b17c9af449cdc899df21c444582413256713b79fe1e91ad6a422`.

The later historical `release-candidate-freeze` entry in
[RP-504's decision record](../.rig/decisions/RP-504.jsonl) cites this candidate
and a different digest,
`28b5bf05509eed95f50539560361723faaf654b2b4bbf809129698c8d47c6100`, without
its production recipe. Commit
`48e77304eadcb4410a01b3be310e240f3a0c8495` added that entry after the frozen
candidate; the entry and digest are absent from the candidate tree itself.
The original recipe remains **unknown**. A digest mismatch with this newly
specified recipe establishes neither corruption nor a changed candidate tree.
Keep the historical record and candidate identity intact.

For a future freeze, cite the recipe actually executed, or omit a source-archive
digest and retain the exact commit, tree and accepted package's pack evidence.
The example above supplies no new package, test or release-acceptance result.
