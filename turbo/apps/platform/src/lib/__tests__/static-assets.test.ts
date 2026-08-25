import { describe, expect, it } from "vitest";

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

describe("published static asset URLs", () => {
  it.each(Object.entries(FEISHU_GUIDE_IMAGES))(
    "keeps the frozen CDN prefix for %s",
    (_name, url) => {
      expect(url).toContain(FROZEN_CDN_PREFIX);
    },
  );

  it.each(Object.entries(OKOU_PAGE_ILLUSTRATIONS))(
    "keeps the frozen CDN prefix for %s",
    (_name, url) => {
      expect(url).toContain(FROZEN_CDN_PREFIX);
    },
  );

  it.each(SETTINGS_ICON_KEYS)(
    "keeps the frozen CDN prefix for the %s settings icon",
    (key) => {
      expect(settingsIconAssetUrl(key)).toContain(FROZEN_CDN_PREFIX);
    },
  );

  it("keeps the frozen CDN prefix for generated avatar SVGs", () => {
    expect(avatarSvgAssetUrl("head-1.svg")).toContain(
      `${FROZEN_CDN_PREFIX}assets/avatar-svg/`,
    );
  });

  it("keeps the frozen CDN prefix in the bootstrap skeleton", () => {
    expect(indexHtml).toContain(`${FROZEN_CDN_PREFIX}assets/avatar-svg/`);
  });
});

describe("static asset object keys", () => {
  // Object keys are written without a leading `./` or `../`, which is what
  // separates them from module specifiers pointing at the source directories.
  const OBJECT_KEY_LITERAL = /["'`](views\/[^"'`\n]*)/gu;

  const sources = import.meta.glob("../../**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  it("never points a published object key at a renamed source directory", () => {
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
  });

  it("keeps all 32 published string-literal keys under zero-page", () => {
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
    expect(pageKeys).toHaveLength(32);
  });
});
