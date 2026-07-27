import { useGet, useLoadable, useSet } from "ccstate-react";
import { IconUser } from "@tabler/icons-react";
import { Button } from "@vm0/ui/components/ui/button";
import { currentUserInfo$ } from "../../../../../signals/auth.ts";
import {
  openSettingsUserProfile$,
  settingsClerkProfilePortalContainer$,
  settingsDialogSignal$,
} from "../../../../../signals/zero-page/settings/settings-dialog.ts";
import { detach, Reason } from "../../../../../signals/utils.ts";

export function AccountSection() {
  const clerkProfilePortalContainer = useGet(
    settingsClerkProfilePortalContainer$,
  );
  const settingsDialogSignal = useGet(settingsDialogSignal$);
  const openUserProfile = useSet(openSettingsUserProfile$);
  const userLoadable = useLoadable(currentUserInfo$);
  const user = userLoadable.state === "hasData" ? userLoadable.data : undefined;

  const displayName = user?.fullName ?? user?.firstName ?? "";
  const email = user?.primaryEmailAddress?.emailAddress ?? "";
  const initial = (displayName || email || "U").charAt(0).toUpperCase();

  return (
    <div className="flex items-center gap-4 bg-card rounded-xl zero-border p-5">
      {user?.imageUrl ? (
        <img
          src={user.imageUrl}
          alt=""
          className="h-12 w-12 rounded-xl object-cover shrink-0"
        />
      ) : (
        <div className="h-12 w-12 rounded-xl bg-muted flex items-center justify-center text-sm font-medium text-muted-foreground shrink-0">
          {initial}
        </div>
      )}
      <div className="flex-1 min-w-0">
        {displayName && (
          <div className="text-sm font-medium text-foreground truncate">
            {displayName}
          </div>
        )}
        {email && (
          <div className="text-sm text-muted-foreground truncate">{email}</div>
        )}
      </div>
      <Button
        onClick={() => {
          if (settingsDialogSignal) {
            detach(openUserProfile(settingsDialogSignal), Reason.DomCallback);
          }
        }}
        disabled={!clerkProfilePortalContainer || !settingsDialogSignal}
        className="shrink-0"
      >
        <IconUser size={14} />
        Manage
      </Button>
    </div>
  );
}
