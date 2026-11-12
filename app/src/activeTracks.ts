// Which tracks the map highlights (MapView's feature-state `active`). Pure module.

/**
 * The highlighted tracks: replay suspends every highlight; otherwise a hover wins,
 * then an open same-route group, then the selection. Both the base-layer dimming
 * and the highlight layers read this, so they can never disagree.
 */
export function activeTrackIds(p: {
  replaying: boolean;
  hoverId: string | null;
  groupIds: readonly string[] | null;
  selectedId: string | null;
}): string[] {
  if (p.replaying) return [];
  if (p.hoverId != null) return [p.hoverId];
  if (p.groupIds && p.groupIds.length > 0) return [...p.groupIds];
  if (p.selectedId != null) return [p.selectedId];
  return [];
}
