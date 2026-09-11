// The composer's template catalog, shared by the template picker dialog and the
// slash panel. It owns the mapping from a catalog item to the generation
// template a message carries, so both surfaces select the same thing, and it
// derives the small preview model the slash panel renders.
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  type IllustrationTemplateItem,
} from "@okouai/core/illustration-template-items";
import {
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  type PresentationTemplateItem,
} from "@okouai/core/presentation-template-items";
import {
  VIDEO_TEMPLATE_ITEMS,
  type VideoTemplateItem,
} from "@okouai/core/video-template-items";
import {
  WEBSITE_TEMPLATE_ITEMS,
  type WebsiteTemplateItem,
} from "@okouai/core/website-template-items";
import { r2ImageTransformUrl } from "@okouai/core/r2-image-transform";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import type { ComposerTemplateAttachment } from "../../signals/okou-page/tiptap-workflow-composer.ts";

/** Falls back to the stylesheet's own default when an item pins no system. */
export function defaultPresentationTemplateThemeId(
  item: PresentationTemplateItem,
): string {
  return item.colorSystemId?.replace("color-system:", "") ?? "warm-sand";
}

export function presentationTemplateColorSystemId(themeId: string): string {
  return `color-system:${themeId}`;
}

export function toPresentationGenerationTemplate(
  item: PresentationTemplateItem,
  colorSystemId = presentationTemplateColorSystemId(
    defaultPresentationTemplateThemeId(item),
  ),
): GenerationTemplateRequest {
  return {
    type: "presentation",
    selection: {
      templateId: item.templateId,
      colorSystemId,
      previewUrl: item.embedUrl,
    },
  };
}

export function toIllustrationGenerationTemplate(
  item: IllustrationTemplateItem,
): GenerationTemplateRequest {
  return {
    type: "illustration",
    selection: {
      illustrationStyleId: item.illustrationStyleId,
    },
  };
}

/**
 * Text-to-video styles, not the talking-avatar options that share the "video"
 * envelope.
 */
export function toVideoGenerationTemplate(
  item: VideoTemplateItem,
): GenerationTemplateRequest {
  return {
    type: "video",
    selection: {
      stylePresetId: item.id,
    },
  };
}

export function toWebsiteGenerationTemplate(
  item: WebsiteTemplateItem,
): GenerationTemplateRequest {
  return {
    type: "website",
    selection: { websiteTemplateId: item.id },
  };
}

/**
 * The five things the slash panel indexes. These are the template picker's own
 * categories, so opening the picker from a row lands on the same tab.
 */
export const SLASH_TEMPLATE_CATEGORIES = [
  "slides",
  "illustration",
  "video",
  "website",
  "workflow",
] as const;

export type SlashTemplateCategory = (typeof SLASH_TEMPLATE_CATEGORIES)[number];

/**
 * Only these four carry cover art, so only these four open the detail pane.
 * Workflow templates are text, and a pane sized for covers would be mostly
 * empty for them.
 */
const SLASH_TEMPLATE_PREVIEW_CATEGORIES = [
  "slides",
  "illustration",
  "video",
  "website",
] as const;

export type SlashTemplatePreviewCategory =
  (typeof SLASH_TEMPLATE_PREVIEW_CATEGORIES)[number];

export function isSlashTemplatePreviewCategory(
  category: SlashTemplateCategory,
): category is SlashTemplatePreviewCategory {
  return SLASH_TEMPLATE_PREVIEW_CATEGORIES.some((candidate) => {
    return candidate === category;
  });
}

/** Covers render two across a 400px pane, so they are requested at 2x that. */
const SLASH_TEMPLATE_COVER_SIZE = { width: 360, height: 202 } as const;

/** The pane shows one screen of covers; the rest live in the picker dialog. */
const SLASH_TEMPLATE_PREVIEW_COUNT = 4;

export interface SlashTemplatePreview {
  readonly slug: string;
  readonly title: string;
  readonly coverUrl: string;
  readonly template: GenerationTemplateRequest;
  readonly attachment: ComposerTemplateAttachment;
}

export interface SlashTemplatePreviewGroup {
  readonly category: SlashTemplatePreviewCategory;
  /** Every template in the category, not just the previewed ones. */
  readonly total: number;
  readonly previews: readonly SlashTemplatePreview[];
}

function coverUrl(source: string): string {
  return r2ImageTransformUrl(source, SLASH_TEMPLATE_COVER_SIZE);
}

function presentationPreview(
  item: PresentationTemplateItem,
): SlashTemplatePreview {
  // `cardPreviewImage` is already the item's default color system, which is the
  // one a fresh selection uses.
  const cover = coverUrl(item.cardPreviewImage ?? item.previewImage);
  return {
    slug: item.slug,
    title: item.title,
    coverUrl: cover,
    template: toPresentationGenerationTemplate(item),
    attachment: {
      type: "presentation",
      title: item.title,
      category: "slides",
      previewImageUrl: cover,
    },
  };
}

function illustrationPreview(
  item: IllustrationTemplateItem,
): SlashTemplatePreview {
  const cover = coverUrl(item.cardPreviewImage ?? item.previewImage);
  return {
    slug: item.slug,
    title: item.title,
    coverUrl: cover,
    template: toIllustrationGenerationTemplate(item),
    attachment: {
      type: "illustration",
      title: item.title,
      category: "illustration",
      previewImageUrl: cover,
    },
  };
}

function videoPreview(item: VideoTemplateItem): SlashTemplatePreview {
  return {
    slug: item.slug,
    title: item.title,
    coverUrl: coverUrl(item.cardPreviewImage ?? item.previewImage),
    template: toVideoGenerationTemplate(item),
    // Video and website chips carry no cover in the composer today; the panel
    // shows the poster frame without changing what the chip stores.
    attachment: {
      type: "video",
      title: item.title,
      category: "video",
    },
  };
}

function websitePreview(item: WebsiteTemplateItem): SlashTemplatePreview {
  return {
    slug: item.slug,
    title: item.title,
    coverUrl: coverUrl(item.previewImageUrl),
    template: toWebsiteGenerationTemplate(item),
    attachment: {
      type: "website",
      title: item.title,
      category: "website",
    },
  };
}

function previewsFor(
  category: SlashTemplatePreviewCategory,
): readonly SlashTemplatePreview[] {
  switch (category) {
    case "slides": {
      return PRESENTATION_TEMPLATE_PICKER_ITEMS.slice(
        0,
        SLASH_TEMPLATE_PREVIEW_COUNT,
      ).map(presentationPreview);
    }
    case "illustration": {
      return ILLUSTRATION_TEMPLATE_ITEMS.slice(
        0,
        SLASH_TEMPLATE_PREVIEW_COUNT,
      ).map(illustrationPreview);
    }
    case "video": {
      return VIDEO_TEMPLATE_ITEMS.slice(0, SLASH_TEMPLATE_PREVIEW_COUNT).map(
        videoPreview,
      );
    }
    case "website": {
      return WEBSITE_TEMPLATE_ITEMS.slice(0, SLASH_TEMPLATE_PREVIEW_COUNT).map(
        websitePreview,
      );
    }
  }
}

function totalFor(category: SlashTemplatePreviewCategory): number {
  switch (category) {
    case "slides": {
      return PRESENTATION_TEMPLATE_PICKER_ITEMS.length;
    }
    case "illustration": {
      return ILLUSTRATION_TEMPLATE_ITEMS.length;
    }
    case "video": {
      return VIDEO_TEMPLATE_ITEMS.length;
    }
    case "website": {
      return WEBSITE_TEMPLATE_ITEMS.length;
    }
  }
}

export function slashTemplatePreviewGroup(
  category: SlashTemplatePreviewCategory,
): SlashTemplatePreviewGroup {
  return {
    category,
    total: totalFor(category),
    previews: previewsFor(category),
  };
}
