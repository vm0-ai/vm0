import type { PresentationPreviewDraft } from "../../views/zero-page/presentation-html-preview.ts";

export interface TemplatePreviewRuntime {
  readonly imagePreloads: Map<string, HTMLImageElement>;
  readonly presentation: {
    readonly drafts: Map<string, PresentationPreviewDraft>;
    readonly failed: Set<string>;
    readonly pendingLoads: Map<
      string,
      Promise<PresentationPreviewDraft | null>
    >;
    readonly activeTokens: Map<string, symbol>;
    readonly activeIndexes: Map<string, number>;
    readonly detailTokens: Map<string, symbol>;
    readonly pendingSlideAnimationFrames: Map<string, number>;
    readonly pendingSlideIndexes: Map<string, number>;
    readonly thumbnailHtmlByHost: WeakMap<HTMLDivElement, string>;
  };
  readonly illustration: {
    readonly decoded: Set<string>;
    readonly pendingDecodes: Map<string, Promise<void>>;
    readonly preloads: Map<string, HTMLImageElement>;
  };
}

export function createTemplatePreviewRuntime(): TemplatePreviewRuntime {
  return {
    imagePreloads: new Map<string, HTMLImageElement>(),
    presentation: {
      drafts: new Map<string, PresentationPreviewDraft>(),
      failed: new Set<string>(),
      pendingLoads: new Map<string, Promise<PresentationPreviewDraft | null>>(),
      activeTokens: new Map<string, symbol>(),
      activeIndexes: new Map<string, number>(),
      detailTokens: new Map<string, symbol>(),
      pendingSlideAnimationFrames: new Map<string, number>(),
      pendingSlideIndexes: new Map<string, number>(),
      thumbnailHtmlByHost: new WeakMap<HTMLDivElement, string>(),
    },
    illustration: {
      decoded: new Set<string>(),
      pendingDecodes: new Map<string, Promise<void>>(),
      preloads: new Map<string, HTMLImageElement>(),
    },
  };
}
