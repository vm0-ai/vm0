import { command, computed, state } from "ccstate";
import {
  zeroImageShareXContract,
  type ZeroImageShareXResponse,
} from "@vm0/api-contracts/contracts/zero-image-share-x";
import { zeroUploadsContract } from "@vm0/api-contracts/contracts/zero-uploads";
import type { PublicConnectorCatalogStatusItem } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { toast } from "@vm0/ui/components/ui/sonner";

import { accept } from "../../lib/accept.ts";
import { now } from "../../lib/time.ts";
import { zeroClient$ } from "../api-client.ts";
import {
  connectorCatalogStatusByRef$,
  reloadConnectors$,
} from "../external/connectors.ts";
import { tapError } from "../utils.ts";
import { connectConnectorOAuthAuthCode$ } from "./settings/connectors.ts";

const X_IMAGE_SHARE_CARD_TITLE = "Image from Zero";
const X_IMAGE_SHARE_CARD_DESCRIPTION = "Shared from Zero.";
const internalXImageShareCaption$ = state("");

export const xImageShareCaption$ = computed((get) => {
  return get(internalXImageShareCaption$);
});

export const setXImageShareCaption$ = command(({ set }, caption: string) => {
  set(internalXImageShareCaption$, caption);
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": {
        return "&amp;";
      }
      case "<": {
        return "&lt;";
      }
      case ">": {
        return "&gt;";
      }
      case '"': {
        return "&quot;";
      }
      default: {
        return "&#39;";
      }
    }
  });
}

function xImageShareCardHtml(imageUrl: string): string {
  const escapedImageUrl = escapeHtml(imageUrl);
  const escapedTitle = escapeHtml(X_IMAGE_SHARE_CARD_TITLE);
  const escapedDescription = escapeHtml(X_IMAGE_SHARE_CARD_DESCRIPTION);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapedTitle}</title>
    <meta name="description" content="${escapedDescription}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Zero">
    <meta property="og:title" content="${escapedTitle}">
    <meta property="og:description" content="${escapedDescription}">
    <meta property="og:image" content="${escapedImageUrl}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapedTitle}">
    <meta name="twitter:description" content="${escapedDescription}">
    <meta name="twitter:image" content="${escapedImageUrl}">
    <style>
      body { align-items: center; background: #f8fafc; box-sizing: border-box; color: #111827; display: flex; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; justify-content: center; margin: 0; min-height: 100vh; padding: 24px; }
      img { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; box-shadow: 0 8px 30px rgba(15, 23, 42, 0.08); display: block; max-height: 90vh; max-width: min(100%, 960px); object-fit: contain; }
    </style>
  </head>
  <body>
    <img src="${escapedImageUrl}" alt="Image shared from Zero">
  </body>
</html>`;
}

export const xImageShareConnectorStatus$ = computed(async (get) => {
  const connectorsByRef = await get(connectorCatalogStatusByRef$);
  return connectorsByRef.get("x") ?? null;
});

export const connectXForImageShare$ = command(
  async (
    { set },
    connector: PublicConnectorCatalogStatusItem | null,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const authMethod = connector?.authMethods.find((method) => {
      return (
        method.grantKind === "auth-code" || method.grantKind === "openid-auth"
      );
    });
    if (!connector || !authMethod) {
      return false;
    }
    const connected = await set(
      connectConnectorOAuthAuthCode$,
      connector.connectorRef,
      authMethod,
      { connectorLabel: connector.label },
      signal,
    );
    signal.throwIfAborted();
    if (connected) {
      set(reloadConnectors$);
    }
    return connected;
  },
);

export const createXImageShareCardUrl$ = command(
  async ({ get }, imageUrl: string, signal: AbortSignal) => {
    return await tapError(
      (async () => {
        const client = get(zeroClient$)(zeroUploadsContract);
        const uploaded = await accept(
          client.htmlDomEditSnapshot({
            body: {
              filename: `x-image-share-${now()}.html`,
              html: xImageShareCardHtml(imageUrl),
            },
            fetchOptions: { signal },
          }),
          [200],
        );
        signal.throwIfAborted();

        return uploaded.body.url;
      })(),
      () => {
        toast.error("Couldn't prepare X share, try again");
      },
    );
  },
);

export const postImageShareToX$ = command(
  async (
    { get },
    args: {
      readonly caption: string | undefined;
      readonly imageUrl: string;
    },
    signal: AbortSignal,
  ): Promise<ZeroImageShareXResponse> => {
    const client = get(zeroClient$)(zeroImageShareXContract);
    const result = await accept(
      client.post({
        body: {
          caption: args.caption,
          imageUrl: args.imageUrl,
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();

    return result.body;
  },
);
