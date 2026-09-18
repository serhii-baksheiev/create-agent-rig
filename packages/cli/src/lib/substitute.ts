/** The one universal-payload token: the repository directory's safe name. */
export interface SubstitutionContext {
  projectName: string;
}

export function substituteContent(content: string, ctx: SubstitutionContext): string {
  return content.replaceAll('__PROJECT_NAME__', ctx.projectName);
}
