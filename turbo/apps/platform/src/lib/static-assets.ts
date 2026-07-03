const DEFAULT_STATIC_ASSETS_BASE_URL = "https://static.vm7.io";

function staticAssetsBaseUrl() {
  return (
    (import.meta.env.VITE_STATIC_ASSETS_BASE_URL as string | undefined) ??
    DEFAULT_STATIC_ASSETS_BASE_URL
  ).replace(/\/+$/u, "");
}

export function platformStaticAssetUrl(path: string) {
  return `${staticAssetsBaseUrl()}/platform/${path.replace(/^\/+/u, "")}`;
}
