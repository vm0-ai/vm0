import { command, type Command, type State } from "ccstate";

import { now } from "../../lib/time.ts";
import { sessionStorageSignals } from "../external/session-storage.ts";
import { jsonParseOr, onRef, setLoop } from "../utils.ts";

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

export interface AuthV2ResendCooldown {
  readonly storage: ReturnType<typeof createAuthV2ResendCooldownStorage>;
  readonly seconds: number;
}

interface ResendCooldownAtoms {
  readonly resendRemainingSeconds$: State<number>;
}

interface ResendCooldownRuntime {
  readonly cooldownDeadlineMs$: State<number | null>;
}

export function createStartCooldownCommand(
  { storage, seconds }: AuthV2ResendCooldown,
  atoms: ResendCooldownAtoms,
  runtime: ResendCooldownRuntime,
): Command<void, [string, AbortSignal]> {
  return command(({ set }, identity: string, signal: AbortSignal): void => {
    signal.throwIfAborted();
    const deadlineMs = now() + seconds * 1000;
    set(storage.save$, identity, deadlineMs);
    set(runtime.cooldownDeadlineMs$, deadlineMs);
    set(atoms.resendRemainingSeconds$, seconds);
  });
}

export function createResendCooldownLifecycleRef(
  { storage }: AuthV2ResendCooldown,
  atoms: ResendCooldownAtoms,
  runtime: ResendCooldownRuntime,
) {
  return onRef(
    command(
      async (
        { get, set },
        _element: HTMLSpanElement,
        signal: AbortSignal,
      ): Promise<void> => {
        await setLoop(
          () => {
            const deadlineMs = get(runtime.cooldownDeadlineMs$);
            if (deadlineMs === null) {
              return true;
            }
            const remainingSeconds = Math.max(
              0,
              Math.ceil((deadlineMs - now()) / 1000),
            );
            set(atoms.resendRemainingSeconds$, remainingSeconds);
            if (remainingSeconds > 0) {
              return false;
            }
            set(storage.clear$);
            set(runtime.cooldownDeadlineMs$, null);
            return true;
          },
          1000,
          signal,
          { retryTransientErrors: false },
        );
      },
    ),
  );
}
