// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useLoadable, useLastResolved, useGet } from "ccstate-react";
import {
  IconAdjustmentsHorizontal,
  IconUser,
  IconLogout,
  IconPlus,
  IconChevronRight,
  IconSwitchHorizontal,
  IconDatabaseExport,
  IconKey,
  IconChartBar,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@vm0/ui";
import { clerk$, user$, resolveWebOrigin } from "../../signals/auth.ts";
import { detach, Reason } from "../../signals/utils.ts";
import type { ZeroAccountAction } from "../../signals/zero-page/zero-nav.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { apiBaseForNavigation$ } from "../../signals/fetch.ts";

interface SessionAccount {
  sessionId: string;
  name: string;
  email: string;
  initial: string;
  imageUrl: string | undefined;
  isActive: boolean;
}

function AccountAvatar({
  imageUrl,
  name,
  initial,
  size = "sm",
}: {
  imageUrl: string | undefined;
  name: string;
  initial: string;
  size?: "sm" | "md";
}) {
  const dim = size === "md" ? "h-9 w-9" : "h-8 w-8";
  const textSize = size === "md" ? "text-sm" : "text-xs";
  if (imageUrl) {
    return (
      <div className={`${dim} shrink-0 rounded-xl overflow-hidden`}>
        <img src={imageUrl} alt={name} className="h-full w-full object-cover" />
      </div>
    );
  }
  return (
    <div
      className={`${dim} rounded-xl bg-orange-200/95 dark:bg-orange-300/80 flex items-center justify-center text-orange-900 dark:text-orange-950 ${textSize} font-medium shrink-0`}
    >
      {initial}
    </div>
  );
}

function useAccountSessions() {
  const clerkLoadable = useLoadable(clerk$);
  const userLoadable = useLoadable(user$);
  const user = userLoadable.state === "hasData" ? userLoadable.data : null;
  const clerk = clerkLoadable.state === "hasData" ? clerkLoadable.data : null;

  const currentSessionId = clerk?.session?.id;
  const accounts: SessionAccount[] = (clerk?.client?.sessions ?? [])
    .filter((s) => {
      return s.status === "active";
    })
    .map((s) => {
      return {
        sessionId: s.id,
        name: s.user?.fullName ?? "User",
        email: s.user?.primaryEmailAddress?.emailAddress ?? "",
        initial: s.user?.fullName
          ? s.user.fullName.charAt(0).toUpperCase()
          : "U",
        imageUrl: s.user?.imageUrl,
        isActive: s.id === currentSessionId,
      };
    });

  return { user, clerk, accounts };
}

export function AccountDropdown({
  onAccountAction,
  collapsed = false,
  hidePreferences = false,
}: {
  onAccountAction?: (action: ZeroAccountAction) => void;
  collapsed?: boolean;
  hidePreferences?: boolean;
}) {
  const { user, clerk, accounts } = useAccountSessions();
  const features = useLastResolved(featureSwitch$);
  const apiBase = useGet(apiBaseForNavigation$);
  const showExportData = features?.[FeatureSwitchKey.DataExport] ?? false;
  const apiKeysEnabled = features?.[FeatureSwitchKey.ApiKeys] ?? false;
  const accountName = user?.fullName ?? "User";
  const accountEmail = user?.primaryEmailAddress?.emailAddress ?? "";
  const accountInitial = accountName.charAt(0).toUpperCase();

  const current = accounts.find((a) => {
    return a.isActive;
  });
  const others = accounts.filter((a) => {
    return !a.isActive;
  });
  const hasOthers = others.length > 0;

  const handleAccountAction = (action: ZeroAccountAction) => {
    if (action === "signout") {
      const sessionId = clerk?.session?.id;
      const signInUrl = `${resolveWebOrigin()}/sign-in?redirect_url=${encodeURIComponent(location.href)}`;
      detach(
        clerk?.signOut({ sessionId, redirectUrl: signInUrl }),
        Reason.DomCallback,
      );
      return;
    }
    if (action === "manage") {
      detach(clerk?.openUserProfile(), Reason.DomCallback);
      return;
    }
    onAccountAction?.(action);
  };

  const handleSwitchSession = (sessionId: string) => {
    detach(
      clerk?.setActive({
        session: sessionId,
        beforeEmit: () => {
          return window.location.reload();
        },
      }),
      Reason.DomCallback,
    );
  };

  const handleAddAccount = () => {
    detach(clerk?.openSignIn(), Reason.DomCallback);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`rounded-lg transition-colors duration-200 ${
            collapsed
              ? "inline-flex h-8 w-8 shrink-0 items-center justify-center p-0 hover:bg-sidebar-accent"
              : "flex w-full items-center gap-2 p-2 text-left hover:bg-sidebar-accent"
          }`}
        >
          <AccountAvatar
            imageUrl={user?.imageUrl}
            name={accountName}
            initial={accountInitial}
          />
          {!collapsed && (
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium leading-tight truncate text-sidebar-foreground">
                {accountName}
              </p>
              <p className="text-xs leading-tight truncate mt-px text-sidebar-foreground opacity-70">
                {accountEmail}
              </p>
            </div>
          )}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[240px]"
      >
        {/* Current account header */}
        {current && (
          <>
            <div className="px-3 py-3">
              <div className="flex items-center gap-3">
                <AccountAvatar
                  imageUrl={current.imageUrl}
                  name={current.name}
                  initial={current.initial}
                  size="md"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">
                    {current.name}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {current.email}
                  </div>
                </div>
              </div>
            </div>
            <DropdownMenuSeparator />
          </>
        )}

        {/* Preferences + Usage group */}
        {!hidePreferences && (
          <>
            <DropdownMenuItem
              onClick={() => {
                return handleAccountAction("preferences");
              }}
              className="gap-3 px-3 py-2.5 rounded-lg"
            >
              <IconAdjustmentsHorizontal
                size={18}
                stroke={1.5}
                className="text-muted-foreground"
              />
              <span>Preferences</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                return handleAccountAction("usage");
              }}
              className="gap-3 px-3 py-2.5 rounded-lg"
            >
              <IconChartBar
                size={18}
                stroke={1.5}
                className="text-muted-foreground"
              />
              <span>Usage</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}

        {/* Account management group */}
        {hasOthers ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-3 px-3 py-2.5 rounded-lg">
              <IconSwitchHorizontal
                size={18}
                stroke={1.5}
                className="text-muted-foreground"
              />
              <span className="flex-1">Switch account</span>
              <IconChevronRight
                size={14}
                stroke={1.5}
                className="text-muted-foreground"
              />
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-[220px]">
              {others.map((account) => {
                return (
                  <DropdownMenuItem
                    key={account.sessionId}
                    onClick={() => {
                      return handleSwitchSession(account.sessionId);
                    }}
                    className="gap-3 px-3 py-2.5 rounded-lg"
                  >
                    <AccountAvatar
                      imageUrl={account.imageUrl}
                      name={account.name}
                      initial={account.initial}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-foreground truncate">
                        {account.name}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {account.email}
                      </div>
                    </div>
                  </DropdownMenuItem>
                );
              })}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleAddAccount}
                className="gap-3 px-3 py-2.5 rounded-lg"
              >
                <IconPlus
                  size={18}
                  stroke={1.5}
                  className="text-muted-foreground"
                />
                <span>Add account</span>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : (
          <DropdownMenuItem
            onClick={handleAddAccount}
            className="gap-3 px-3 py-2.5 rounded-lg"
          >
            <IconPlus
              size={18}
              stroke={1.5}
              className="text-muted-foreground"
            />
            <span>Add account</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => {
            return handleAccountAction("manage");
          }}
          className="gap-3 px-3 py-2.5 rounded-lg"
        >
          <IconUser size={18} stroke={1.5} className="text-muted-foreground" />
          <span>Manage account</span>
        </DropdownMenuItem>
        {apiKeysEnabled && (
          <DropdownMenuItem
            onClick={() => {
              return handleAccountAction("apiKeys");
            }}
            className="gap-3 px-3 py-2.5 rounded-lg"
          >
            <IconKey size={18} stroke={1.5} className="text-muted-foreground" />
            <span>API Keys</span>
          </DropdownMenuItem>
        )}
        {showExportData && (
          <DropdownMenuItem
            onClick={() => {
              return window.open(`${apiBase}/export`, "_blank");
            }}
            className="gap-3 px-3 py-2.5 rounded-lg"
          >
            <IconDatabaseExport
              size={18}
              stroke={1.5}
              className="text-muted-foreground"
            />
            <span>Export data</span>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            return handleAccountAction("signout");
          }}
          className="gap-3 px-3 py-2.5 rounded-lg"
        >
          <IconLogout
            size={18}
            stroke={1.5}
            className="text-muted-foreground"
          />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
