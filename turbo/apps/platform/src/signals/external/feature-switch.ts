import { command, computed, state } from "ccstate";
import { logger } from "../log";
import {
  FeatureSwitchKey,
  getAllFeatureStates,
  zeroFeatureSwitchesContract,
} from "@vm0/core";
import { localStorageSignals } from "./local-storage";
import { jsonParseOr } from "../utils";
import { clerk$, user$ } from "../auth";
import { zeroClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";

const L = logger("FeatureSwitch");
const { get$, set$, clear$ } = localStorageSignals("featureSwitch");

const internalReload$ = state(0);

const dbFeatureSwitches$ = computed(async (get) => {
  get(internalReload$);
  const createClient = get(zeroClient$);
  const client = createClient(zeroFeatureSwitchesContract);
  const result = await accept(client.get(), [200], { toast: false });
  return result.body.switches;
});

function applyOverrides(
  result: Record<FeatureSwitchKey, boolean>,
  overrides: Partial<Record<string, boolean>> | undefined,
  log?: boolean,
) {
  if (!overrides) {
    return;
  }
  for (const key of Object.values(FeatureSwitchKey)) {
    const value = overrides[key];
    if (value !== undefined) {
      result[key] = Boolean(value);
      if (log) {
        L.warn(`Override feature switch: ${key} = ${Boolean(value)}`);
      }
    }
  }
}

export const featureSwitch$ = computed(async (get) => {
  get(internalReload$);

  await Promise.resolve();

  const user = await get(user$);
  const userId = user?.id;
  const email = user?.primaryEmailAddress?.emailAddress;
  const clerk = await get(clerk$);
  const orgId = clerk.organization?.id;

  const result = getAllFeatureStates({ userId, email, orgId });

  // Layer 2: DB overrides (lower priority than localStorage)
  const dbOverrides = await get(dbFeatureSwitches$);
  applyOverrides(result, dbOverrides);

  // Layer 3: localStorage overrides (highest priority)
  const override = get(get$);
  if (override) {
    const parsed = jsonParseOr<Partial<Record<string, boolean>> | undefined>(
      override,
      undefined,
    );
    applyOverrides(result, parsed, true);
  }

  return result;
});

export const overrideFeatureSwitch$ = command(
  ({ get, set }, overrides: Partial<Record<FeatureSwitchKey, boolean>>) => {
    const current = get(get$);
    const parsed = {
      ...(current
        ? jsonParseOr<Partial<Record<FeatureSwitchKey, boolean>>>(current, {})
        : {}),
      ...overrides,
    };
    set(set$, JSON.stringify(parsed));
    set(internalReload$, (v) => {
      return v + 1;
    });
  },
);

export const syncFeatureSwitchToDB$ = command(
  async (
    { get, set },
    overrides: Partial<Record<FeatureSwitchKey, boolean>>,
    signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroFeatureSwitchesContract);
    signal.throwIfAborted();
    await accept(client.update({ body: { switches: overrides } }), [200]);
    signal.throwIfAborted();
    set(internalReload$, (v) => {
      return v + 1;
    });
  },
);

export const resetFeatureSwitchOverrides$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    // Clear localStorage
    set(clear$);

    // Clear DB overrides by writing empty switches (no-op merge — DB overrides persist)
    const createClient = get(zeroClient$);
    const client = createClient(zeroFeatureSwitchesContract);
    signal.throwIfAborted();
    await accept(client.update({ body: { switches: {} } }), [200]);
    signal.throwIfAborted();

    set(internalReload$, (v) => {
      return v + 1;
    });
  },
);

export const setFeatureSwitchLocalStorage$ = set$;
