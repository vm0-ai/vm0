import { useGet, useLoadable } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { Button } from "@okouai/ui/components/ui/button";
import {
  clerkInstance$,
  currentUserInfo$,
  resolveClerkSatelliteConfig,
} from "../../../../../signals/auth.ts";
import { UserAvatar } from "../../../../components/avatar.tsx";

// Clerk satellite domains do not receive their own hosted Account Portal.
const CLERK_PRIMARY_USER_PROFILE_URL = "https://accounts.vm0.ai/user";

export function AccountSection() {
  const { t } = useTranslation();
  const clerk = useGet(clerkInstance$);
  const userLoadable = useLoadable(currentUserInfo$);
  const user = userLoadable.state === "hasData" ? userLoadable.data : undefined;
  const userProfileUrl = resolveClerkSatelliteConfig()
    ? CLERK_PRIMARY_USER_PROFILE_URL
    : clerk.buildUrlWithAuth(clerk.buildUserProfileUrl());

  const displayName = user?.fullName ?? user?.firstName ?? "";
  const email = user?.primaryEmailAddress?.emailAddress ?? "";
  const initial = (displayName || email || "U").charAt(0).toUpperCase();

  return (
    <div className="zero-card flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <UserAvatar
          imageUrl={user?.imageUrl}
          name={displayName}
          initial={initial}
          size="xl"
        />
        <div className="min-w-0 flex-1">
          {displayName && (
            <div className="truncate text-sm font-medium text-foreground">
              {displayName}
            </div>
          )}
          {email && (
            <div className="truncate text-sm text-muted-foreground">
              {email}
            </div>
          )}
        </div>
      </div>
      <Button asChild className="w-full shrink-0 sm:w-auto">
        <a href={userProfileUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={14} />
          {t(($) => {
            return $.settings.preferences.account.manage;
          })}
        </a>
      </Button>
    </div>
  );
}
