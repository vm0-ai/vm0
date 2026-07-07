export interface WebsiteTemplateItem {
  readonly id: `website-template:${string}`;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly templateId: `template:${string}`;
  readonly resourceId: `template:${string}`;
  readonly previewKind: "iframe";
  readonly previewUrl: string;
  readonly sourcePath: string;
  readonly target: "website";
}

// Curated user-facing website picker catalog. Keep this separate from the
// generic Open Design website registry so feature-switched users only see vm0
// built-in R2-backed website templates.
export const WEBSITE_TEMPLATE_ITEMS: readonly WebsiteTemplateItem[] = [
  {
    id: "website-template:warm-cards",
    slug: "warm-cards",
    title: "Warm Cards",
    description:
      "Editorial website template with warm color blocks, rounded content cards, image-led sections, numbered navigation, and a bold footer wordmark.",
    templateId: "template:warm-cards",
    resourceId: "template:warm-cards",
    previewKind: "iframe",
    previewUrl:
      "https://static.vm0.io/vm0/artifact-templates/website/dbd6ac19-bed3-4abf-bb51-da0bead40914/warm-cards-example.html",
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
