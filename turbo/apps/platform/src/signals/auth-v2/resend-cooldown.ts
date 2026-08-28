import { command } from "ccstate";

import { now } from "../../lib/time.ts";
import { sessionStorageSignals } from "../external/session-storage.ts";
import { jsonParseOr } from "../utils.ts";

export const AUTH_V2_SIGN_IN_RESEND_COOLDOWN_STORAGE_KEY =
  "vm0.authV2.signIn.resendCooldown";
export const AUTH_V2_SIGN_UP_RESEND_COOLDOWN_STORAGE_KEY =
  "vm0.authV2.signUp.resendCooldown";

interface StoredResendCooldown {
  readonly deadlineMs: number;
  readonly identity: string;
}

function storedResendCooldown(value: string): StoredResendCooldown | null {
  const parsed = jsonParseOr<unknown>(value, null);
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  if (!("deadlineMs" in parsed) || !("identity" in parsed)) {
    return null;
  }
  const { deadlineMs, identity } = parsed;
  if (
    typeof deadlineMs !== "number" ||
    !Number.isFinite(deadlineMs) ||
    typeof identity !== "string" ||
    identity.length === 0
  ) {
    return null;
  }
  return { deadlineMs, identity };
}

export function createAuthV2ResendCooldownStorage(key: string) {
  const storage = sessionStorageSignals(key);

  const restore$ = command(({ get, set }, identity: string): number | null => {
    const storedValue = get(storage.get$);
    if (storedValue === null) {
      return null;
    }
    const stored = storedResendCooldown(storedValue);
    if (
      stored === null ||
      stored.identity !== identity ||
      stored.deadlineMs <= now()
    ) {
      set(storage.clear$);
      return null;
    }
    return stored.deadlineMs;
  });

  const save$ = command(
    ({ set }, identity: string, deadlineMs: number): void => {
      set(storage.set$, JSON.stringify({ deadlineMs, identity }));
    },
  );

  return Object.freeze({
    clear$: storage.clear$,
    restore$,
    save$,
  });
}
