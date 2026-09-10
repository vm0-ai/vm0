import { ILLUSTRATION_TEMPLATE_ITEMS } from "@okouai/core/illustration-template-items";
import { PRESENTATION_TEMPLATE_PICKER_ITEMS } from "@okouai/core/presentation-template-items";
import { VIDEO_TEMPLATE_ITEMS } from "@okouai/core/video-template-items";

// The existing official catalog owns these resources. Match complete URLs,
// never a static-host prefix that could admit unrelated executable HTML.
const officialPreviewUrls = Object.freeze([
  ...ILLUSTRATION_TEMPLATE_ITEMS.flatMap((item) => {
    return item.previewImages;
  }),
  ...PRESENTATION_TEMPLATE_PICKER_ITEMS.map((item) => {
    return item.embedUrl;
  }),
  ...VIDEO_TEMPLATE_ITEMS.map((item) => {
    return item.previewVideo;
  }),
]);

export function isOfficialTemplatePreviewUrl(url: string): boolean {
  return officialPreviewUrls.includes(url);
}
