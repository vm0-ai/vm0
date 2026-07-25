import {
  zeroBrowserContract,
  type ZeroBrowserSession,
} from "@vm0/api-contracts/contracts/zero-browser";
import { computed, type Computed } from "ccstate";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { pageSignal$ } from "../page-signal.ts";
import {
  getOrCreateCardSignals,
  registeredCardSignals,
} from "./card-signal-map.ts";
import { parseTrustedPlatformActionUrl } from "./platform-action-url.ts";

export interface BrowserSessionDescriptor {
  readonly browserId: string;
  readonly originalUrl: string;
  readonly href: string;
  readonly fallbackMarkdown: string;
}

export interface BrowserSessionSignals extends BrowserSessionDescriptor {
  readonly threadId: string | null;
  readonly session$: Computed<Promise<ZeroBrowserSession | null>>;
}

export interface BrowserSessionCardSignalsRegistry {
  register(descriptor: BrowserSessionDescriptor): BrowserSessionSignals;
  resolve(resourceKey: string): BrowserSessionSignals;
}

export function parseBrowserSessionUrl(
  value: string,
  fallbackMarkdown: string = value,
): BrowserSessionDescriptor | null {
  const url = parseTrustedPlatformActionUrl(value);
  if (!url) {
    return null;
  }
  const match = url.pathname.match(
    /^\/browsers\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/iu,
  );
  const browserId = match?.[1];
  if (!browserId) {
    return null;
  }
  return {
    browserId,
    originalUrl: value,
    href: `/browsers/${browserId}`,
    fallbackMarkdown,
  };
}

export function createBrowserSessionSignals(
  threadId: string | null,
  descriptor: BrowserSessionDescriptor,
): BrowserSessionSignals {
  const session$ = computed(async (get): Promise<ZeroBrowserSession | null> => {
    const response = await accept(
      get(zeroClient$)(zeroBrowserContract).get({
        params: { browserId: descriptor.browserId },
        query: threadId ? { chatThreadId: threadId } : {},
        fetchOptions: { signal: get(pageSignal$) },
      }),
      [200, 404],
    );
    return response.status === 200 ? response.body.browser : null;
  });

  return { ...descriptor, threadId, session$ };
}

export function createBrowserSessionCardSignalsRegistry(
  threadId: string,
): BrowserSessionCardSignalsRegistry {
  const signalsByResourceKey = new Map<string, BrowserSessionSignals>();
  const signalsByBrowserId = new Map<string, BrowserSessionSignals>();
  return {
    register(descriptor) {
      return getOrCreateCardSignals(
        signalsByResourceKey,
        descriptor.fallbackMarkdown,
        () => {
          const shared = getOrCreateCardSignals(
            signalsByBrowserId,
            descriptor.browserId,
            () => {
              return createBrowserSessionSignals(threadId, descriptor);
            },
          );
          return {
            ...descriptor,
            threadId,
            session$: shared.session$,
          };
        },
      );
    },
    resolve(resourceKey) {
      return registeredCardSignals(signalsByResourceKey, resourceKey);
    },
  };
}
