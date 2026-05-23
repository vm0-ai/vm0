import { useLoadable } from "ccstate-react";
import { IconUser } from "@tabler/icons-react";
import { Button } from "@vm0/ui/components/ui/button";
import { clerk$, currentUserInfo$ } from "../../../../../signals/auth.ts";
import { detach, Reason } from "../../../../../signals/utils.ts";

export function AccountSection() {
  const clerkLoadable = useLoadable(clerk$);
  const clerk = clerkLoadable.state === "hasData" ? clerkLoadable.data : null;
  const userLoadable = useLoadable(currentUserInfo$);
  const user = userLoadable.state === "hasData" ? userLoadable.data : undefined;

  const displayName = user?.fullName ?? user?.firstName ?? "";
  const email = user?.primaryEmailAddress?.emailAddress ?? "";
  const initial = (displayName || email || "U").charAt(0).toUpperCase();

  const handleOpen = () => {
    if (!clerk) {
      return;
    }
    detach(
      clerk.openUserProfile({ apiKeysProps: { hide: true } }),
      Reason.DomCallback,
    );
  };

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
      <Button onClick={handleOpen} disabled={!clerk} className="shrink-0">
        <IconUser size={14} />
        Manage account
      </Button>
    </div>
  );
}
