// ---------------------------------------------------------------------------
// n8n types
// ---------------------------------------------------------------------------

export interface N8nNodeParameters {
  width?:  number;
  height?: number;
  [key: string]: unknown;
}

export interface N8nNode {
  name:        string;
  type:        string;
  position:    [number, number];
  parameters?: N8nNodeParameters;
}

export interface N8nConnection {
  node:   string;
  type?:  string;
  index?: number;
}

export type N8nBranch      = Array<N8nConnection | null> | null;
export type N8nChannels    = Record<string, N8nBranch[]>;
export type N8nConnections = Record<string, N8nChannels>;

export interface N8nWorkflow {
  nodes:       N8nNode[];
  connections: N8nConnections;
  _meta?:      { bypassNodes?: string[]; globalHandlers?: string[] };
}

// ---------------------------------------------------------------------------
// Internal layout types
// ---------------------------------------------------------------------------

export type Edge         = [string, string];
export type BranchedEdge = [string, string, number];

export interface LayoutPos {
  x: number;
  y: number;
}

export interface GridEntry {
  col: number;
  row: number;
}

export interface Section {
  sticky:  N8nNode;
  members: N8nNode[];
}

// ---------------------------------------------------------------------------
// Public relayout API types
// ---------------------------------------------------------------------------

export interface RelayoutOptions {
  config?: Partial<import("./config.js").LayoutConfig>;
  rankSep?: number;
  nodeSep?: number;
}

export interface RelayoutReport {
  totalNodes: number;
  nodesChanged: number;
  cyclicEdges: Edge[];
  globalHandlers: string[];
  warnings: string[];
}

export interface RelayoutResult {
  workflow: N8nWorkflow;
  report: RelayoutReport;
}
