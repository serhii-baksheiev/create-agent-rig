# Stack rules — Node + TypeScript

Conventions for this runtime. The universal rules say *what* the boundaries
are; this file says how they are expressed in TypeScript.

## Language

- Strict TypeScript everywhere: `strict`, `noUncheckedIndexedAccess`. Lint and
  typecheck are gates, not advice.
- ESM with NodeNext resolution — relative imports carry the `.js` suffix.
- `any` is a code smell; `unknown` plus narrowing is the tool. Casts are rare
  and always commented with why.
- Schemas (zod) sit at every boundary where outside data enters: transport
  payloads, queue messages, environment, storage reads.

## Dependencies

- Zero-dependency bias: reach for `node:` builtins first. Every new runtime
  dependency is a Tier-2 decision (see `autonomy.md`) — it must be argued for,
  not just installed.
- Workspace packages export TypeScript source directly (`main: src/index.ts`);
  services bundle at their edge. No internal build step, no `dist/` juggling.

## Testing (vitest)

- Tests live in each package's `test/`, named `*.test.ts`, and describe
  behavior ("refuses an empty title"), not method names.
- Test doubles are hand-written structural stubs against consumer-owned
  interfaces — no mocking framework, no patching of module internals.
- Determinism is non-negotiable: inject the clock and id generation (the pure
  core already forces this). A test that needs a sleep is a design smell.

## Errors and logging

- Everything that crosses a layer is a typed error from `@…/shared`
  (`AppError` and friends); handlers map types to transport codes, never
  string-match messages.
- Logs are structured JSON lines through the shared logger — no bare
  `console.log` in service code.

## Confirming the merge criterion (GitHub Actions)

`workflow.md` states the criterion provider-neutrally: confirm the required
check completed **for this commit**. Here that is concrete — and it matters
because `gh pr checks --watch` can exit successfully while checks are still
*unregistered*, reporting a green wall that has not been built yet.

Poll the check runs for the PR's head SHA and require the named check to have
`conclusion: success`, not merely "not failing":

```sh
SHA=$(gh pr view --json headRefOid -q .headRefOid)
gh api "repos/{owner}/{repo}/commits/$SHA/check-runs" \
  -q '.check_runs[] | select(.name=="ci") | .conclusion'
# must print: success   (a result set containing only a scanner is NOT done)
```

**A head that gets no run at all is a third state, not a slow one.** A
`pull_request` push can register no workflow run and emit no failure signal —
the head sits with a scanner only, and the poll above waits forever while the
previous head's green sits one line up in the same PR (AR-149: `69b5d65` on
#130 got no `ci` run; `8ca26e7` on #134 got `ci` and no `e2e`). Tell "not
registered" apart from "pending" by asking for runs by head, not by PR:

```sh
gh api "repos/{owner}/{repo}/actions/runs?head_sha=$SHA" \
  -q '.workflow_runs[] | "\(.name) \(.event) \(.status) \(.conclusion)"'
# one line per workflow that ran for THIS sha; a required workflow missing
# here after a bounded wait (a few minutes) is not registered, not pending
```

⚠ The names differ in case between the two queries: `workflow_runs[].name`
is the **workflow** name (`CI`, `E2E`), the check-runs filter above reads the
**job** name (`ci`, `e2e`). Searching the runs list for `ci` finds nothing.

Then the rule, **per required check by name**, never per head: a check with
no run after the wait is **retriggered**, and the PR is **never merged on an
older head's green**. The retrigger depends on the workflow — `ci.yml` has no
`workflow_dispatch`, so an empty commit (`git commit --allow-empty`) is the
simplest trigger it has; `e2e.yml` has one, so
`gh workflow run e2e.yml --ref <branch>` re-runs it on the same head. Pinned
in the generator's `test/template/pr-flow.test.ts` — absent in a generated
rig — › "node-ts names the head that gets no run at all, and says it is
retriggered rather than waited on" and › "the no-run branch is stated per
required check, not per head".

