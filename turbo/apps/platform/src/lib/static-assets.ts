const STATIC_ASSETS_BASE_URL = "https://static.vm0.io";

export function platformStaticAssetUrl(path: string) {
  return `${STATIC_ASSETS_BASE_URL}/platform/${path.replace(/^\/+/u, "")}`;
}

export const platformCheckmarkPrimaryImg = platformStaticAssetUrl(
  "checkmark-primary-52b8c1164a7c.svg",
);
export const platformEmptyPrivateAgentsImg = platformStaticAssetUrl(
  "views/agents-page/assets/empty-private-agents-9a8d7e3750b6.png",
);
export const platformVm0LogoImg = platformStaticAssetUrl(
  "assets/vm0-logo-56cf3090a186.svg",
);
export const platformVm0LogoDarkImg = platformStaticAssetUrl(
  "assets/vm0-logo-dark-f3de8c7713f8.svg",
);
