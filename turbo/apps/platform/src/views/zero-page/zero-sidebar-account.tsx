// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import {
  useGet,
  useLoadable,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import {
  IconLogout,
  IconPlus,
  IconChevronRight,
  IconSettings,
  IconSwitchHorizontal,
  IconDatabaseExport,
  IconFlask,
  IconCoins,
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
import {
  clerk$,
  currentUserInfo$,
  resolveWebOrigin,
} from "../../signals/auth.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  setSidebarExpanded$,
  type ZeroAccountAction,
} from "../../signals/zero-page/zero-nav.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { openSettingsDialogAt$ } from "../../signals/zero-page/settings/settings-dialog.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { apiBaseForNavigation$ } from "../../signals/fetch.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import { billingStatusAsync$ } from "../../signals/zero-page/billing.ts";

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

  return { clerk, accounts };
}

interface AccountDisplay {
  name: string;
  email: string;
  initial: string;
  imageUrl: string | undefined;
}

function accountDisplayFrom(
  user:
    | {
        fullName: string | null;
        imageUrl: string | undefined;
        primaryEmailAddress: { emailAddress: string } | null;
      }
    | undefined,
  fallback: SessionAccount | undefined,
): AccountDisplay {
  const name = user?.fullName ?? fallback?.name ?? "User";
  return {
    name,
    email: user?.primaryEmailAddress?.emailAddress ?? fallback?.email ?? "",
    initial: name.charAt(0).toUpperCase(),
    imageUrl: user?.imageUrl ?? fallback?.imageUrl,
  };
}

function renderAccountTrigger(display: AccountDisplay, collapsed: boolean) {
  return (
    <button
      type="button"
      className={`rounded-lg transition-colors duration-200 ${
        collapsed
          ? "inline-flex h-8 w-8 shrink-0 items-center justify-center p-0 hover:bg-sidebar-accent"
          : "flex w-full items-center gap-2 p-2 text-left hover:bg-sidebar-accent"
      }`}
    >
      <AccountAvatar
        imageUrl={display.imageUrl}
        name={display.name}
        initial={display.initial}
      />
      {!collapsed && (
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium leading-tight truncate text-sidebar-foreground">
            {display.name}
          </p>
          <p className="text-xs leading-tight truncate mt-px text-sidebar-foreground opacity-70">
            {display.email}
          </p>
        </div>
      )}
    </button>
  );
}

function CurrentAccountHeader({
  display,
  visible,
}: {
  display: AccountDisplay;
  visible: boolean;
}) {
  if (!visible) {
    return null;
  }
  return (
    <>
      <div className="px-3 py-3">
        <div className="flex items-center gap-3">
          <AccountAvatar
            imageUrl={display.imageUrl}
            name={display.name}
            initial={display.initial}
            size="md"
          />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground truncate">
              {display.name}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {display.email}
            </div>
          </div>
        </div>
      </div>
      <DropdownMenuSeparator />
    </>
  );
}

function AdminCreditBalanceItem({
  onOpenCreditBalance,
}: {
  onOpenCreditBalance: () => void;
}) {
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" && isAdminLoadable.data === true;

  if (!isAdmin) {
    return null;
  }

  return (
    <AdminCreditBalanceItemContent onOpenCreditBalance={onOpenCreditBalance} />
  );
}

function AdminCreditBalanceItemContent({
  onOpenCreditBalance,
}: {
  onOpenCreditBalance: () => void;
}) {
  const billingLoadable = useLastLoadable(billingStatusAsync$);

  const credits =
    billingLoadable.state === "hasData" ? billingLoadable.data.credits : null;
  const loading = billingLoadable.state === "loading" && credits === null;
  const creditLabel =
    credits !== null
      ? `${credits.toLocaleString("en-US")} ${credits === 1 ? "credit" : "credits"}`
      : null;

  if (!loading && creditLabel === null) {
    return null;
  }

  return (
    <>
      <DropdownMenuItem
        onClick={onOpenCreditBalance}
        className="gap-3 px-3 py-2.5 rounded-lg"
      >
        <IconCoins size={18} stroke={1.5} className="text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm tabular-nums">
          {loading ? (
            <span className="block h-4 w-24 rounded bg-muted/60" />
          ) : (
            creditLabel
          )}
        </span>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}

function UnifiedSettingsGroup({
  labEnabled,
  onAccountAction,
  onOpenSettings,
}: {
  labEnabled: boolean;
  onAccountAction: (action: ZeroAccountAction) => void;
  onOpenSettings: () => void;
}) {
  return (
    <>
      <DropdownMenuItem
        onClick={onOpenSettings}
        className="gap-3 px-3 py-2.5 rounded-lg"
      >
        <IconSettings
          size={18}
          stroke={1.5}
          className="text-muted-foreground"
        />
        <span>Settings</span>
      </DropdownMenuItem>
      {labEnabled && (
        <DropdownMenuItem
          onClick={() => {
            return onAccountAction("lab");
          }}
          className="gap-3 px-3 py-2.5 rounded-lg"
        >
          <IconFlask size={18} stroke={1.5} className="text-muted-foreground" />
          <span>Lab</span>
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
    </>
  );
}

function AccountManagementGroup({
  others,
  onSwitchSession,
  onAddAccount,
}: {
  others: SessionAccount[];
  onSwitchSession: (sessionId: string) => void;
  onAddAccount: () => void;
}) {
  if (others.length === 0) {
    return (
      <DropdownMenuItem
        onClick={onAddAccount}
        className="gap-3 px-3 py-2.5 rounded-lg"
      >
        <IconPlus size={18} stroke={1.5} className="text-muted-foreground" />
        <span>Add account</span>
      </DropdownMenuItem>
    );
  }
  return (
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
                return onSwitchSession(account.sessionId);
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
          onClick={onAddAccount}
          className="gap-3 px-3 py-2.5 rounded-lg"
        >
          <IconPlus size={18} stroke={1.5} className="text-muted-foreground" />
          <span>Add account</span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function ExtraAccountActions({
  showExportData,
  apiBase,
}: {
  showExportData: boolean;
  apiBase: string | undefined;
}) {
  if (!showExportData) {
    return null;
  }
  return (
    <DropdownMenuItem
      disabled={!apiBase}
      onClick={() => {
        if (!apiBase) {
          return;
        }
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
  );
}

function SignOutItem({
  onAccountAction,
}: {
  onAccountAction: (action: ZeroAccountAction) => void;
}) {
  return (
    <DropdownMenuItem
      onClick={() => {
        return onAccountAction("signout");
      }}
      className="gap-3 px-3 py-2.5 rounded-lg"
    >
      <IconLogout size={18} stroke={1.5} className="text-muted-foreground" />
      <span>Sign out</span>
    </DropdownMenuItem>
  );
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
  const { clerk, accounts } = useAccountSessions();
  const userInfoLoadable = useLoadable(currentUserInfo$);
  const user =
    userInfoLoadable.state === "hasData" ? userInfoLoadable.data : undefined;
  const features = useLastResolved(featureSwitch$);
  const apiBase = useLastResolved(apiBaseForNavigation$);
  const showExportData = features?.[FeatureSwitchKey.DataExport] ?? false;
  const labEnabled = features?.[FeatureSwitchKey.Lab] ?? false;
  const openSettings = useSet(openSettingsDialogAt$);
  const setSidebarExpanded = useSet(setSidebarExpanded$);
  const pageSignal = useGet(pageSignal$);

  const current = accounts.find((a) => {
    return a.isActive;
  });
  const accountDisplay = accountDisplayFrom(user, current);
  const others = accounts.filter((a) => {
    return !a.isActive;
  });

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
    onAccountAction?.(action);
  };

  const handleSwitchSession = (sessionId: string) => {
    detach(
      clerk?.setActive({
        session: sessionId,
        beforeEmit: () => {
          // Navigate to "/" rather than reloading the current URL: the new
          // account may not have access to the current route (e.g. an org
          // scoped chat/agent id), which would otherwise render as 404.
          window.location.href = "/";
        },
      }),
      Reason.DomCallback,
    );
  };

  const handleAddAccount = () => {
    detach(clerk?.openSignIn(), Reason.DomCallback);
  };

  const handleOpenSettings = () => {
    setSidebarExpanded(false);
    detach(openSettings("preference", pageSignal), Reason.DomCallback);
  };

  const handleOpenCreditBalance = () => {
    setSidebarExpanded(false);
    detach(openSettings("usage", pageSignal), Reason.DomCallback);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {renderAccountTrigger(accountDisplay, collapsed)}
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[240px]"
      >
        <CurrentAccountHeader
          display={accountDisplay}
          visible={current !== undefined || user !== undefined}
        />
        {!hidePreferences && (
          <AdminCreditBalanceItem
            onOpenCreditBalance={handleOpenCreditBalance}
          />
        )}
        {!hidePreferences && (
          <UnifiedSettingsGroup
            labEnabled={labEnabled}
            onAccountAction={handleAccountAction}
            onOpenSettings={handleOpenSettings}
          />
        )}
        <AccountManagementGroup
          others={others}
          onSwitchSession={handleSwitchSession}
          onAddAccount={handleAddAccount}
        />
        <ExtraAccountActions
          showExportData={showExportData}
          apiBase={apiBase}
        />
        <DropdownMenuSeparator />
        <SignOutItem onAccountAction={handleAccountAction} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
