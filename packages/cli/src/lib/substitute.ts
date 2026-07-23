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
