/**
 * Layer-composition policy (PLAN phase 9): layers must claim disjoint paths.
 * A collision is refused, never resolved silently by copy order. Intended
 * overwrites — if one ever becomes necessary — are declared here, visibly,
 * not implied by ordering.
 */
export const ALLOWED_OVERWRITES: ReadonlySet<string> = new Set([]);

export interface Layer {
  name: string;
  files: readonly string[];
}

export interface Collision {
  path: string;
  layers: string[];
}

export function detectCollisions(
  layers: readonly Layer[],
  allowed: ReadonlySet<string>,
): Collision[] {
  const claims = new Map<string, string[]>();
  for (const layer of layers) {
    for (const file of layer.files) {
      const owners = claims.get(file) ?? [];
      owners.push(layer.name);
      claims.set(file, owners);
    }
  }
  return [...claims]
    .filter(([file, owners]) => owners.length > 1 && !allowed.has(file))
    .map(([file, owners]) => ({ path: file, layers: owners }));
}
