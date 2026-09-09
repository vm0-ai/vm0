import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { derivePlatformServiceOrigin } from "@okouai/core/platform-service-origin";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { findVideoTemplateItem } from "@okouai/core/video-template-items";
import { command, computed, type Computed } from "ccstate";
import type { Element, Root } from "hast";
import { SKIP, visit } from "unist-util-visit";

import { i18n } from "../../i18n/index.ts";
import {
  markdownCardKey,
  parseMarkdownTree,
} from "../../lib/markdown/pipeline.ts";
import { createAttachmentResourceUrlResolver } from "../attachment-resource-url.ts";
import { assistantName$ } from "../branding.ts";
import {
  createArtifactCardSignalsRegistry,
  createArtifactPreviewImageUrls$,
  type ArtifactDescriptor,
} from "../chat-page/artifact-card-signals.ts";
import type { MarkdownCardRef } from "../chat-page/markdown-card-ref.ts";
import { locale$ } from "../locale.ts";
import {
  createMermaidDiagramSignals,
  embedMermaidSignals,
} from "../mermaid-diagram.ts";
import { ROUTES } from "../route-paths.ts";

/** Slot URLs for the two welcome-only explanatory cards. */
const TEAM_DIAGRAM_SLOT = "okou://welcome-diagram/team";
const SLACK_DIAGRAM_SLOT = "okou://welcome-diagram/slack";
const WELCOME_THREAD_ID = "welcome";

const welcomeImage = ILLUSTRATION_TEMPLATE_ITEMS.find(({ slug }) => {
  return slug === "sunlit-gouache";
});
if (!welcomeImage) {
  throw new Error("Missing sunlit-gouache welcome illustration");
}
const welcomeImageUrl = welcomeImage.previewImages[0];
if (!welcomeImageUrl) {
  throw new Error("Missing sunlit-gouache welcome illustration reference");
}

const welcomePresentation = PRESENTATION_TEMPLATE_PICKER_ITEMS.find(
  ({ slug }) => {
    return slug === "playful-launch-presentation";
  },
);
if (!welcomePresentation) {
  throw new Error("Missing playful-launch-presentation welcome artifact");
}
const welcomePresentationSlideCount = welcomePresentation.slideCount;
if (welcomePresentationSlideCount === undefined) {
  throw new Error("Missing playful-launch-presentation slide count");
}

const welcomeVideo = findVideoTemplateItem("video-template:epic-grandeur");
if (!welcomeVideo) {
  throw new Error("Missing epic-grandeur welcome artifact");
}

function markdownResourceUrl(node: Element): string | undefined {
  const value =
    node.tagName === "a"
      ? node.properties.href
      : node.tagName === "img"
        ? node.properties.src
        : undefined;
  return typeof value === "string" ? value : undefined;
}

/** Inline images and text links use the same cards as a regular chat event. */
function embedWelcomeArtifactCards(
  tree: Root,
  cards: ReadonlyMap<string, MarkdownCardRef>,
): void {
  visit(tree, "element", (node) => {
    if (node.data?.card) {
      return SKIP;
    }
    const url = markdownResourceUrl(node);
    const card = url ? cards.get(markdownCardKey(url)) : undefined;
    if (card?.kind === "artifact") {
      node.data = { ...node.data, card };
    }
    return undefined;
  });
}

export interface WelcomeThreadContentSignals {
  readonly tree$: Computed<Root>;
}

/**
 * Prepare one route-owned welcome message. Artifact signals are registered
 * before rendering, while each localized tree owns its Mermaid previews for
 * the lifetime of the route.
 */
export const createWelcomeThreadContentSignals$ = command(
  ({ set }, ownerSignal: AbortSignal): WelcomeThreadContentSignals => {
    const previewImageUrls$ = createArtifactPreviewImageUrls$([
      [welcomePresentation.embedUrl, welcomePresentation.previewImage],
      [welcomeVideo.previewVideo, welcomeVideo.previewImage],
    ]);
    const artifactSignals = createArtifactCardSignalsRegistry(
      previewImageUrls$,
      createAttachmentResourceUrlResolver(),
    );
    const artifactCard = (
      descriptor: ArtifactDescriptor,
    ): Extract<MarkdownCardRef, { kind: "artifact" }> => {
      return {
        kind: "artifact",
        signals: set(artifactSignals.register$, descriptor),
        threadId: WELCOME_THREAD_ID,
      };
    };
    const cards: ReadonlyMap<string, MarkdownCardRef> = new Map<
      string,
      MarkdownCardRef
    >([
      [
        markdownCardKey(welcomeImageUrl),
        artifactCard({
          filename: "campaign-visual.jpg",
          kind: "image",
          url: welcomeImageUrl,
        }),
      ],
      [
        markdownCardKey(welcomePresentation.embedUrl),
        artifactCard({
          filename: "sproutpop-launch-deck.html",
          kind: "html",
          url: welcomePresentation.embedUrl,
        }),
      ],
      [
        markdownCardKey(welcomeVideo.previewVideo),
        artifactCard({
          filename: "product-launch-film.mp4",
          kind: "video",
          url: welcomeVideo.previewVideo,
        }),
      ],
      [
        markdownCardKey(TEAM_DIAGRAM_SLOT),
        { kind: "welcome-diagram", diagram: "team" },
      ],
      [
        markdownCardKey(SLACK_DIAGRAM_SLOT),
        { kind: "welcome-diagram", diagram: "slack" },
      ],
    ]);
    const tree$ = computed((get): Root => {
      get(locale$);
      const origin = window.location.origin;
      const source = i18n.t(
        ($) => {
          return $.chat.welcomeThread.content;
        },
        {
          assistantName: get(assistantName$),
          docsUrl: `${derivePlatformServiceOrigin(origin, "www")}/docs`,
          imageUrl: welcomeImageUrl,
          inviteUrl: `${origin}/?settings=people`,
          presentationPreviewUrl: welcomePresentation.embedUrl,
          presentationUrl: welcomePresentation.embedUrl,
          slackDiagramUrl: SLACK_DIAGRAM_SLOT,
          slideCount: welcomePresentationSlideCount,
          teamDiagramUrl: TEAM_DIAGRAM_SLOT,
          videoUrl: welcomeVideo.previewVideo,
          worksUrl: `${origin}${ROUTES.works}`,
        },
      );
      const tree = parseMarkdownTree(source, { cards, mermaid: true });
      embedWelcomeArtifactCards(tree, cards);
      embedMermaidSignals(tree, (code) => {
        return createMermaidDiagramSignals(code, ownerSignal);
      });
      return tree;
    });
    return { tree$ };
  },
);
