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

