/** Shared result shapes for the presentation page capture paths. */

export interface PageGeometry {
  readonly width: number;
  readonly height: number;
}

export interface PageRecord {
  readonly page: number;
  readonly file: string;
  readonly document: string;
  readonly slide: number;
}

export interface RetakeRecord {
  readonly page: number;
  readonly attempts: number;
  readonly rejected: readonly string[];
}

export interface FailureRecord {
  readonly page: number;
  readonly document: string;
  readonly problems: readonly string[];
}

export interface CaptureSummary {
  readonly pages: PageRecord[];
  readonly retried: RetakeRecord[];
  readonly failed: FailureRecord[];
  /** How the pages were produced, reported so a run is reproducible. */
  readonly method: "agent-browser" | "libreoffice" | "poppler";
}
