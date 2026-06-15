import { isDesktopRendererUrl } from "./desktop-renderer-url";

export function isDesktopComputerUsePageUrl(
  rawUrl: string,
  rendererUrl: string,
): boolean {
  return isDesktopRendererUrl(rawUrl, rendererUrl);
}
