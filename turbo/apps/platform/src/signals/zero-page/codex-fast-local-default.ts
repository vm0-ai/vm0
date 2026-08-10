import { command, computed } from "ccstate";
import { currentOrgInfo$, currentUserInfo$ } from "../auth.ts";
import { codexFastModeEnabled$ } from "../external/feature-switch.ts";
import { localStorageSignals } from "../external/local-storage.ts";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import {
  reloadUserModelPreference$,
  updateUserModelPreference$,
  userModelPreference$,
} from "../external/user-model-preference.ts";
import { jsonParseOr } from "../utils.ts";
import {
  isCodexFastModeAvailableForSelection,
  resolveModelFirstUserDefaultSelection,
} from "./model-default-selection.ts";

export const CODEX_FAST_MODE_LOCAL_DEFAULT_STORAGE_KEY =
  "codexFastModeDefaultByUserOrg";

const { get$: rawDefaultByScope$, set$: setRawDefaultByScope$ } =
  localStorageSignals(CODEX_FAST_MODE_LOCAL_DEFAULT_STORAGE_KEY);

type CodexFastModeDefaultByScope = Record<string, boolean>;

function parseDefaultByScope(raw: string | null): CodexFastModeDefaultByScope {
  if (!raw) {
    return {};
  }
  const parsed = jsonParseOr<unknown>(raw, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const result: CodexFastModeDefaultByScope = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

function storageScope(params: {
  readonly userId: string | undefined;
  readonly orgId: string | null | undefined;
}): string | null {
  if (!params.userId || !params.orgId) {
    return null;
  }
  return `${params.userId}:${params.orgId}`;
}

export const codexFastModeLocalDefault$ = computed(
  async (get): Promise<boolean> => {
    const [user, org] = await Promise.all([
      get(currentUserInfo$),
      get(currentOrgInfo$),
    ]);
    const scope = storageScope({ userId: user?.id, orgId: org?.id });
    if (!scope) {
      return false;
    }
    return parseDefaultByScope(get(rawDefaultByScope$))[scope] ?? false;
  },
);

export const setCodexFastModeLocalDefault$ = command(
  async ({ get, set }, enabled: boolean, signal: AbortSignal) => {
    const [user, org] = await Promise.all([
      get(currentUserInfo$),
      get(currentOrgInfo$),
    ]);
    signal.throwIfAborted();
    const scope = storageScope({ userId: user?.id, orgId: org?.id });
    if (!scope) {
      return;
    }
    const next = {
      ...parseDefaultByScope(get(rawDefaultByScope$)),
      [scope]: enabled,
    };
    set(setRawDefaultByScope$, JSON.stringify(next));
  },
);

export const migrateCodexFastModeLocalDefault$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const legacyFastDefault = await get(codexFastModeLocalDefault$);
    signal.throwIfAborted();
    if (!legacyFastDefault) {
      return;
    }

    const [userPreference, policies] = await Promise.all([
      get(userModelPreference$),
      get(orgModelPolicies$),
    ]);
    signal.throwIfAborted();
    if (userPreference.codexServiceTier === "fast") {
      await set(setCodexFastModeLocalDefault$, false, signal);
      return;
    }

    const selection = resolveModelFirstUserDefaultSelection({
      userPreference,
      policies,
    });
    if (
      !selection ||
      !isCodexFastModeAvailableForSelection({
        policies,
        selectedModel: selection.selectedModel,
        codexFastModeEnabled: get(codexFastModeEnabled$),
      })
    ) {
      return;
    }

    await set(
      updateUserModelPreference$,
      {
        selectedModel: selection.selectedModel,
        codexServiceTier: "fast",
      },
      signal,
    );
    signal.throwIfAborted();
    set(reloadUserModelPreference$);
    await set(setCodexFastModeLocalDefault$, false, signal);
  },
);
