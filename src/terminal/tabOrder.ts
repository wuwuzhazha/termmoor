/**
 * Reorder `items` according to `orderedIds`, ignoring unknown or duplicate IDs
 * and appending any existing items omitted from `orderedIds`.
 */
export function reorderByIds<T extends { id: string }>(
  items: readonly T[],
  orderedIds: readonly string[]
): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    byId.set(item.id, item);
  }
  const result: T[] = [];
  const seen = new Set<string>();
  for (const id of orderedIds) {
    if (seen.has(id)) {
      continue;
    }
    const found = byId.get(id);
    if (found) {
      seen.add(id);
      result.push(found);
    }
  }
  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      result.push(item);
    }
  }
  return result;
}
