import { z } from "zod";
import { initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

/**
 * Every desktop update line the `:product` routes accept.
 *
 * `ai-okou-desktop` is the only line the API still serves. `okou` and `zero`
 * are retired and their `:product` routes answer 404; `zero` is retired harder,
 * because the API can no longer name its manifest at all. They stay in the
 * union because it is not API-private — `apps/desktop/src/config.ts` validates
 * `desktop-identities.json`'s `updateLine` against it, and the desktop `zero`
 * identity that #31372 deliberately kept still declares `updateLine: "zero"`.
 * Keeping them here also lets a retired line answer a truthful 404 rather than
 * a path-param validation error.
 */
const DESKTOP_UPDATE_LINES = ["zero", "okou", "ai-okou-desktop"] as const;
export const DESKTOP_UPDATE_LINE_ZERO = DESKTOP_UPDATE_LINES[0];
export const DESKTOP_UPDATE_LINE_LEGACY_OKOU = DESKTOP_UPDATE_LINES[1];
export const DESKTOP_UPDATE_LINE_OKOU = DESKTOP_UPDATE_LINES[2];

const desktopUpdateChannelSchema = z.enum(["stable"]);
const desktopUpdatePlatformSchema = z.enum(["darwin"]);
const desktopUpdateArchitectureSchema = z.enum(["arm64"]);
const desktopUpdateLineSchema = z.enum(DESKTOP_UPDATE_LINES);
export const desktopZeroMigrationRolloutModeSchema = z.enum([
  "off",
  "soft",
  "hard",
]);
export const desktopZeroMigrationPolicySchema = z.object({
  schemaVersion: z.literal(1),
  mode: desktopZeroMigrationRolloutModeSchema,
});

export type DesktopUpdateChannel = z.infer<typeof desktopUpdateChannelSchema>;
export type DesktopUpdatePlatform = z.infer<typeof desktopUpdatePlatformSchema>;
export type DesktopUpdateArchitecture = z.infer<
  typeof desktopUpdateArchitectureSchema
>;
export type DesktopUpdateLine = z.infer<typeof desktopUpdateLineSchema>;
export type DesktopZeroMigrationRolloutMode = z.infer<
  typeof desktopZeroMigrationRolloutModeSchema
>;
export type DesktopZeroMigrationPolicy = z.infer<
  typeof desktopZeroMigrationPolicySchema
>;

const squirrelMacReleaseSchema = z.object({
  version: z.string(),
  updateTo: z.object({
    name: z.string(),
    version: z.string(),
    pub_date: z.string(),
    url: z.string().url(),
    notes: z.string(),
  }),
});

const squirrelMacReleasesSchema = z.object({
  currentRelease: z.string(),
  releases: z.array(squirrelMacReleaseSchema),
});

export type SquirrelMacReleases = z.infer<typeof squirrelMacReleasesSchema>;

export const desktopUpdatesContract = c.router({
  migrationPolicy: {
    method: "GET",
    path: "/api/desktop/migration-policy",
    responses: {
      200: desktopZeroMigrationPolicySchema,
    },
    summary: "Get the remotely controlled Zero Desktop migration policy",
  },
  releasePage: {
    method: "GET",
    path: "/api/desktop/updates/:channel/:platform/:arch/release",
    pathParams: z.object({
      channel: desktopUpdateChannelSchema,
      platform: desktopUpdatePlatformSchema,
      arch: desktopUpdateArchitectureSchema,
    }),
    responses: {
      302: c.noBody(),
      404: apiErrorSchema,
    },
    summary: "Redirect to the current desktop release page",
  },
  dmgDownload: {
    method: "GET",
    path: "/api/desktop/updates/:channel/:platform/:arch/dmg",
    pathParams: z.object({
      channel: desktopUpdateChannelSchema,
      platform: desktopUpdatePlatformSchema,
      arch: desktopUpdateArchitectureSchema,
    }),
    responses: {
      302: c.noBody(),
      404: apiErrorSchema,
    },
    summary: "Redirect to the current desktop DMG download",
  },
  productReleasePage: {
    method: "GET",
    path: "/api/desktop/updates/:product/:channel/:platform/:arch/release",
    pathParams: z.object({
      product: desktopUpdateLineSchema,
      channel: desktopUpdateChannelSchema,
      platform: desktopUpdatePlatformSchema,
      arch: desktopUpdateArchitectureSchema,
    }),
    responses: {
      302: c.noBody(),
      404: apiErrorSchema,
    },
    summary: "Redirect to an identity-specific desktop release page",
  },
  productDmgDownload: {
    method: "GET",
    path: "/api/desktop/updates/:product/:channel/:platform/:arch/dmg",
    pathParams: z.object({
      product: desktopUpdateLineSchema,
      channel: desktopUpdateChannelSchema,
      platform: desktopUpdatePlatformSchema,
      arch: desktopUpdateArchitectureSchema,
    }),
    responses: {
      302: c.noBody(),
      404: apiErrorSchema,
    },
    summary: "Redirect to an identity-specific desktop DMG download",
  },
  productFeed: {
    method: "GET",
    path: "/api/desktop/updates/:product/:channel/:platform/:arch/RELEASES.json",
    pathParams: z.object({
      product: desktopUpdateLineSchema,
      channel: desktopUpdateChannelSchema,
      platform: desktopUpdatePlatformSchema,
      arch: desktopUpdateArchitectureSchema,
    }),
    responses: {
      200: squirrelMacReleasesSchema,
      400: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get an identity-specific desktop auto-update feed",
  },
});
