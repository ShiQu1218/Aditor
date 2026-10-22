// Pure selection math for the library multi-select mode. Every function returns a new Set; pruneSelection
// returns the same instance when nothing was dropped so React can skip the state update.

/** Add or remove one path. */
export function toggleOne(selected: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(selected)
  if (next.has(path)) next.delete(path)
  else next.add(path)
  return next
}

/** True when every given path is selected; an empty list is not "all selected". */
export function isAllSelected(selected: ReadonlySet<string>, paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every((path) => selected.has(path))
}

/** Select every path in the group, or deselect all of them when the whole group is already selected. */
export function toggleGroup(selected: ReadonlySet<string>, paths: readonly string[]): Set<string> {
  const next = new Set(selected)
  if (isAllSelected(selected, paths)) {
    for (const path of paths) next.delete(path)
  } else {
    for (const path of paths) next.add(path)
  }
  return next
}

/** Add every path to the selection (already-selected paths are kept). */
export function selectAll(selected: ReadonlySet<string>, paths: readonly string[]): Set<string> {
  const next = new Set(selected)
  for (const path of paths) next.add(path)
  return next
}

/** Drop paths that no longer exist in the library; return the same Set instance when nothing changed. */
export function pruneSelection(selected: Set<string>, existingPaths: Iterable<string>): Set<string> {
  const existing = existingPaths instanceof Set ? existingPaths : new Set(existingPaths)
  let next: Set<string> | null = null
  for (const path of selected) {
    if (existing.has(path)) continue
    if (next === null) next = new Set(selected)
    next.delete(path)
  }
  return next ?? selected
}
