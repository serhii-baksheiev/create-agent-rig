/**
 * A control or Unicode-format character (RTL override, zero-width joiner, an
 * ESC sequence, a bare CR/LF) inside a string that later reaches a screen a
 * maintainer reads before approving a write — a plan line, a manifest key, a
 * declared integration id. Extracted from `manifest.ts` (RP-22 S1) so a second
 * caller does not duplicate the predicate; the manifest's own behaviour and
 * tests are unchanged by the move (`.claude/rules/invariants.md`, "One
 * mechanism, one implementation").
 */
export function hasControlCharacter(value: string): boolean {
  const formatCharacter = /\p{Cf}/u;
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      formatCharacter.test(character)
    );
  });
}
