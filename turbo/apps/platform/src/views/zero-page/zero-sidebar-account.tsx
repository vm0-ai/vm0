// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import {
  useGet,
  useLoadable,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { useTranslation } from "react-i18next";
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
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
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
import { clerk$, currentUserInfo$ } from "../../signals/auth.ts";
import { suppressUnauthorizedRedirectForAuthTransition$ } from "../../signals/auth-retry.ts";
import {
  reloadAccountMenuSubscriptionUsageRows$,
  type AccountMenuSubscriptionUsageRowsCacheKey,
} from "../../signals/zero-page/account-menu-subscriptions.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  setSidebarExpanded$,
  type ZeroAccountAction,
} from "../../signals/zero-page/zero-nav.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  consumePendingAccountMenuSettingsSection$,
  openSettingsDialogAt$,
  setPendingAccountMenuSettingsSection$,
  type SettingsSection,
} from "../../signals/zero-page/settings/settings-dialog.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { isOrgAdmin$ } from "../../signals/org.ts";
import {
  billingStatusAsync$,
  reloadBillingStatus$,
} from "../../signals/zero-page/billing.ts";
import {
  accountMenuCodexResetDialog$,
  personalActionPromise$,
  resetPersonalCodexSubscriptionUsage$,
  setAccountMenuCodexResetDialog$,
} from "../../signals/zero-page/settings/personal-model-providers.ts";
import { CodexResetUsageDialog } from "./components/preferences/codex-reset-usage-dialog.tsx";
import {
  AccountMenuSubscriptionsPanel,
  useSubscriptionUsageRows,
} from "./zero-sidebar-subscriptions.tsx";
import { DropdownMenuModalItem } from "../components/dropdown-menu-modal-item.tsx";

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
  const { t } = useTranslation();
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
        name:
          s.user?.fullName ??
          t(($) => {
            return $.settings.accountMenu.userFallback;
          }),
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

function subscriptionRowsCacheKeyFrom({
  clerk,
  current,
  user,
}: {
  clerk: { session?: { id?: string } | null } | null;
  current: SessionAccount | undefined;
  user: { id: string } | undefined;
}): AccountMenuSubscriptionUsageRowsCacheKey {
  return clerk?.session?.id ?? current?.sessionId ?? user?.id ?? null;
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
  userFallback: string,
): AccountDisplay {
  const name = user?.fullName ?? fallback?.name ?? userFallback;
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

function AccountUsageGroup({
  onOpenCreditBalance,
  onResetCodexUsage,
  resetPending,
  subscriptionRowsCacheKey,
  subscriptionsEnabled,
}: {
  onOpenCreditBalance: () => void;
  onResetCodexUsage: (resetCredits: number | null) => void;
  resetPending: boolean;
  subscriptionRowsCacheKey: AccountMenuSubscriptionUsageRowsCacheKey;
  subscriptionsEnabled: boolean;
}) {
  const isAdminLoadable = useLastLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" && isAdminLoadable.data === true;

  if (subscriptionsEnabled) {
    return isAdmin ? (
      <AccountUsageGroupWithCredit
        onOpenCreditBalance={onOpenCreditBalance}
        onResetCodexUsage={onResetCodexUsage}
        resetPending={resetPending}
        subscriptionRowsCacheKey={subscriptionRowsCacheKey}
      />
    ) : (
      <AccountSubscriptionsGroup
        onResetCodexUsage={onResetCodexUsage}
        resetPending={resetPending}
        subscriptionRowsCacheKey={subscriptionRowsCacheKey}
      />
    );
  }

  return isAdmin ? (
    <AccountCreditBalanceGroup onOpenCreditBalance={onOpenCreditBalance} />
  ) : null;
}

function AccountCreditBalanceGroup({
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
      <CreditBalanceItem
        creditLabel={creditLabel}
        loading={loading}
        onOpenCreditBalance={onOpenCreditBalance}
      />
      <DropdownMenuSeparator />
    </>
  );
}

function AccountUsageGroupWithCredit({
  onOpenCreditBalance,
  onResetCodexUsage,
  resetPending,
  subscriptionRowsCacheKey,
}: {
  onOpenCreditBalance: () => void;
  onResetCodexUsage: (resetCredits: number | null) => void;
  resetPending: boolean;
  subscriptionRowsCacheKey: AccountMenuSubscriptionUsageRowsCacheKey;
}) {
  const billingLoadable = useLastLoadable(billingStatusAsync$);
  const { loading: subscriptionsLoading, rows } = useSubscriptionUsageRows({
    cacheKey: subscriptionRowsCacheKey,
  });
  const credits =
    billingLoadable.state === "hasData" ? billingLoadable.data.credits : null;
  const creditLoading = billingLoadable.state === "loading" && credits === null;
  const creditLabel =
    credits !== null
      ? `${credits.toLocaleString("en-US")} ${credits === 1 ? "credit" : "credits"}`
      : null;
  const showCredit = creditLoading || creditLabel !== null;
  const showSubscriptions = subscriptionsLoading || rows.length > 0;

  if (!showCredit && !showSubscriptions) {
    return null;
  }

  return (
    <>
      {showCredit && (
        <CreditBalanceItem
          creditLabel={creditLabel}
          loading={creditLoading}
          onOpenCreditBalance={onOpenCreditBalance}
        />
      )}
      {showCredit && showSubscriptions && <DropdownMenuSeparator />}
      {showSubscriptions && (
        <AccountMenuSubscriptionsPanel
          loading={subscriptionsLoading}
          onResetCodexUsage={onResetCodexUsage}
          resetPending={resetPending}
          rows={rows}
        />
      )}
      <DropdownMenuSeparator />
    </>
  );
}

function AccountSubscriptionsGroup({
  onResetCodexUsage,
  resetPending,
  subscriptionRowsCacheKey,
}: {
  onResetCodexUsage: (resetCredits: number | null) => void;
  resetPending: boolean;
  subscriptionRowsCacheKey: AccountMenuSubscriptionUsageRowsCacheKey;
}) {
  const { loading, rows } = useSubscriptionUsageRows({
    cacheKey: subscriptionRowsCacheKey,
  });
  const showSubscriptions = loading || rows.length > 0;

  if (!showSubscriptions) {
    return null;
  }

  return (
    <>
      <AccountMenuSubscriptionsPanel
        loading={loading}
        onResetCodexUsage={onResetCodexUsage}
        resetPending={resetPending}
        rows={rows}
      />
      <DropdownMenuSeparator />
    </>
  );
}

function CreditBalanceItem({
  creditLabel,
  loading,
  onOpenCreditBalance,
}: {
  creditLabel: string | null;
  loading: boolean;
  onOpenCreditBalance: () => void;
}) {
  return (
    <DropdownMenuModalItem
      onModalSelect={onOpenCreditBalance}
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
    </DropdownMenuModalItem>
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
  const { t } = useTranslation();
  return (
    <>
      <DropdownMenuModalItem
        onModalSelect={onOpenSettings}
        className="gap-3 px-3 py-2.5 rounded-lg"
      >
        <IconSettings
          size={18}
          stroke={1.5}
          className="text-muted-foreground"
        />
        <span>
          {t(($) => {
            return $.settings.accountMenu.settings;
          })}
        </span>
      </DropdownMenuModalItem>
      {labEnabled && (
        <DropdownMenuItem
          onClick={() => {
            return onAccountAction("lab");
          }}
          className="gap-3 px-3 py-2.5 rounded-lg"
        >
          <IconFlask size={18} stroke={1.5} className="text-muted-foreground" />
          <span>
            {t(($) => {
              return $.settings.accountMenu.lab;
            })}
          </span>
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
  const { t } = useTranslation();
  if (others.length === 0) {
    return (
      <DropdownMenuItem
        onClick={onAddAccount}
        className="gap-3 px-3 py-2.5 rounded-lg"
      >
        <IconPlus size={18} stroke={1.5} className="text-muted-foreground" />
        <span>
          {t(($) => {
            return $.settings.accountMenu.addAccount;
          })}
        </span>
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
        <span className="flex-1">
          {t(($) => {
            return $.settings.accountMenu.switchAccount;
          })}
        </span>
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
          <span>
            {t(($) => {
              return $.settings.accountMenu.addAccount;
            })}
          </span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function ExtraAccountActions() {
  const { t } = useTranslation();
  return (
    <DropdownMenuItem
      onClick={() => {
        return window.open(`${window.location.origin}/export`, "_blank");
      }}
      className="gap-3 px-3 py-2.5 rounded-lg"
    >
      <IconDatabaseExport
        size={18}
        stroke={1.5}
        className="text-muted-foreground"
      />
      <span>
        {t(($) => {
          return $.settings.accountMenu.exportData;
        })}
      </span>
    </DropdownMenuItem>
  );
}

function SignOutItem({
  onAccountAction,
}: {
  onAccountAction: (action: ZeroAccountAction) => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenuItem
      onClick={() => {
        return onAccountAction("signout");
      }}
      className="gap-3 px-3 py-2.5 rounded-lg"
    >
      <IconLogout size={18} stroke={1.5} className="text-muted-foreground" />
      <span>
        {t(($) => {
          return $.settings.accountMenu.signOut;
        })}
      </span>
    </DropdownMenuItem>
  );
}

export function AccountDropdown({
  onAccountAction,
  settingsOwnerId,
  collapsed = false,
  hidePreferences = false,
}: {
  onAccountAction?: (action: ZeroAccountAction) => void;
  settingsOwnerId: string;
  collapsed?: boolean;
  hidePreferences?: boolean;
}) {
  const { t } = useTranslation();
  const { clerk, accounts } = useAccountSessions();
  const userInfoLoadable = useLoadable(currentUserInfo$);
  const user =
    userInfoLoadable.state === "hasData" ? userInfoLoadable.data : undefined;
  const features = useLastResolved(featureSwitch$);
  const labEnabled = features?.[FeatureSwitchKey.Lab] ?? false;
  const subscriptionsEnabled =
    features?.[FeatureSwitchKey.SidebarSubscriptionUsage] ?? false;
  const openSettings = useSet(openSettingsDialogAt$);
  const setPendingSettingsSection = useSet(
    setPendingAccountMenuSettingsSection$,
  );
  const consumePendingSettingsSection = useSet(
    consumePendingAccountMenuSettingsSection$,
  );
  const reloadSubscriptions = useSet(reloadAccountMenuSubscriptionUsageRows$);
  const reloadBilling = useSet(reloadBillingStatus$);
  const resetCodexSubscriptionUsage = useSet(
    resetPersonalCodexSubscriptionUsage$,
  );
  const resetDialog = useGet(accountMenuCodexResetDialog$);
  const setResetDialog = useSet(setAccountMenuCodexResetDialog$);
  const actionLoadable = useLoadable(personalActionPromise$);
  const setSidebarExpanded = useSet(setSidebarExpanded$);
  const suppressUnauthorizedRedirectForAuthTransition = useSet(
    suppressUnauthorizedRedirectForAuthTransition$,
  );
  const pageSignal = useGet(pageSignal$);

  const current = accounts.find((a) => {
    return a.isActive;
  });
  const subscriptionRowsCacheKey = subscriptionRowsCacheKeyFrom({
    clerk,
    current,
    user,
  });
  const accountDisplay = accountDisplayFrom(
    user,
    current,
    t(($) => {
      return $.settings.accountMenu.userFallback;
    }),
  );
  const others = accounts.filter((a) => {
    return !a.isActive;
  });
  const actionPending = actionLoadable.state === "loading";

  const handleAccountAction = (action: ZeroAccountAction) => {
    if (action === "signout") {
      const sessionId = clerk?.session?.id;
      const signInUrl = clerk?.buildSignInUrl({ redirectUrl: location.href });
      detach(
        clerk?.signOut({ sessionId, redirectUrl: signInUrl }),
        Reason.DomCallback,
      );
      return;
    }
    onAccountAction?.(action);
  };

  const handleSwitchSession = (sessionId: string) => {
    suppressUnauthorizedRedirectForAuthTransition();
    detach(
      clerk?.setActive({
        session: sessionId,
        navigate: ({ session, decorateUrl }) => {
          // Navigate to "/" rather than reloading the current URL: the new
          // account may not have access to the current route (e.g. an org
          // scoped chat/agent id), which would otherwise render as 404.
          const destination = session.currentTask
            ? `/sign-in/tasks/${session.currentTask.key}`
            : "/";
          window.location.href = decorateUrl(destination);
        },
      }),
      Reason.DomCallback,
    );
  };

  const handleAddAccount = () => {
    suppressUnauthorizedRedirectForAuthTransition();
    detach(
      clerk?.openSignIn({
        fallbackRedirectUrl: "/",
        forceRedirectUrl: "/",
      }),
      Reason.DomCallback,
    );
  };

  const queueSettingsOpen = (section: SettingsSection) => {
    setSidebarExpanded(false);
    setPendingSettingsSection(settingsOwnerId, section);
  };

  const handleOpenSettings = () => {
    queueSettingsOpen("preference");
  };

  const handleOpenCreditBalance = () => {
    queueSettingsOpen("usage");
  };

  const handleOpenCodexReset = (resetCredits: number | null) => {
    setResetDialog({ open: true, resetCredits });
  };

  const handleConfirmCodexReset = () => {
    detach(
      (async () => {
        await resetCodexSubscriptionUsage(pageSignal);
        await reloadSubscriptions(subscriptionRowsCacheKey, pageSignal);
        setResetDialog({ open: false, resetCredits: null });
      })(),
      Reason.DomCallback,
    );
  };

  const handleCodexResetOpenChange = (open: boolean) => {
    setResetDialog({
      open,
      resetCredits: open ? resetDialog.resetCredits : null,
    });
  };

  const handleMenuOpenChange = (open: boolean) => {
    if (!open) {
      return;
    }
    setPendingSettingsSection(settingsOwnerId, null);
    if (hidePreferences) {
      return;
    }
    // Refresh the org credit balance every time the menu opens so the
    // displayed remaining credit reflects the latest usage.
    reloadBilling();
    if (!subscriptionsEnabled) {
      return;
    }

    detach(
      reloadSubscriptions(subscriptionRowsCacheKey, pageSignal),
      Reason.DomCallback,
      "reload account menu subscriptions",
    );
  };

  return (
    <>
      <DropdownMenu onOpenChange={handleMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          {renderAccountTrigger(accountDisplay, collapsed)}
        </DropdownMenuTrigger>

        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-[240px]"
          onCloseAutoFocus={(event) => {
            const section = consumePendingSettingsSection(settingsOwnerId);
            if (section === null) {
              return;
            }
            event.preventDefault();
            detach(openSettings(section, pageSignal), Reason.DomCallback);
          }}
        >
          <CurrentAccountHeader
            display={accountDisplay}
            visible={current !== undefined || user !== undefined}
          />
          {!hidePreferences && (
            <AccountUsageGroup
              onOpenCreditBalance={handleOpenCreditBalance}
              onResetCodexUsage={handleOpenCodexReset}
              resetPending={actionPending}
              subscriptionRowsCacheKey={subscriptionRowsCacheKey}
              subscriptionsEnabled={subscriptionsEnabled}
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
          <ExtraAccountActions />
          <DropdownMenuSeparator />
          <SignOutItem onAccountAction={handleAccountAction} />
        </DropdownMenuContent>
      </DropdownMenu>
      <CodexResetUsageDialog
        open={resetDialog.open}
        resetCredits={resetDialog.resetCredits}
        resetting={actionPending}
        onOpenChange={handleCodexResetOpenChange}
        onConfirm={handleConfirmCodexReset}
      />
    </>
  );
}
