import { useGet, useLastLoadable, useSet } from "ccstate-react";
import {
  IconAdjustmentsHorizontal,
  IconChartBar,
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
import {
  MobileStackList,
  MobileStackRow,
  MobileStackSection,
} from "./components/mobile-stack-list.tsx";

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
          className="text-[16px] font-semibold leading-tight truncate text-foreground"
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
      <div className="mx-auto w-full max-w-[640px] flex flex-col gap-6 px-4 pt-2 md:pt-4 pb-16">
        <AccountIdentityCard />
        <MobileStackList>
          <MobileStackSection>
            <MobileStackRow
              icon={<IconAdjustmentsHorizontal size={18} stroke={1.5} />}
              label="Preferences"
              testId="account-hub-preferences"
              onClick={goPreferences}
            />
            <MobileStackRow
              icon={<IconChartBar size={18} stroke={1.5} />}
              label="Usage"
              testId="account-hub-usage"
              onClick={goUsage}
            />
            {showApiKeys && (
              <MobileStackRow
                icon={<IconKey size={18} stroke={1.5} />}
                label="API Keys"
                testId="account-hub-api-keys"
                onClick={goApiKeys}
              />
            )}
          </MobileStackSection>
          <MobileStackSection>
            <MobileStackRow
              icon={<IconUser size={18} stroke={1.5} />}
              label="Manage account"
              testId="account-hub-manage"
              onClick={handleManage}
            />
            <MobileStackRow
              icon={<IconUserPlus size={18} stroke={1.5} />}
              label="Add account"
              testId="account-hub-add"
              onClick={handleAddAccount}
            />
            {showExport && (
              <MobileStackRow
                icon={<IconDatabaseExport size={18} stroke={1.5} />}
                label="Export data"
                testId="account-hub-export"
                onClick={handleExport}
              />
            )}
          </MobileStackSection>
          <MobileStackSection>
            <MobileStackRow
              icon={<IconLogout size={18} stroke={1.5} />}
              label="Sign out"
              testId="account-hub-signout"
              onClick={handleSignOut}
              destructive
            />
          </MobileStackSection>
        </MobileStackList>
      </div>
    </div>
  );
}
