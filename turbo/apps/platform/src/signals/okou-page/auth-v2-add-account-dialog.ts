import { command, computed, state } from "ccstate";

import { captureAuthV2DiagnosticEvent } from "../../lib/posthog.ts";
import {
  createAuthV2ContinuationSignals,
  type AuthV2ContinuationSignals,
} from "../auth-v2/continuation.ts";
import { createAuthV2Diagnostics } from "../auth-v2/diagnostics.ts";
import {
  resolveAuthV2PlatformContext,
  type AuthV2PlatformContext,
} from "../auth-v2/platform-context.ts";
import {
  createAuthV2SignInSignals,
  type AuthV2SignInSignals,
} from "../auth-v2/sign-in-flow.ts";
import { resetSignal } from "../utils.ts";

export interface AuthV2AddAccountDialogModel {
  readonly continuationSignals: AuthV2ContinuationSignals;
  readonly platformContext: AuthV2PlatformContext;
  readonly signInSignals: AuthV2SignInSignals;
}

const internalDialogModel$ = state<AuthV2AddAccountDialogModel | null>(null);
const resetDialogSignal$ = resetSignal();

export const authV2AddAccountDialogModel$ = computed((get) => {
  return get(internalDialogModel$);
});

const releaseAuthV2AddAccountDialog$ = command(({ set }) => {
  set(internalDialogModel$, null);
});

export const closeAuthV2AddAccountDialog$ = command(({ set }) => {
  set(resetDialogSignal$);
  set(releaseAuthV2AddAccountDialog$);
});

export const openAuthV2AddAccountDialog$ = command(
  async ({ get, set }, pageSignal: AbortSignal): Promise<void> => {
    const dialogSignal = set(resetDialogSignal$, pageSignal);
    dialogSignal.addEventListener(
      "abort",
      () => {
        set(releaseAuthV2AddAccountDialog$);
      },
      { once: true },
    );

    // Add-account is an app-owned entry point, so it intentionally ignores
    // unrelated query/hash state from the page underneath the modal.
    const platformContext = resolveAuthV2PlatformContext("sign-in", {
      authHash: "",
      authSearch: "",
    });
    const diagnostics = createAuthV2Diagnostics(
      "sign-in",
      captureAuthV2DiagnosticEvent,
    );
    const continuationController = createAuthV2ContinuationSignals({
      isContinuationRoute: false,
      mode: "sign-in",
      navigation: platformContext.navigation,
    });
    const continuationSignals = diagnostics.instrumentContinuation(
      continuationController,
    );
    const signInSignals = diagnostics.instrumentSignIn(
      createAuthV2SignInSignals({
        continuation: continuationController,
        isBaseRoute: true,
        isOAuthCallbackRoute: false,
        navigation: platformContext.navigation,
      }),
      {
        continuationState$: continuationController.state$,
        isBaseRoute: true,
        isOAuthCallbackRoute: false,
      },
    );
    set(signInSignals.useAnotherAccount$);

    set(internalDialogModel$, {
      continuationSignals,
      platformContext,
      signInSignals,
    });

    await set(continuationSignals.initialize$, dialogSignal);
    pageSignal.throwIfAborted();
    dialogSignal.throwIfAborted();
    if (get(continuationSignals.state$).status === "inactive") {
      await set(signInSignals.initialize$, dialogSignal);
      pageSignal.throwIfAborted();
      dialogSignal.throwIfAborted();
    }
  },
);
