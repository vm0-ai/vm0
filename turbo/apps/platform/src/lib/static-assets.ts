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
export const platformFeishuCreateEnterpriseCustomAppImg =
  platformStaticAssetUrl(
    "views/zero-page/assets/feishu/create-enterprise-custom-app-bfcbb0ba2ffb.png",
  );
export const platformFeishuAppCreatedCredentialsImg = platformStaticAssetUrl(
  "views/zero-page/assets/feishu/app-created-credentials-e58acd598bca.png",
);
export const platformFeishuEventSubscriptionModeImg = platformStaticAssetUrl(
  "views/zero-page/assets/feishu/event-subscription-mode-ac2109302528.png",
);
export const platformFeishuEventRequestUrlImg = platformStaticAssetUrl(
  "views/zero-page/assets/feishu/event-request-url-de3be5a1b88b.png",
);
export const platformFeishuEncryptionStrategyImg = platformStaticAssetUrl(
  "views/zero-page/assets/feishu/encryption-strategy-e50ee6b26d77.png",
);
export const platformFeishuVersionManagementCreateVersionImg =
  platformStaticAssetUrl(
    "views/zero-page/assets/feishu/version-management-create-version-43e32042dc81.png",
  );
export const platformFeishuVersionAvailabilityEditImg = platformStaticAssetUrl(
  "views/zero-page/assets/feishu/version-availability-edit-5990fd6c7eae.png",
);
export const platformFeishuAvailabilitySettingsAllMembersImg =
  platformStaticAssetUrl(
    "views/zero-page/assets/feishu/availability-settings-all-members-2cf582a888ed.png",
  );
export const platformFeishuSecuritySettingsRedirectUrlImg =
  platformStaticAssetUrl(
    "views/zero-page/assets/feishu/security-settings-redirect-url-e7cf83ec76d4.png",
  );
