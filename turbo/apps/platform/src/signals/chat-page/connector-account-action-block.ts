import {
  connectorAccountSelectionSchema,
  connectorAccountTargetKey,
  connectorAccountsContract,
  type ConnectorAccountConnection,
  type ConnectorAccountSelection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { chatThreadConnectorSelectionContract } from "@okouai/api-contracts/contracts/chat-threads";
import { command, computed, state, type Command, type Computed } from "ccstate";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import type { ComposerConnectorAccountSignals } from "../okou-page/composer-connector-accounts.ts";
import { rootSignal$ } from "../root-signal.ts";
import { withCleanup } from "../utils.ts";
import {
  chatActionCallbackFromUrl,
  runChatActionCallback$,
} from "./action-callback.ts";
import {
  chatActionIdMatches,
  type ChatActionContext,
  type ChatActionParseResult,
} from "./chat-action-context.ts";
import {
  createCardSignalsRegistry,
  type CardSignalsRegistry,
} from "./card-signal-map.ts";
import { parseTrustedPlatformUrl } from "./trusted-platform-url.ts";

export interface ConnectorAccountActionDescriptor {
  readonly agentId: string;
  readonly selection: ConnectorAccountSelection;
  readonly originalUrl: string;
  readonly search: string;
  readonly callbackPrompt: string;
  readonly threadId: string;
}

export type ConnectorAccountActionStatus =
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "ready";
      readonly account: ConnectorAccountConnection;
      readonly selected: boolean;
    };

export type ConnectorAccountActionConfirmationState =
  | "idle"
  | "loading"
  | "continued";

export interface ConnectorAccountActionSignals extends ConnectorAccountActionDescriptor {
  readonly status$: Computed<Promise<ConnectorAccountActionStatus>>;
  readonly confirmationState$: Computed<ConnectorAccountActionConfirmationState>;
  readonly refresh$: Command<void, []>;
  readonly confirm$: Command<Promise<void>, [AbortSignal]>;
}

type ConnectorAccountActionCardSignalsRegistry = CardSignalsRegistry<
  ConnectorAccountActionDescriptor,
  ConnectorAccountActionSignals
>;

export function connectorAccountActionResourceKey(
  descriptor: ConnectorAccountActionDescriptor,
): string {
  const path = `/agents/${encodeURIComponent(descriptor.agentId)}/connector-accounts/${encodeURIComponent(descriptor.selection.connectionId)}/select`;
  return `${path}?${descriptor.search}`;
}

function selectionFromUrl(
  url: URL,
  connectionId: string,
): ConnectorAccountSelection | null {
  const kind = url.searchParams.get("kind");
  const connectorSlug = url.searchParams.get("connectorSlug");
  const customConnectorId = url.searchParams.get("customConnectorId");
  const target =
    kind === "builtin" && connectorSlug && customConnectorId === null
      ? { kind, connectorSlug }
      : kind === "custom" && customConnectorId && connectorSlug === null
        ? { kind, customConnectorId }
        : null;
  const parsed = connectorAccountSelectionSchema.safeParse({
    connectionId,
    target,
  });
  return parsed.success ? parsed.data : null;
}

export function parseConnectorAccountActionUrl(
  value: string,
  context: ChatActionContext | undefined,
): ChatActionParseResult<ConnectorAccountActionDescriptor> {
  const url = parseTrustedPlatformUrl(value);
  if (!url) {
    return { status: "unrelated" };
  }
  const match = url.pathname.match(
    /^\/agents\/([^/]+)\/connector-accounts\/([^/]+)\/select$/u,
  );
  if (!match) {
    return { status: "unrelated" };
  }
  const agentId = match[1] ?? "";
  const connectionId = match[2] ?? "";
  const selection = selectionFromUrl(url, connectionId);
  const callback = context ? chatActionCallbackFromUrl(url, context) : null;
  if (
    !context ||
    !agentId ||
    !chatActionIdMatches(agentId, context.agentId) ||
    !selection ||
    !callback?.callbackPrompt ||
    !callback.threadId
  ) {
    return { status: "invalid", originalUrl: value };
  }
  return {
    status: "valid",
    descriptor: {
      agentId: context.agentId,
      selection,
      originalUrl: value,
      search: url.searchParams.toString(),
      callbackPrompt: callback.callbackPrompt,
      threadId: callback.threadId,
    },
  };
}

function targetQuery(selection: ConnectorAccountSelection) {
  return selection.target.kind === "builtin"
    ? {
        kind: selection.target.kind,
        connectorSlug: selection.target.connectorSlug,
      }
    : {
        kind: selection.target.kind,
        customConnectorId: selection.target.customConnectorId,
      };
}

function selectionIsCurrent(
  current: readonly ConnectorAccountSelection[],
  requested: ConnectorAccountSelection,
): boolean {
  const targetKey = connectorAccountTargetKey(requested.target);
  return current.some((selection) => {
    return (
      connectorAccountTargetKey(selection.target) === targetKey &&
      selection.connectionId === requested.connectionId
    );
  });
}

function createConnectorAccountActionSignals(
  descriptor: ConnectorAccountActionDescriptor,
  accounts: ComposerConnectorAccountSignals,
): ConnectorAccountActionSignals {
  const reload$ = state(0);
  const internalConfirmationState$ =
    state<ConnectorAccountActionConfirmationState>("idle");
  const confirmationState$ = computed((get) => {
    return get(internalConfirmationState$);
  });
  const status$ = computed(
    async (get): Promise<ConnectorAccountActionStatus> => {
      get(reload$);
      if (!get(accounts.enabled$)) {
        return { kind: "unavailable" };
      }
      const result = await accept(
        get(apiClient$)(connectorAccountsContract).connection({
          params: { connectionId: descriptor.selection.connectionId },
          query: targetQuery(descriptor.selection),
          fetchOptions: { signal: get(rootSignal$) },
        }),
        [200, 404],
      );
      if (result.status === 404) {
        return { kind: "unavailable" };
      }
      const preference = await get(accounts.preferenceState$);
      return {
        kind: "ready",
        account: result.body,
        selected: selectionIsCurrent(
          preference.selections,
          descriptor.selection,
        ),
      };
    },
  );
  const refresh$ = command(({ set }) => {
    set(reload$, (version) => {
      return version + 1;
    });
    set(accounts.reload$);
  });
  const confirm$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      if (get(internalConfirmationState$) !== "idle") {
        return;
      }
      set(internalConfirmationState$, "loading");
      await withCleanup(
        (async () => {
          await accept(
            get(apiClient$)(chatThreadConnectorSelectionContract).update({
              params: { id: descriptor.threadId },
              body: descriptor.selection,
              fetchOptions: { signal },
            }),
            [200],
            signal,
          );
          set(refresh$);
          await set(
            runChatActionCallback$,
            {
              threadId: descriptor.threadId,
              agentId: descriptor.agentId,
              callbackPrompt: descriptor.callbackPrompt,
            },
            signal,
          );
          set(internalConfirmationState$, "continued");
        })(),
        () => {
          set(internalConfirmationState$, (current) => {
            return current === "loading" ? "idle" : current;
          });
        },
      );
    },
  );
  return {
    ...descriptor,
    status$,
    confirmationState$,
    refresh$,
    confirm$,
  };
}

export function createConnectorAccountActionCardSignalsRegistry(
  accounts: ComposerConnectorAccountSignals,
): ConnectorAccountActionCardSignalsRegistry {
  return createCardSignalsRegistry(
    connectorAccountActionResourceKey,
    (descriptor) => {
      return createConnectorAccountActionSignals(descriptor, accounts);
    },
  );
}
