import { isDesktopRendererUrl } from "./desktop-renderer-url";

/**
 * Whether a frame is one of the recorder overlay pages.
 *
 * The recorder windows load a different document from the main window, so the
 * Computer Use page check would reject them; they still have to be pinned to
 * the local renderer protocol rather than trusting any sender.
 */
export function isDesktopRecorderPageUrl(
  rawUrl: string,
  recorderUrl: string,
): boolean {
  return isDesktopRendererUrl(rawUrl, recorderUrl);
}
