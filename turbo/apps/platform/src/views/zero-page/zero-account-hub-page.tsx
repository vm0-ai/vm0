import type { ReactNode } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import {
  IconAdjustmentsHorizontal,
  IconChartBar,
  IconChevronRight,
  IconDatabaseExport,
  IconKey,
  IconLogout,
  IconUser,
  IconUserPlus,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { clerk$, resolveWebOrigin, user$ } from "../../signals/auth.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { apiBaseForNavigation$ } from "../../signals/fetch.ts";

interface AccountRowProps {
  readonly icon: (props: { size?: number; stroke?: number }) => ReactNode;
  readonly label: string;
  readonly onSelect: () => void;
  readonly testId: string;
  readonly destructive?: boolean;
}

function AccountRow({
  icon: Icon,
  label,
  onSelect,
  testId,
  destructive,
}: AccountRowProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-testid={testId}
      className="flex w-full items-center gap-3 px-4 h-12 text-left transition-colors hover:bg-muted/40 active:bg-muted/60"
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center ${
          destructive ? "text-destructive" : "text-muted-foreground"
        }`}
      >
        <Icon size={20} stroke={1.6} />
      </span>
      <span
        className={`flex-1 min-w-0 truncate text-[16px] ${
          destructive
            ? "text-destructive font-medium"
            : "text-foreground font-medium"
        }`}
      >
        {label}
      </span>
      <IconChevronRight
        size={16}
        stroke={1.6}
        className="shrink-0 text-muted-foreground/60"
      />
    </button>
  );
}

/**
 * iOS Settings-style grouped section. Wraps a set of AccountRow children
 * in a single rounded white card with hairline separators between rows
 * (insetted to leave room for the leading icon).
 */
function AccountSection({ children }: { children: ReactNode }) {
  // zero-card carries the shared card surface (bg-card + border + shadow),
  // so each section now reads as a real card lifted off the page bg, with
  // hairline dividers between rows.
  return (
    <div className="zero-card overflow-hidden [&>button+button]:border-t [&>button+button]:border-border/50">
      {children}
    </div>
  );
}

function AccountIdentityCard() {
  const userLoadable = useLastLoadable(user$);
  const user = userLoadable.state === "hasData" ? userLoadable.data : null;
  const name = user?.fullName ?? "You";
  const email = user?.primaryEmailAddress?.emailAddress ?? "";
  const imageUrl = user?.imageUrl;
  const initial = name.charAt(0).toUpperCase();

  return (
    <div className="flex items-center gap-3 px-3 py-3">
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={name}
          className="h-12 w-12 rounded-full object-cover shrink-0"
        />
      ) : (
        <div className="h-12 w-12 rounded-full bg-muted text-[hsl(var(--primary-700))] flex items-center justify-center text-lg font-bold shrink-0">
          {initial}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p
          data-testid="account-hub-name"
          className="text-[17px] font-semibold leading-tight truncate text-foreground"
        >
          {name}
        </p>
        {email && (
          <p className="text-[16px] text-muted-foreground truncate mt-0.5">
            {email}
          </p>
        )}
      </div>
    </div>
  );
}

export function ZeroAccountHubPage() {
  const clerkLoadable = useLastLoadable(clerk$);
  const clerk = clerkLoadable.state === "hasData" ? clerkLoadable.data : null;
  const features = useLastLoadable(featureSwitch$);
  const featureSwitches =
    features.state === "hasData" ? features.data : undefined;
  const showApiKeys = featureSwitches?.[FeatureSwitchKey.ApiKeys] ?? false;
  const showExport = featureSwitches?.[FeatureSwitchKey.DataExport] ?? false;
  const apiBase = useGet(apiBaseForNavigation$);
  const navigate = useSet(detachedNavigateTo$);

  const goPreferences = () => {
    navigate("/settings");
  };
  const goUsage = () => {
    navigate("/usage");
  };
  const goApiKeys = () => {
    navigate("/settings/api-keys");
  };
  const handleManage = () => {
    detach(clerk?.openUserProfile(), Reason.DomCallback);
  };
  const handleAddAccount = () => {
    detach(clerk?.openSignIn(), Reason.DomCallback);
  };
  const handleExport = () => {
    window.open(`${apiBase}/export`, "_blank");
  };
  const handleSignOut = () => {
    const sessionId = clerk?.session?.id;
    const signInUrl = `${resolveWebOrigin()}/sign-in?redirect_url=${encodeURIComponent(location.href)}`;
    detach(
      clerk?.signOut({ sessionId, redirectUrl: signInUrl }),
      Reason.DomCallback,
    );
  };

  return (
    <div
      className="flex flex-1 flex-col min-h-0 overflow-auto"
      data-testid="account-hub-page"
    >
      <div className="mx-auto w-full max-w-[640px] flex flex-col gap-6 px-4 pt-3 md:pt-4 pb-12">
        <AccountIdentityCard />
        <AccountSection>
          <AccountRow
            icon={IconAdjustmentsHorizontal}
            label="Preferences"
            testId="account-hub-preferences"
            onSelect={goPreferences}
          />
          <AccountRow
            icon={IconChartBar}
            label="Usage"
            testId="account-hub-usage"
            onSelect={goUsage}
          />
          {showApiKeys && (
            <AccountRow
              icon={IconKey}
              label="API Keys"
              testId="account-hub-api-keys"
              onSelect={goApiKeys}
            />
          )}
        </AccountSection>
        <AccountSection>
          <AccountRow
            icon={IconUser}
            label="Manage account"
            testId="account-hub-manage"
            onSelect={handleManage}
          />
          <AccountRow
            icon={IconUserPlus}
            label="Add account"
            testId="account-hub-add"
            onSelect={handleAddAccount}
          />
          {showExport && (
            <AccountRow
              icon={IconDatabaseExport}
              label="Export data"
              testId="account-hub-export"
              onSelect={handleExport}
            />
          )}
        </AccountSection>
        <AccountSection>
          <AccountRow
            icon={IconLogout}
            label="Sign out"
            testId="account-hub-signout"
            onSelect={handleSignOut}
            destructive
          />
        </AccountSection>
      </div>
    </div>
  );
}
