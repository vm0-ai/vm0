import { expect, test } from "vitest";

import indexHtml from "../../../index.html?raw";
import { settingsIconAssetUrl } from "../../views/okou-page/components/settings/settings-icon-assets.ts";
import {
  avatarSvgAssetUrl,
  computerUseIllustrationImg,
  emptyArtifactImg,
  emptyAutomationsImg,
  emptyChatImg,
  emptySearchImg,
  emptyUsageImg,
  emptyWorkflowImg,
  noConnectorImg,
  noPermissionIllustration,
  planFreeImg,
  planProImg,
  planTeamImg,
} from "../../views/okou-page/platform-assets.ts";
import {
  platformFeishuAppCreatedCredentialsImg,
  platformFeishuAppIconImg,
  platformFeishuAvailabilitySettingsAllMembersImg,
  platformFeishuCreateEnterpriseCustomAppImg,
  platformFeishuEncryptionStrategyImg,
  platformFeishuEventRequestUrlImg,
  platformFeishuEventSubscriptionModeImg,
  platformFeishuPermissionsScopesBatchImportMenuImg,
  platformFeishuPermissionsScopesBatchImportReviewImg,
  platformFeishuSecuritySettingsRedirectUrlImg,
  platformFeishuVersionAvailabilityEditImg,
  platformFeishuVersionManagementCreateVersionImg,
} from "../static-assets.ts";

// `views/zero-page/` is a published object-key prefix on static.vm0.io, not a
// source directory. The objects live in vm0-ai/static-files, which is
// append-only and hard cached for a year, so they are never renamed even
// though the source directories that produced them are now `okou-page`.
// Rewriting one of these strings does not fail type-checking or bundling — the
// image simply 404s once a user opens the page.
const FROZEN_CDN_PREFIX = "/platform/views/zero-page/";
const OBJECT_KEY_STRING_LITERAL = /["'](views\/[^"'\n]*)/gu;

const SETTINGS_ICON_KEYS = [
  "anthropic",
  "azure",
  "bedrock",
  "chatglm",
  "claude-code",
  "deepseek",
  "github",
  "imessage",
  "kimi",
  "lark",
  "local-agent",
  "local-browser",
  "minimax",
  "openai",
  "openrouter",
  "slack",
  "teams",
  "telegram",
  "vercel",
  "vm0",
] as const;

const FEISHU_GUIDE_IMAGES = Object.freeze({
  platformFeishuAppCreatedCredentialsImg,
  platformFeishuAppIconImg,
  platformFeishuAvailabilitySettingsAllMembersImg,
  platformFeishuCreateEnterpriseCustomAppImg,
  platformFeishuEncryptionStrategyImg,
  platformFeishuEventRequestUrlImg,
  platformFeishuEventSubscriptionModeImg,
  platformFeishuPermissionsScopesBatchImportMenuImg,
  platformFeishuPermissionsScopesBatchImportReviewImg,
  platformFeishuSecuritySettingsRedirectUrlImg,
  platformFeishuVersionAvailabilityEditImg,
  platformFeishuVersionManagementCreateVersionImg,
});

const OKOU_PAGE_ILLUSTRATIONS = Object.freeze({
  computerUseIllustrationImg,
  emptyArtifactImg,
  emptyAutomationsImg,
  emptyChatImg,
  emptySearchImg,
  emptyUsageImg,
  emptyWorkflowImg,
  noConnectorImg,
  noPermissionIllustration,
  planFreeImg,
  planProImg,
  planTeamImg,
});

test("Generated avatar assets keep their published address", () => {
  expect(avatarSvgAssetUrl("head-1.svg")).toContain(
    `${FROZEN_CDN_PREFIX}assets/avatar-svg/`,
  );
});

test("The bootstrap loading illustration is inline", () => {
  const document = new DOMParser().parseFromString(indexHtml, "text/html");
  const skeleton = document.getElementById("app-bootstrap-skeleton");
  expect(
    skeleton?.querySelector(".app-bootstrap-skeleton__avatar-layers"),
  ).not.toBeNull();
  expect(skeleton?.querySelectorAll("path").length).toBeGreaterThan(0);
  expect(skeleton?.querySelector("img")).toBeNull();
});

test("Feishu setup-guide images remain available", () => {
  for (const url of Object.values(FEISHU_GUIDE_IMAGES)) {
    expect(url).toContain(FROZEN_CDN_PREFIX);
  }
});

test("Platform empty-state and plan images remain available", () => {
  for (const url of Object.values(OKOU_PAGE_ILLUSTRATIONS)) {
    expect(url).toContain(FROZEN_CDN_PREFIX);
  }
});

test("Settings provider icons remain available", () => {
  for (const key of SETTINGS_ICON_KEYS) {
    expect(settingsIconAssetUrl(key)).toContain(FROZEN_CDN_PREFIX);
  }
});

test("Published Platform images remain reachable after page renames", () => {
  // Object keys are written without a leading `./` or `../`, which is what
  // separates them from module specifiers pointing at the source directories.
  const OBJECT_KEY_LITERAL = /["'`](views\/[^"'`\n]*)/gu;

  const sources = import.meta.glob("../../**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  const renamedKeys: string[] = [];
  for (const [file, source] of Object.entries({
    ...sources,
    "index.html": indexHtml,
  })) {
    for (const match of source.matchAll(OBJECT_KEY_LITERAL)) {
      if (match[1]!.includes("okou-page")) {
        renamedKeys.push(`${file}: ${match[1]!}`);
      }
    }
  }
  expect(renamedKeys).toStrictEqual([]);

  const objectKeys = Object.entries(sources).flatMap(([file, source]) => {
    if (file.endsWith("/static-assets.test.ts")) {
      return [];
    }
    return [...source.matchAll(OBJECT_KEY_STRING_LITERAL)].map((match) => {
      return match[1]!;
    });
  });
  const pageKeys = objectKeys.filter((key) => {
    return key.startsWith("views/zero-page/");
  });
  expect(pageKeys).toHaveLength(33);
});
