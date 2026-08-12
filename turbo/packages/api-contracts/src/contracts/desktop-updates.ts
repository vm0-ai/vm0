import { z } from "zod";
import { initContract } from "./base";
import { DESKTOP_PRODUCTS } from "./client-headers";
import { apiErrorSchema } from "./errors";

const c = initContract();

const desktopUpdateChannelSchema = z.enum(["stable"]);
const desktopUpdatePlatformSchema = z.enum(["darwin"]);
const desktopUpdateArchitectureSchema = z.enum(["arm64"]);
const desktopUpdateProductSchema = z.enum(DESKTOP_PRODUCTS);

export type DesktopUpdateChannel = z.infer<typeof desktopUpdateChannelSchema>;
export type DesktopUpdatePlatform = z.infer<typeof desktopUpdatePlatformSchema>;
export type DesktopUpdateArchitecture = z.infer<
  typeof desktopUpdateArchitectureSchema
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
  releasePage: {
    method: "GET",
    path: "/api/zero/desktop/updates/:channel/:platform/:arch/release",
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
    path: "/api/zero/desktop/updates/:channel/:platform/:arch/dmg",
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
  feed: {
    method: "GET",
    path: "/api/desktop/updates/:channel/:platform/:arch/RELEASES.json",
    pathParams: z.object({
      channel: desktopUpdateChannelSchema,
      platform: desktopUpdatePlatformSchema,
      arch: desktopUpdateArchitectureSchema,
    }),
    responses: {
      200: squirrelMacReleasesSchema,
      400: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get the desktop auto-update feed",
  },
  productReleasePage: {
    method: "GET",
    path: "/api/desktop/updates/:product/:channel/:platform/:arch/release",
    pathParams: z.object({
      product: desktopUpdateProductSchema,
      channel: desktopUpdateChannelSchema,
      platform: desktopUpdatePlatformSchema,
      arch: desktopUpdateArchitectureSchema,
    }),
    responses: {
      302: c.noBody(),
      404: apiErrorSchema,
    },
    summary: "Redirect to a product-specific desktop release page",
  },
  productDmgDownload: {
    method: "GET",
    path: "/api/desktop/updates/:product/:channel/:platform/:arch/dmg",
    pathParams: z.object({
      product: desktopUpdateProductSchema,
      channel: desktopUpdateChannelSchema,
      platform: desktopUpdatePlatformSchema,
      arch: desktopUpdateArchitectureSchema,
    }),
    responses: {
      302: c.noBody(),
      404: apiErrorSchema,
    },
    summary: "Redirect to a product-specific desktop DMG download",
  },
  productFeed: {
    method: "GET",
    path: "/api/desktop/updates/:product/:channel/:platform/:arch/RELEASES.json",
    pathParams: z.object({
      product: desktopUpdateProductSchema,
      channel: desktopUpdateChannelSchema,
      platform: desktopUpdatePlatformSchema,
      arch: desktopUpdateArchitectureSchema,
    }),
    responses: {
      200: squirrelMacReleasesSchema,
      400: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get a product-specific desktop auto-update feed",
  },
});
