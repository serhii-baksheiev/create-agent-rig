/**
 * Token substitution (PLAN.md §5.2). The token set is deliberately small:
 * - `__PROJECT_NAME__`  — the generated project's name (directory basename)
 * - `__PROJECT_SCOPE__` — the npm scope, without the leading `@`
 * - `__REGION__`        — the cloud region for targets that need one
 * - `@app/`             — the template's *valid* placeholder scope, rewritten to
 *                          `@<scope>/` so the template itself stays runnable
 */
export interface SubstitutionContext {
  projectName: string;
  projectScope: string;
  region: string;
}

export function substituteContent(content: string, ctx: SubstitutionContext): string {
  return content
    .replaceAll('__PROJECT_NAME__', ctx.projectName)
    .replaceAll('__PROJECT_SCOPE__', ctx.projectScope)
    .replaceAll('__REGION__', ctx.region)
    .replaceAll('@app/', `@${ctx.projectScope}/`);
}

/**
 * The inverse of {@link substituteContent}, used **only to recognise** an
 * installed file as a released version of its template: the released bytes
 * carry tokens, the installed bytes carry the project's own name, and without
 * this every token-carrying file (the kill switch, the loop skill, `CLAUDE.md`)
 * would be a permanent conflict on every rig.
 *
 * 🔴 Limits, and both of them fail in the safe direction — an unrecognised file
 * is reported and left alone, never overwritten:
 *
 * - `__PROJECT_SCOPE__` is not reversed. It substitutes to the same string as
 *   `__PROJECT_NAME__`, so the two are indistinguishable after the fact; the
 *   agent-os layer (the only layer an upgrade touches) uses neither the scope
 *   token nor `@app/` in prose, which a template test pins.
 * - A template that contains the project's name as a *literal* reverses into a
 *   token that was never there. That costs nothing on its own — recognition
 *   offers the untouched bytes as a candidate too, and those still match. It
 *   bites only on a file carrying **both** a token and the literal, which then
 *   reads as a conflict for that one project.
 */
export function detokenizeContent(content: string, ctx: SubstitutionContext): string {
  let out = content;
  // scope first: reversing the name first would rewrite `@name/` into
  // `@__PROJECT_NAME__/` and the scope form could never match afterwards
  if (ctx.projectScope !== '') out = out.replaceAll(`@${ctx.projectScope}/`, '@app/');
  if (ctx.region !== '') out = out.replaceAll(ctx.region, '__REGION__');
  if (ctx.projectName !== '') out = out.replaceAll(ctx.projectName, '__PROJECT_NAME__');
  return out;
}

/**
 * Files that must exist in the generated project under a dotted name, but are
 * stored un-dotted in the template because `npm publish` strips the dotted
 * original from tarballs (the create-react-app `gitignore` trick).
 */
const UNDOTTED_NAMES: Record<string, string> = {
  gitignore: '.gitignore',
};

export function substituteFileName(name: string, ctx: SubstitutionContext): string {
  const substituted = name
    .replaceAll('__PROJECT_NAME__', ctx.projectName)
    .replaceAll('__PROJECT_SCOPE__', ctx.projectScope)
    .replaceAll('__REGION__', ctx.region);
  return UNDOTTED_NAMES[substituted] ?? substituted;
}
