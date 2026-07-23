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

export function substituteFileName(name: string, ctx: SubstitutionContext): string {
  return name
    .replaceAll('__PROJECT_NAME__', ctx.projectName)
    .replaceAll('__PROJECT_SCOPE__', ctx.projectScope)
    .replaceAll('__REGION__', ctx.region);
}
