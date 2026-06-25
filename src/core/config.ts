// ---------------------------------------------------------------------------
// Layout configuration — constants, interface, and pure helper functions
// ---------------------------------------------------------------------------

export interface LayoutConfig {
  /** Grid snap size in px (R2). n8n canvas snaps to this value. */
  grid: number;
  /** Vertical step between rows within a section (R8). */
  rowStep: number;
  /** Y offset of the routing-lane row 0 inside a sticky note (R8). */
  topPad: number;
  /** Distance from sticky left edge to first column of nodes (R7). */
  leftIndent: number;
  /** Minimum horizontal gap between node right edge and next node left edge (R7). */
  minGap: number;
  /** Gap between sticky right edge and the next sticky left edge (R8). */
  sectionGap: number;
  /** Minimum column-distance for an edge to be considered a "skip" (R12/R13). */
  skipColThreshold: number;
}

export const DEFAULT_CONFIG: LayoutConfig = {
  grid: 20,
  rowStep: 200,
  topPad: 80,
  leftIndent: 120,
  minGap: 100,
  sectionGap: 80,
  skipColThreshold: 3,
};

/**
 * Build a LayoutConfig by merging caller-supplied overrides on top of
 * DEFAULT_CONFIG.  Omitted fields fall back to their default values.
 */
export function buildLayoutConfig(overrides?: Partial<LayoutConfig>): LayoutConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/**
 * Snap a value to the nearest grid unit (R2).
 */
export function snap(v: number, config: LayoutConfig): number {
  return Math.round(v / config.grid) * config.grid;
}

/**
 * Compute the absolute y coordinate for a given row index inside a section (R8).
 * Row 0 is the routing lane; row 1 is the primary flow lane, etc.
 */
export function sectionRowY(row: number, config: LayoutConfig): number {
  return config.topPad + row * config.rowStep;
}
