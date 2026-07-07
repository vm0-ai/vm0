import { useLoadable } from "ccstate-react";
import type { UserPermissionGrantResponse } from "@vm0/api-contracts/contracts/zero-user-permission-grants";
import {
  nextUserPermissionGrantExpiryMs,
  userPermissionGrantExpiryTimer,
} from "../signals/user-permission-grants.ts";

export function useUserPermissionGrantExpiryTick(
  grants: readonly Pick<UserPermissionGrantResponse, "expiresAt">[],
): void {
  const nextExpiryMs = nextUserPermissionGrantExpiryMs(grants);
  useLoadable(userPermissionGrantExpiryTimer(nextExpiryMs));
}
