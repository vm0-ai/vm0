import { command, computed, state, type Command, type Computed } from "ccstate";
import {
  zeroMailContract,
  type ZeroMailDraft,
} from "@vm0/api-contracts/contracts/zero-mail";

import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import {
  resolvePlatformOriginForTarget,
  rewritePlatformHostname,
} from "../api-base.ts";
import { pageSignal$ } from "../page-signal.ts";
import {
  getOrCreateCardSignals,
  registeredCardSignals,
} from "./card-signal-map.ts";

export interface MailDraftDescriptor {
  readonly mailDraftId: string;
  readonly originalUrl: string;
  readonly href: string;
}

export interface MailDraftSignals extends MailDraftDescriptor {
  readonly draft$: Computed<Promise<ZeroMailDraft | null>>;
  readonly delete$: Command<Promise<void>, [AbortSignal]>;
  readonly send$: Command<Promise<void>, [AbortSignal]>;
}

export interface MailDraftCardSignalsRegistry {
  register(descriptor: MailDraftDescriptor): MailDraftSignals;
  resolve(resourceKey: string): MailDraftSignals;
  entries(): ReadonlyMap<string, MailDraftSignals>;
}

export const emptyMailDraftSignalsById$ = computed<
  ReadonlyMap<string, MailDraftSignals>
>(() => {
  return new Map();
});

function browserOrigin(): string | null {
  if (typeof location === "undefined" || !location.origin) {
    return null;
  }
  return location.origin;
}

function addAllowedOriginVariants(
  origins: Set<string>,
  baseUrl: string | null,
) {
  if (!baseUrl || !URL.canParse(baseUrl)) {
    return;
  }
  const parsed = new URL(baseUrl);
  origins.add(parsed.origin);
  for (const target of ["api", "www", "app", "platform"] as const) {
    const variant = new URL(parsed);
    variant.hostname = rewritePlatformHostname(variant.hostname, target);
    origins.add(variant.origin);
  }
}

function allowedOrigins(): Set<string> {
  const origins = new Set<string>();
  addAllowedOriginVariants(origins, browserOrigin());
  addAllowedOriginVariants(origins, resolvePlatformOriginForTarget("api"));
  return origins;
}

function hasExplicitUrlOrigin(value: string): boolean {
  return URL.canParse(value) || value.trimStart().startsWith("//");
}

function isPlatformHostname(hostname: string): boolean {
  const platformDomain = ["vm0.ai", "vm6.ai", "vm7.ai"].some((suffix) => {
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  });
  return platformDomain && /(^|-)(platform|app|www|api)\./u.test(hostname);
}

function parseUrl(value: string): URL | null {
  const baseUrl = browserOrigin() ?? resolvePlatformOriginForTarget("api");
  if (baseUrl && URL.canParse(value, baseUrl)) {
    return new URL(value, baseUrl);
  }
  return URL.canParse(value) ? new URL(value) : null;
}

export function parseMailDraftUrl(value: string): MailDraftDescriptor | null {
  const url = parseUrl(value);
  if (!url) {
    return null;
  }
  const explicitOrigin = hasExplicitUrlOrigin(value);
  if (
    explicitOrigin &&
    ((url.protocol !== "http:" && url.protocol !== "https:") ||
      (!allowedOrigins().has(url.origin) && !isPlatformHostname(url.hostname)))
  ) {
    return null;
  }
  const match = url.pathname.match(
    /^\/mail\/drafts\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/iu,
  );
  const mailDraftId = match?.[1];
  if (!mailDraftId) {
    return null;
  }
  return {
    mailDraftId,
    originalUrl: value,
    href: `/mail/drafts/${mailDraftId}`,
  };
}

function createMailDraftSignals(
  descriptor: MailDraftDescriptor,
): MailDraftSignals {
  const reloadVersion$ = state(0);
  const draft$ = computed(async (get): Promise<ZeroMailDraft | null> => {
    get(reloadVersion$);
    const response = await accept(
      get(zeroClient$)(zeroMailContract).getDraft({
        params: { mailDraftId: descriptor.mailDraftId },
        fetchOptions: { signal: get(pageSignal$) },
      }),
      [200, 404],
    );
    return response.status === 200 ? response.body.mailDraft : null;
  });
  const reload$ = command(({ set }) => {
    set(reloadVersion$, (version) => {
      return version + 1;
    });
  });
  const delete$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      await accept(
        get(zeroClient$)(zeroMailContract).deleteDraft({
          params: { mailDraftId: descriptor.mailDraftId },
          fetchOptions: { signal },
        }),
        [204],
      );
      signal.throwIfAborted();
      set(reload$);
    },
  );
  const send$ = command(async ({ get, set }, signal: AbortSignal) => {
    await accept(
      get(zeroClient$)(zeroMailContract).sendDraft({
        params: { mailDraftId: descriptor.mailDraftId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reload$);
  });
  return { ...descriptor, draft$, delete$, send$ };
}

export function createMailDraftCardSignalsRegistry(): MailDraftCardSignalsRegistry {
  const signalsByResourceKey = new Map<string, MailDraftSignals>();
  return {
    register(descriptor) {
      return getOrCreateCardSignals(
        signalsByResourceKey,
        descriptor.mailDraftId,
        () => {
          return createMailDraftSignals(descriptor);
        },
      );
    },
    resolve(resourceKey) {
      return registeredCardSignals(signalsByResourceKey, resourceKey);
    },
    entries() {
      return signalsByResourceKey;
    },
  };
}
