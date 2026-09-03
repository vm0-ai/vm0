const APP_ASSET_PATH_PREFIX = "/okou-app/assets/";
const WORKER_PREVIEW_HOST_SUFFIX = ".workers.dev";

export function resolveLocaleAssetUrl(
  resourceUrl: string,
  pageUrl = location.href,
): URL {
  const page = new URL(pageUrl);
  const resource = new URL(resourceUrl, page);

  if (
    page.hostname.endsWith(WORKER_PREVIEW_HOST_SUFFIX) &&
    resource.pathname.startsWith(APP_ASSET_PATH_PREFIX)
  ) {
    return new URL(`${resource.pathname}${resource.search}`, page.origin);
  }

  return resource;
}
