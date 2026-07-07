export type MemoryChangeDiffLineOp = "context" | "add" | "remove";

export interface MemoryChangeDiffLine {
  readonly op: MemoryChangeDiffLineOp;
  readonly beforeLine: number | null;
  readonly afterLine: number | null;
  readonly text: string;
}

export interface MemoryChangeDiffHunk {
  readonly beforeStartLine: number | null;
  readonly afterStartLine: number | null;
  readonly lines: readonly MemoryChangeDiffLine[];
}

export interface MemoryChangeDiffStats {
  readonly added: number;
  readonly removed: number;
}

export interface MemoryChangeDiff {
  readonly format: "line";
  readonly beforeExists: boolean;
  readonly afterExists: boolean;
  readonly truncated: boolean;
  readonly stats: MemoryChangeDiffStats;
  readonly hunks: readonly MemoryChangeDiffHunk[];
  readonly omittedReason?: "too_large" | "binary" | "unsupported";
}
