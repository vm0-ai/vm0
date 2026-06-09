import { command, computed, state } from "ccstate";
import type { UserPermissionGrantExpiresIn } from "@vm0/api-contracts/contracts/zero-user-permission-grants";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_USER_PERMISSION_GRANT_EXPIRES_IN: UserPermissionGrantExpiresIn =
  "1h";

export const USER_PERMISSION_GRANT_EXPIRES_IN_OPTIONS: readonly {
  readonly value: UserPermissionGrantExpiresIn;
  readonly label: string;
}[] = [
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "always", label: "Always" },
];

export function parseUserPermissionGrantExpiresIn(
  value: string | null,
): UserPermissionGrantExpiresIn | null {
  for (const option of USER_PERMISSION_GRANT_EXPIRES_IN_OPTIONS) {
    if (option.value === value) {
      return option.value;
    }
  }
  return null;
}

export function userPermissionGrantExpiresAt(
  expiresIn: UserPermissionGrantExpiresIn | undefined,
  nowMs = Date.now(),
): string | null {
  switch (expiresIn) {
    case "1h": {
      return new Date(nowMs + HOUR_MS).toISOString();
    }
    case "24h": {
      return new Date(nowMs + DAY_MS).toISOString();
    }
    case "7d": {
      return new Date(nowMs + 7 * DAY_MS).toISOString();
    }
    case "always":
    case undefined: {
      return null;
    }
  }
}

export function requestedUserPermissionGrantExpirationAlreadyApplies({
  expiresIn,
  currentExpiresAt,
}: {
  expiresIn: UserPermissionGrantExpiresIn | null;
  currentExpiresAt: string | null | undefined;
}): boolean {
  if (expiresIn === null) {
    return true;
  }
  if (expiresIn === "always") {
    return currentExpiresAt === null;
  }
  return false;
}

export function permissionGrantExpiryText(
  expiresAt: string | null,
  nowMs = Date.now(),
): string | null {
  if (!expiresAt) {
    return null;
  }
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return null;
  }
  const remainingMs = expiresAtMs - nowMs;
  if (remainingMs <= 0) {
    return "Expired";
  }
  if (remainingMs >= DAY_MS) {
    const days = Math.ceil(remainingMs / DAY_MS);
    return `Expires in ${days} day${days === 1 ? "" : "s"}`;
  }
  if (remainingMs < HOUR_MS - MINUTE_MS) {
    return "Expires in less than 1 hour";
  }
  const hours = Math.ceil(remainingMs / HOUR_MS);
  return `Expires in ${hours} hour${hours === 1 ? "" : "s"}`;
}

const internalPermissionGrantExpiresInByScope$ = state<
  Record<string, UserPermissionGrantExpiresIn>
>({});

export const permissionGrantExpiresInByScope$ = computed((get) => {
  return get(internalPermissionGrantExpiresInByScope$);
});

export const setPermissionGrantExpiresIn$ = command(
  ({ get, set }, scope: string, expiresIn: UserPermissionGrantExpiresIn) => {
    const current = get(internalPermissionGrantExpiresInByScope$);
    set(internalPermissionGrantExpiresInByScope$, {
      ...current,
      [scope]: expiresIn,
    });
  },
);
