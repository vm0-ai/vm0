import type { PhoneNumberResource, UserResource } from "@clerk/react/types";
import { command, state, type Command, type State } from "ccstate";

import { clerk$ } from "../auth.ts";
import { isRecord, settle, stringProperty } from "../utils.ts";
import type { AuthV2ContinuationState } from "./continuation.ts";

export type AuthV2SecurityTaskState = {
  readonly accountIdentifier: string;
  readonly status: "incomplete";
  readonly error:
    | "request-failed"
    | "password-mismatch"
    | "password-invalid"
    | null;
} & (
  | { readonly task: "reset-password"; readonly updated: boolean }
  | {
      readonly task: "setup-mfa";
      readonly methods: readonly ("totp" | "phone_code")[];
      readonly secret: string | null;
      readonly phoneNumber: string | null;
      readonly backupCodes: readonly string[] | null;
    }
);

type MfaState = Extract<AuthV2SecurityTaskState, { task: "setup-mfa" }>;
export type AuthV2SecurityTaskAction =
  | {
      readonly action: "reset-password";
      readonly password: string;
      readonly confirmation: string;
    }
  | { readonly action: "prepare-totp" }
  | { readonly action: "prepare-phone"; readonly phoneNumber: string }
  | { readonly action: "verify"; readonly code: string }
  | { readonly action: "finish" };

interface SecurityTaskDependencies {
  readonly state$: State<AuthV2ContinuationState>;
  readonly sessionId$: State<string | null>;
  readonly resume$: Command<Promise<void>, [AbortSignal]>;
}

function createResetPasswordCommand(dependencies: SecurityTaskDependencies) {
  return command(
    async (
      { set },
      current: Extract<AuthV2SecurityTaskState, { task: "reset-password" }>,
      action: AuthV2SecurityTaskAction,
      user: UserResource,
      signal: AbortSignal,
    ) => {
      if (action.action === "finish" && current.updated) {
        await set(dependencies.resume$, signal);
        return;
      }
      if (action.action !== "reset-password" || current.updated) {
        return;
      }
      if (!action.password || action.password !== action.confirmation) {
        set(dependencies.state$, { ...current, error: "password-mismatch" });
        return;
      }
      await user.updatePassword({
        newPassword: action.password,
        signOutOfOtherSessions: true,
      });
      signal.throwIfAborted();
      // An activation failure must not require changing the password again.
      set(dependencies.state$, { ...current, error: null, updated: true });
      await set(dependencies.resume$, signal);
    },
  );
}

function createPreparePhoneCommand(
  dependencies: SecurityTaskDependencies,
  phone$: State<PhoneNumberResource | null>,
) {
  return command(
    async (
      { get, set },
      current: MfaState,
      number: string,
      user: UserResource,
      signal: AbortSignal,
    ) => {
      if (!number || !current.methods.includes("phone_code")) {
        return;
      }
      const existing =
        get(phone$) ??
        user.phoneNumbers.find((phone) => {
          return phone.phoneNumber === number;
        });
      const phone =
        existing?.phoneNumber === number
          ? existing
          : await user.createPhoneNumber({ phoneNumber: number });
      signal.throwIfAborted();
      set(phone$, phone);
      if (phone.verification.status === "verified") {
        const reserved = await phone.setReservedForSecondFactor({
          reserved: true,
        });
        signal.throwIfAborted();
        set(dependencies.state$, {
          ...current,
          error: null,
          backupCodes: reserved.backupCodes ?? [],
        });
        return;
      }
      await phone.prepareVerification();
      signal.throwIfAborted();
      set(dependencies.state$, {
        ...current,
        error: null,
        phoneNumber: phone.phoneNumber,
        secret: null,
      });
    },
  );
}

function createVerifyMfaCommand(
  dependencies: SecurityTaskDependencies,
  phone$: State<PhoneNumberResource | null>,
  pendingBackupCodes$: State<readonly string[] | null>,
) {
  return command(
    async (
      { get, set },
      current: MfaState,
      code: string,
      user: UserResource,
      signal: AbortSignal,
    ) => {
      if (!code) {
        return;
      }
      if (current.secret) {
        const verified = await user.verifyTOTP({ code });
        signal.throwIfAborted();
        set(dependencies.state$, {
          ...current,
          error: null,
          secret: null,
          backupCodes: verified.backupCodes ?? get(pendingBackupCodes$) ?? [],
        });
      } else if (current.phoneNumber) {
        const phone = get(phone$);
        if (!phone) {
          return;
        }
        const verified =
          phone.verification.status === "verified"
            ? phone
            : await phone.attemptVerification({ code });
        signal.throwIfAborted();
        // If reserving the verified number fails, retry that write only.
        set(phone$, verified);
        const reserved = await verified.setReservedForSecondFactor({
          reserved: true,
        });
        signal.throwIfAborted();
        set(dependencies.state$, {
          ...current,
          error: null,
          phoneNumber: null,
          backupCodes: reserved.backupCodes ?? [],
        });
      }
    },
  );
}

function createMfaCommand(dependencies: SecurityTaskDependencies) {
  const ownerSessionId$ = state<string | null>(null);
  const phone$ = state<PhoneNumberResource | null>(null);
  const preparePhone$ = createPreparePhoneCommand(dependencies, phone$);
  const pendingBackupCodes$ = state<readonly string[] | null>(null);
  const verify$ = createVerifyMfaCommand(
    dependencies,
    phone$,
    pendingBackupCodes$,
  );
  return command(
    async (
      { get, set },
      current: MfaState,
      action: AuthV2SecurityTaskAction,
      user: UserResource,
      signal: AbortSignal,
    ) => {
      const sessionId = get(dependencies.sessionId$);
      if (get(ownerSessionId$) !== sessionId) {
        set(ownerSessionId$, sessionId);
        set(phone$, null);
        set(pendingBackupCodes$, null);
      }
      if (current.backupCodes !== null) {
        if (action.action === "finish") {
          const clerk = await get(clerk$);
          signal.throwIfAborted();
          const backupEnabled =
            clerk.__internal_environment?.userSettings.attributes.backup_code
              ?.enabled;
          if (
            backupEnabled &&
            !user.backupCodeEnabled &&
            current.backupCodes.length === 0
          ) {
            const backup = await user.createBackupCode();
            signal.throwIfAborted();
            set(dependencies.state$, {
              ...current,
              error: null,
              backupCodes: backup.codes,
            });
            return;
          }
          await set(dependencies.resume$, signal);
        }
        return;
      }
      if (
        action.action === "prepare-totp" &&
        current.methods.includes("totp")
      ) {
        const totp = await user.createTOTP();
        signal.throwIfAborted();
        if (!totp.secret) {
          throw new Error("Authenticator setup did not return a secret");
        }
        set(phone$, null);
        set(pendingBackupCodes$, totp.backupCodes ?? null);
        set(dependencies.state$, {
          ...current,
          error: null,
          secret: totp.secret,
          phoneNumber: null,
        });
      } else if (action.action === "prepare-phone") {
        await set(
          preparePhone$,
          current,
          action.phoneNumber.trim(),
          user,
          signal,
        );
      } else if (action.action === "verify") {
        await set(verify$, current, action.code.trim(), user, signal);
      }
    },
  );
}

function passwordRejected(error: unknown): boolean {
  if (!isRecord(error) || !Array.isArray(error.errors)) {
    return false;
  }
  return error.errors.some((item: unknown) => {
    return (
      isRecord(item) &&
      stringProperty(item, "code")?.startsWith("form_password_") === true
    );
  });
}

export function createAuthV2SecurityTaskCommand(
  dependencies: SecurityTaskDependencies,
): Command<Promise<void>, [AuthV2SecurityTaskAction, AbortSignal]> {
  const resetPassword$ = createResetPasswordCommand(dependencies);
  const mfa$ = createMfaCommand(dependencies);
  const perform$ = command(
    async (
      { get, set },
      action: AuthV2SecurityTaskAction,
      signal: AbortSignal,
    ) => {
      const current = get(dependencies.state$);
      if (
        current.status !== "incomplete" ||
        current.task === "choose-organization"
      ) {
        return;
      }
      set(dependencies.state$, { ...current, error: null });
      const clerk = await get(clerk$);
      signal.throwIfAborted();
      const session = clerk.session;
      if (session?.id !== get(dependencies.sessionId$) || !session?.user) {
        throw new Error("Authentication session is no longer available");
      }
      if (current.task === "reset-password") {
        await set(resetPassword$, current, action, session.user, signal);
      } else {
        await set(mfa$, current, action, session.user, signal);
      }
    },
  );
  return command(
    async (
      { get, set },
      action: AuthV2SecurityTaskAction,
      signal: AbortSignal,
    ) => {
      const result = await settle(set(perform$, action, signal), signal);
      if (!result.ok) {
        const current = get(dependencies.state$);
        if (
          current.status === "incomplete" &&
          current.task !== "choose-organization"
        ) {
          // Provider messages can contain identifiers and credentials. Preserve
          // retry state, but expose only known error categories.
          set(dependencies.state$, {
            ...current,
            error: passwordRejected(result.error)
              ? "password-invalid"
              : "request-failed",
          });
        }
      }
    },
  );
}
