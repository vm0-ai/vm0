import { command, computed, state } from "ccstate";
import type { UserPermissionGrantExpiresIn } from "@vm0/api-contracts/contracts/zero-user-permission-grants";

import { now } from "../../lib/time.ts";
import { i18n } from "../../i18n/index.ts";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_USER_PERMISSION_GRANT_EXPIRES_IN: UserPermissionGrantExpiresIn =
  "1h";

export const USER_PERMISSION_GRANT_EXPIRES_IN_OPTIONS: readonly UserPermissionGrantExpiresIn[] =
  ["1h", "24h", "7d", "always"];

export function parseUserPermissionGrantExpiresIn(
  value: string | null,
): UserPermissionGrantExpiresIn | null {
  for (const option of USER_PERMISSION_GRANT_EXPIRES_IN_OPTIONS) {
    if (option === value) {
      return option;
    }
  }
  return null;
}

export function userPermissionGrantExpiresAt(
  expiresIn: UserPermissionGrantExpiresIn | undefined,
  nowMs = now(),
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

export function permissionGrantExpiryText(
  expiresAt: string | null,
  nowMs = now(),
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
    return i18n.t(($) => {
      return $.authorization.permission.expiration.expired;
    });
  }
  if (remainingMs >= DAY_MS) {
    return i18n.t(
      ($) => {
        return $.authorization.permission.expiration.inDays;
      },
      { count: Math.ceil(remainingMs / DAY_MS) },
    );
  }
  if (remainingMs < HOUR_MS - MINUTE_MS) {
    return i18n.t(($) => {
      return $.authorization.permission.expiration.lessThanHour;
    });
  }
  return i18n.t(
    ($) => {
      return $.authorization.permission.expiration.inHours;
    },
    { count: Math.ceil(remainingMs / HOUR_MS) },
  );
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
