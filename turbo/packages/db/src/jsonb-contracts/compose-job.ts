import type { JsonValue } from "./shared";

export interface ComposeJobResult {
  composeId: string;
  composeName: string;
  versionId: string;
  warnings: string[];
}

export type ComposeJobContent = JsonValue;
