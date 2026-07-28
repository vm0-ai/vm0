import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
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
import { onRef, withCleanup } from "../utils.ts";
import {
  createTextPreviewComputedFromBlob,
  type TextPreviewComputed,
} from "../text-preview.ts";

export type MailDraftFollowUpState =
  | "idle"
  | "submitting"
  | "active"
  | "paused";

export interface MailDraftDescriptor {
  readonly mailDraftId: string;
  readonly originalUrl: string;
  readonly href: string;
}

export interface MailAttachmentPreviews {
  readonly text: ReadonlyMap<string, TextPreviewComputed>;
  readonly urls: ReadonlyMap<string, string | null>;
}

export interface MailDraftSignals extends MailDraftDescriptor {
  readonly threadId: string;
  readonly draft$: Computed<Promise<ZeroMailDraft | null>>;
  readonly sidebarDraft$: Computed<Promise<ZeroMailDraft | null>>;
  readonly attachmentPreviews$: Computed<Promise<MailAttachmentPreviews>>;
  readonly setAttachmentScopeRef$: Command<
    (() => void) | undefined,
    [HTMLDivElement | null]
  >;
  readonly reloadDraft$: Command<void, []>;
  readonly delete$: Command<Promise<void>, [AbortSignal]>;
  readonly send$: Command<Promise<void>, [AbortSignal]>;
  readonly followUpState$: Computed<MailDraftFollowUpState>;
  readonly followUp$: Command<Promise<void>, [AbortSignal]>;
}

export interface MailDraftCardSignalsRegistry {
  register(descriptor: MailDraftDescriptor): MailDraftSignals;
  resolve(resourceKey: string): MailDraftSignals;
  entries(): ReadonlyMap<string, MailDraftSignals>;
  readonly reload$: Command<void, []>;
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

function createAttachmentPreviews(
  descriptor: MailDraftDescriptor,
  sidebarDraft$: Computed<Promise<ZeroMailDraft | null>>,
): Pick<MailDraftSignals, "attachmentPreviews$" | "setAttachmentScopeRef$"> {
  const attachmentObjectUrls = new Map<string, string>();
  const attachmentScopeActive$ = state(false);
  let cleanupSignal: AbortSignal | null = null;
  let loadVersion = 0;
  const revokeAttachmentObjectUrls = () => {
    for (const url of attachmentObjectUrls.values()) {
      URL.revokeObjectURL(url);
    }
    attachmentObjectUrls.clear();
  };
  const releaseAttachmentObjectUrls = () => {
    loadVersion += 1;
    revokeAttachmentObjectUrls();
  };
  const attachmentPreviews$ = computed(
    async (get): Promise<MailAttachmentPreviews> => {
      if (!get(attachmentScopeActive$)) {
        return { text: new Map(), urls: new Map() };
      }
      const currentLoadVersion = ++loadVersion;
      const draftPromise = get(sidebarDraft$);
      const signal = get(pageSignal$);
      const client = get(zeroClient$)(zeroMailContract);
      signal.throwIfAborted();
      if (cleanupSignal !== signal) {
        cleanupSignal?.removeEventListener(
          "abort",
          releaseAttachmentObjectUrls,
        );
        cleanupSignal = signal;
        signal.addEventListener("abort", releaseAttachmentObjectUrls, {
          once: true,
        });
      }
      const draft = await draftPromise;
      signal.throwIfAborted();
      if (currentLoadVersion !== loadVersion) {
        return { text: new Map(), urls: new Map() };
      }
      const attachments = draft?.version === 3 ? draft.attachments : [];
      const attachmentPartIds = new Set(
        attachments.flatMap((attachment) => {
          return attachment.partId ? [attachment.partId] : [];
        }),
      );
      const partIds = Array.from(
        new Set([
          ...(draft?.inlineImages ?? []).map((image) => {
            return image.partId;
          }),
          ...attachmentPartIds,
        ]),
      );
      const responses = await Promise.all(
        partIds.map(async (partId) => {
          const response = await accept(
            client.getAttachment({
              params: {
                mailDraftId: descriptor.mailDraftId,
                partId,
              },
              fetchOptions: { signal },
            }),
            [200, 404],
          );
          return { partId, response };
        }),
      );
      signal.throwIfAborted();
      if (currentLoadVersion !== loadVersion) {
        return { text: new Map(), urls: new Map() };
      }
      revokeAttachmentObjectUrls();
      const textPreviews = new Map<string, TextPreviewComputed>();
      const urls = new Map<string, string | null>();
      for (const { partId, response } of responses) {
        if (response.status === 404) {
          urls.set(partId, null);
          continue;
        }
        const url = URL.createObjectURL(response.body);
        attachmentObjectUrls.set(partId, url);
        urls.set(partId, url);
        if (attachmentPartIds.has(partId)) {
          textPreviews.set(
            partId,
            createTextPreviewComputedFromBlob(response.body),
          );
        }
      }
      return { text: textPreviews, urls };
    },
  );
  const setAttachmentScopeRef$ = onRef(
    command(({ set }, _element: HTMLDivElement, signal: AbortSignal) => {
      set(attachmentScopeActive$, true);
      signal.addEventListener(
        "abort",
        () => {
          releaseAttachmentObjectUrls();
          set(attachmentScopeActive$, false);
        },
        { once: true },
      );
    }),
  );
  return {
    attachmentPreviews$,
    setAttachmentScopeRef$,
  };
}

interface MailDraftResourceSignals extends Pick<
  MailDraftSignals,
  "draft$" | "sidebarDraft$" | "reloadDraft$" | "followUpState$"
> {
  readonly followUpStateValue$: State<MailDraftFollowUpState>;
  readonly draftOverride$: State<ZeroMailDraft | null | undefined>;
}

function createMailDraftResourceSignals(
  descriptor: MailDraftDescriptor,
): MailDraftResourceSignals {
  const followUpStateValue$ = state<MailDraftFollowUpState>("idle");
  const followUpState$ = computed((get) => {
    return get(followUpStateValue$);
  });
  const draftOverride$ = state<ZeroMailDraft | null | undefined>(undefined);
  const draftReloadVersion$ = state(0);
  const draft$ = computed(async (get): Promise<ZeroMailDraft | null> => {
    get(draftReloadVersion$);
    const override = get(draftOverride$);
    if (override !== undefined) {
      return override;
    }
    const response = await accept(
      get(zeroClient$)(zeroMailContract).getDraft({
        params: { mailDraftId: descriptor.mailDraftId },
        fetchOptions: { signal: get(pageSignal$) },
      }),
      [200, 404],
    );
    return response.status === 200 ? response.body.mailDraft : null;
  });
  const sidebarDraft$ = draft$;
  const reloadDraft$ = command(({ set }) => {
    set(draftOverride$, undefined);
    set(followUpStateValue$, (current) => {
      return current === "submitting" ? current : "idle";
    });
    set(draftReloadVersion$, (version) => {
      return version + 1;
    });
  });
  return {
    followUpStateValue$,
    draftOverride$,
    draft$,
    sidebarDraft$,
    reloadDraft$,
    followUpState$,
  };
}

function createMailDraftMutationSignals(
  descriptor: MailDraftDescriptor,
  resources: MailDraftResourceSignals,
): Pick<MailDraftSignals, "delete$" | "send$" | "followUp$"> {
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
      set(resources.draftOverride$, null);
    },
  );
  const send$ = command(async ({ get, set }, signal: AbortSignal) => {
    const response = await accept(
      get(zeroClient$)(zeroMailContract).sendDraft({
        params: { mailDraftId: descriptor.mailDraftId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(resources.draftOverride$, response.body.mailDraft);
  });
  const followUp$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      if (get(resources.followUpStateValue$) !== "idle") {
        return;
      }
      set(resources.followUpStateValue$, "submitting");
      await withCleanup(
        (async () => {
          const draft = await get(resources.draft$);
          signal.throwIfAborted();
          if (!draft) {
            throw new Error("Email is no longer available");
          }
          if (draft.followUp) {
            set(resources.followUpStateValue$, draft.followUp.status);
            return;
          }
          await accept(
            get(zeroClient$)(zeroMailContract).createFollowUp({
              params: { mailDraftId: descriptor.mailDraftId },
              body: {},
              fetchOptions: { signal },
            }),
            [200],
          );
          set(resources.reloadDraft$);
          set(resources.followUpStateValue$, "active");
        })(),
        () => {
          set(resources.followUpStateValue$, (current) => {
            return current === "submitting" ? "idle" : current;
          });
        },
      );
    },
  );
  return { delete$, send$, followUp$ };
}

function createMailDraftSignals(
  threadId: string,
  descriptor: MailDraftDescriptor,
): MailDraftSignals {
  const resources = createMailDraftResourceSignals(descriptor);
  const mutations = createMailDraftMutationSignals(descriptor, resources);
  const attachmentPreviews = createAttachmentPreviews(
    descriptor,
    resources.sidebarDraft$,
  );
  return {
    mailDraftId: descriptor.mailDraftId,
    originalUrl: descriptor.originalUrl,
    href: descriptor.href,
    threadId,
    draft$: resources.draft$,
    sidebarDraft$: resources.sidebarDraft$,
    ...attachmentPreviews,
    reloadDraft$: resources.reloadDraft$,
    delete$: mutations.delete$,
    send$: mutations.send$,
    followUpState$: resources.followUpState$,
    followUp$: mutations.followUp$,
  };
}

export function createMailDraftCardSignalsRegistry(
  threadId: string,
): MailDraftCardSignalsRegistry {
  const signalsByResourceKey = new Map<string, MailDraftSignals>();
  const reload$ = command(({ set }) => {
    for (const signals of signalsByResourceKey.values()) {
      set(signals.reloadDraft$);
    }
  });
  return {
    reload$,
    register(descriptor) {
      return getOrCreateCardSignals(
        signalsByResourceKey,
        descriptor.mailDraftId,
        () => {
          return createMailDraftSignals(threadId, descriptor);
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
