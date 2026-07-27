export interface WebsiteTemplateItem {
  readonly id: `website-template:${string}`;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly templateId: `template:${string}`;
  readonly resourceId: `template:${string}`;
  readonly previewKind: "iframe";
  readonly previewUrl: string;
  readonly previewImageUrl: string;
  readonly sourcePath: string;
  readonly target: "website";
}

// Curated user-facing website picker catalog backed by vm0 private R2
// packages.
const WEBSITE_TEMPLATE_PREVIEW_BASE_URL =
  "https://static.vm0.io/vm0/artifact-templates/website/website-studio-v2-20260727-ccff774";

export const WEBSITE_TEMPLATE_ITEMS: readonly WebsiteTemplateItem[] = [
  {
    id: "website-template:black-slabs",
    slug: "black-slabs",
    title: "Black Slabs",
    description:
      "High-contrast editorial website template with monolithic typography, full-bleed showcase panels, metric cards, and electric-indigo accents.",
    templateId: "template:black-slabs",
    resourceId: "template:black-slabs",
    previewKind: "iframe",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/black-slabs-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/black-slabs-preview-480x270.webp`,
    sourcePath: "black-slabs",
    target: "website",
  },
  {
    id: "website-template:blueprint-grid",
    slug: "blueprint-grid",
    title: "Blueprint Grid",
    description:
      "Blueprint-inspired website template with oversized uppercase type, mono labels, ruled editorial grids, and cobalt navigation details.",
    templateId: "template:blueprint-grid",
    resourceId: "template:blueprint-grid",
    previewKind: "iframe",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/blueprint-grid-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/blueprint-grid-preview-480x270.webp`,
    sourcePath: "blueprint-grid",
    target: "website",
  },
  {
    id: "website-template:coastal-hotel",
    slug: "coastal-hotel",
    title: "Coastal Hotel",
    description:
      "Hospitality website template with a crest-style hero, postcard cards, coastal contour details, hairline lists, and travel editorial motion.",
    templateId: "template:coastal-hotel",
    resourceId: "template:coastal-hotel",
    previewKind: "iframe",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/coastal-hotel-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/coastal-hotel-preview-480x270.webp`,
    sourcePath: "coastal-hotel",
    target: "website",
  },
  {
    id: "website-template:dot-matrix",
    slug: "dot-matrix",
    title: "Dot Matrix",
    description:
      "Kinetic website template with LED dot-matrix imagery, an oversized organic wordmark, numbered service indexing, and scrolling tag marquees.",
    templateId: "template:dot-matrix",
    resourceId: "template:dot-matrix",
    previewKind: "iframe",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/dot-matrix-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/dot-matrix-preview-960x540.webp`,
    sourcePath: "dot-matrix",
    target: "website",
  },
  {
    id: "website-template:frame-stack",
    slug: "frame-stack",
    title: "Frame Stack",
    description:
      "Architectural website template with full-bleed connected frames, coordinate labels, axon-style hero blocks, and stacked scroll sections.",
    templateId: "template:frame-stack",
    resourceId: "template:frame-stack",
    previewKind: "iframe",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/frame-stack-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/frame-stack-preview-480x270.webp`,
    sourcePath: "frame-stack",
    target: "website",
  },
  {
    id: "website-template:frosted-scatter",
    slug: "frosted-scatter",
    title: "Frosted Scatter",
    description:
      "Frosted-glass website template with scattered parallax photography, a flashlight grid cursor, line-by-line copy, and oversized numeric storytelling.",
    templateId: "template:frosted-scatter",
    resourceId: "template:frosted-scatter",
    previewKind: "iframe",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/frosted-scatter-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/frosted-scatter-preview-960x540.webp`,
    sourcePath: "frosted-scatter",
    target: "website",
  },
  {
    id: "website-template:gallery-wall",
    slug: "gallery-wall",
    title: "Gallery Wall",
    description:
      "Art-forward website template with cream canvas, painterly texture, framed artwork modules, accession labels, and serif editorial rhythm.",
    templateId: "template:gallery-wall",
    resourceId: "template:gallery-wall",
    previewKind: "iframe",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/gallery-wall-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/gallery-wall-preview-480x270.webp`,
    sourcePath: "gallery-wall",
    target: "website",
  },
  {
    id: "website-template:glass-bloom",
    slug: "glass-bloom",
    title: "Glass Bloom",
    description:
      "Soft glassmorphism website template with frosted panels, blooming gradient light, italic serif accents, and pinned device storytelling.",
    templateId: "template:glass-bloom",
    resourceId: "template:glass-bloom",
    previewKind: "iframe",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/glass-bloom-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/glass-bloom-preview-480x270.webp`,
    sourcePath: "glass-bloom",
    target: "website",
  },
  {
    id: "website-template:serif-stack",
    slug: "serif-stack",
    title: "Serif Stack",
    description:
      "Minimal serif website template with stacked cover sections, playful gravity tag clouds, scattered photos, and a characterful footer.",
    templateId: "template:serif-stack",
    resourceId: "template:serif-stack",
    previewKind: "iframe",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/serif-stack-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/serif-stack-preview-480x270.webp`,
    sourcePath: "serif-stack",
    target: "website",
  },
  {
    id: "website-template:sticker-pop",
    slug: "sticker-pop",
    title: "Sticker Pop",
    description:
      "Playful website template with sticker cards, outlined serif type, warm cream palette, circular imagery, and sticky story panels.",
    templateId: "template:sticker-pop",
    resourceId: "template:sticker-pop",
    previewKind: "iframe",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/sticker-pop-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/sticker-pop-preview-480x270.webp`,
    sourcePath: "sticker-pop",
    target: "website",
  },
  {
    id: "website-template:warm-cards",
    slug: "warm-cards",
    title: "Warm Cards",
    description:
      "Playful website template with a numbered color-block sidebar, soft full-screen cards, image-led hero, ticker content, and oversized footer wordmark.",
    templateId: "template:warm-cards",
    resourceId: "template:warm-cards",
    previewKind: "iframe",
    previewUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/warm-cards-example.html`,
    previewImageUrl: `${WEBSITE_TEMPLATE_PREVIEW_BASE_URL}/warm-cards-preview-480x270.webp`,
    sourcePath: "warm-cards",
    target: "website",
  },
];

export function findWebsiteTemplateItem(
  id: string,
): WebsiteTemplateItem | undefined {
  return WEBSITE_TEMPLATE_ITEMS.find((item) => {
    return (
      item.id === id ||
      item.slug === id ||
      item.templateId === id ||
      item.resourceId === id
    );
  });
}
