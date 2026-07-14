import type { JsonValue } from "./shared";

export interface PresentationTemplateManifest {
  readonly version: 1;
  readonly templateId: string;
  readonly revisionNumber: number;
  readonly sourceVersionId: string;
  readonly compilerVersion: string;
  readonly slideCount: number;
  readonly aspectRatio: string;
  readonly fonts: readonly string[];
  readonly fontFallbacks: Readonly<Record<string, string>>;
  readonly colors: readonly string[];
  readonly excludedContent: readonly string[];
  readonly packageFiles: readonly string[];
  readonly metadata: Readonly<Record<string, JsonValue>>;
}
