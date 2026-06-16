const DEFAULT_STATIC_ASSETS_BASE_URL = "https://static.vm7.io";

function staticAssetsBaseUrl() {
  return (
    process.env.NEXT_PUBLIC_STATIC_ASSETS_BASE_URL ??
    DEFAULT_STATIC_ASSETS_BASE_URL
  ).replace(/\/+$/u, "");
}

export function webStaticAssetUrl(path: string) {
  return `${staticAssetsBaseUrl()}/web/${path.replace(/^\/+/u, "")}`;
}
