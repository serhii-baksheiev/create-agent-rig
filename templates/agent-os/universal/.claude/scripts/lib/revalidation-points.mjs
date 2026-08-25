/**
 * The revalidation points — ONE spelling of the fact (AR-137).
 *
 * `queue/index.mjs next` writes the SELECT record; `revalidate.mjs` writes the
 * other two and answers outcomes at all three; `revalidation-report.mjs`
 * counts all three. Before this module each carried its own list, and one
 * computed a fourth (`['SELECT', ...POINTS]`). Four spellings of one fact is
 * how a point gets added to the report and not to the script, silently.
 *
 * `REVALIDATES` is DERIVED, not restated: the asymmetry that SELECT is written
 * elsewhere is encoded here once, where a reader looks for it.
 *
 * The prose that names these points is kept in step by a two-direction check —
 * the generator's test/template/correspondence.test.ts › "every point the
 * module knows is named by the loop or pr-ship skill, and vice versa".
 *
 * Maintenance and noise cost, recorded (AR-137): adding a point touches this
 * list and the prose that names it as `--point X` or `point: X`, and the check
 * says which side was forgotten. The check reads only the `loop` and `pr-ship`
 * skills — a point named anywhere else is invisible to it — and it parses
 * those two by that exact spelling, so a rewording breaks it loudly, as a named
 * failure, never silently.
 */

export const POINTS = Object.freeze(['SELECT', 'BEFORE_PR', 'BEFORE_CLOSE']);

/** What `revalidate.mjs` can revalidate itself: every point but SELECT. */
export const REVALIDATES = Object.freeze(POINTS.filter((point) => point !== 'SELECT'));
