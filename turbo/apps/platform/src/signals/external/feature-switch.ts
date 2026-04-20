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

// The localStorage override is an optimistic buffer that bridges the gap
// between a user toggle and the DB confirming the write. Once the sync
// settles (success, HTTP error, or abort) the keys must be stripped so
// `featureSwitch$` falls through to DB truth; otherwise a silently-dropped
// DB write leaves a permanent phantom state that only the frontend sees.
const clearFeatureSwitchLocalKeys$ = command(({ get, set }, keys: string[]) => {
  const current = get(get$);
  if (!current) {
    return;
  }
  const parsed = jsonParseOr<Partial<Record<string, boolean>>>(current, {});
  let changed = false;
  for (const key of keys) {
    if (key in parsed) {
      delete parsed[key];
      changed = true;
    }
  }
  if (!changed) {
    return;
  }
  if (Object.keys(parsed).length === 0) {
    set(clear$);
  } else {
    set(set$, JSON.stringify(parsed));
  }
});

export const syncFeatureSwitchToDB$ = command(
  async (
    { get, set },
    overrides: Partial<Record<FeatureSwitchKey, boolean>>,
    signal: AbortSignal,
  ) => {
    const createClient = get(zeroClient$);
    const client = createClient(zeroFeatureSwitchesContract);

    const work = async () => {
      signal.throwIfAborted();
      await accept(client.update({ body: { switches: overrides } }), [200]);
      signal.throwIfAborted();
    };

    await work().finally(() => {
      set(clearFeatureSwitchLocalKeys$, Object.keys(overrides));
      set(internalReload$, (v) => {
        return v + 1;
      });
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
export const getFeatureSwitchLocalStorage$ = get$;
