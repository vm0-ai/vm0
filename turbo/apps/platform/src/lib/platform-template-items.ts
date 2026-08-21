import {
  ILLUSTRATION_TEMPLATE_ITEMS as CANONICAL_ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS as CANONICAL_PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS as CANONICAL_VIDEO_TEMPLATE_ITEMS,
  WEBSITE_TEMPLATE_ITEMS as CANONICAL_WEBSITE_TEMPLATE_ITEMS,
  findVideoTemplateItem as findCanonicalVideoTemplateItem,
  findWebsiteTemplateItem as findCanonicalWebsiteTemplateItem,
  type IllustrationTemplateItem,
  type PresentationTemplateItem,
  type VideoTemplateItem,
  type WebsiteTemplateItem,
} from "@okouai/core";

import { platformPublicStaticUrl } from "./static-assets.ts";

export const PRESENTATION_TEMPLATE_PICKER_ITEMS: readonly PresentationTemplateItem[] =
  CANONICAL_PRESENTATION_TEMPLATE_PICKER_ITEMS.map((item) => {
    return {
      ...item,
      embedUrl: platformPublicStaticUrl(item.embedUrl),
      previewImage: platformPublicStaticUrl(item.previewImage),
      previewImages: item.previewImages.map(platformPublicStaticUrl),
      ...(item.cardPreviewImage === undefined
        ? {}
        : { cardPreviewImage: platformPublicStaticUrl(item.cardPreviewImage) }),
      ...(item.cardPreviewImagesByTheme === undefined
        ? {}
        : {
            cardPreviewImagesByTheme: Object.fromEntries(
              Object.entries(item.cardPreviewImagesByTheme).map(
                ([theme, url]) => {
                  return [theme, platformPublicStaticUrl(url)];
                },
              ),
            ),
          }),
      ...(item.previewHtmls === undefined
        ? {}
        : {
            previewHtmls: item.previewHtmls.map(platformPublicStaticUrl),
          }),
    };
  });

export const ILLUSTRATION_TEMPLATE_ITEMS: readonly IllustrationTemplateItem[] =
  CANONICAL_ILLUSTRATION_TEMPLATE_ITEMS.map((item) => {
    return {
      ...item,
      previewImage: platformPublicStaticUrl(item.previewImage),
      previewImages: item.previewImages.map(platformPublicStaticUrl),
      ...(item.cardPreviewImage === undefined
        ? {}
        : { cardPreviewImage: platformPublicStaticUrl(item.cardPreviewImage) }),
    };
  });

export const VIDEO_TEMPLATE_ITEMS: readonly VideoTemplateItem[] =
  CANONICAL_VIDEO_TEMPLATE_ITEMS.map((item) => {
    return {
      ...item,
      previewImage: platformPublicStaticUrl(item.previewImage),
      previewVideo: platformPublicStaticUrl(item.previewVideo),
      previewWebm: platformPublicStaticUrl(item.previewWebm),
      ...(item.cardPreviewImage === undefined
        ? {}
        : { cardPreviewImage: platformPublicStaticUrl(item.cardPreviewImage) }),
    };
  });

export const WEBSITE_TEMPLATE_ITEMS: readonly WebsiteTemplateItem[] =
  CANONICAL_WEBSITE_TEMPLATE_ITEMS.map((item) => {
    return {
      ...item,
      previewUrl: platformPublicStaticUrl(item.previewUrl),
      previewImageUrl: platformPublicStaticUrl(item.previewImageUrl),
    };
  });

export function findVideoTemplateItem(
  idOrSlug: string,
): VideoTemplateItem | undefined {
  const id = findCanonicalVideoTemplateItem(idOrSlug)?.id;
  return VIDEO_TEMPLATE_ITEMS.find((item) => {
    return item.id === id;
  });
}

export function findWebsiteTemplateItem(
  idOrSlug: string,
): WebsiteTemplateItem | undefined {
  const id = findCanonicalWebsiteTemplateItem(idOrSlug)?.id;
  return WEBSITE_TEMPLATE_ITEMS.find((item) => {
    return item.id === id;
  });
}
