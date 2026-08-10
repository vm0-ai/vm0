import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui";
import { CreditBalanceCard } from "../../org-manage/org-usage-tab.tsx";
import {
  PersonalUsageRecord,
  TeamUsageRecord,
  UsageRangeSelect,
} from "../../preferences/personal-usage-record.tsx";
import { isOrgAdmin$ } from "../../../../../signals/org.ts";
import { featureSwitch$ } from "../../../../../signals/external/feature-switch.ts";
import { usagePackCreditsAsync$ } from "../../../../../signals/zero-page/billing.ts";
import { setSettingsActiveSection$ } from "../../../../../signals/zero-page/settings/settings-dialog.ts";
import { setBillingSubPage$ } from "../../../../../signals/zero-page/settings/workspace-settings-state.ts";
import {
  creditBalanceTab$,
  myUsageRange$,
  setCreditBalanceTab$,
  setMyUsageRange$,
  setTeamUsageRange$,
  teamUsageRange$,
  type CreditBalanceTab,
} from "../../../../../signals/zero-page/settings/personal-usage-record.ts";
import { formatLocalizedNumber } from "../../../../../i18n/format.ts";

function UsagePackCreditCard() {
  const { t } = useTranslation();
  const creditsLoadable = useLoadable(usagePackCreditsAsync$);

  if (creditsLoadable.state === "hasError") {
    return null;
  }

  return (
    <div
      data-testid="usage-pack-credit-card"
      className="overflow-hidden rounded-xl bg-card px-5 py-4 zero-border"
    >
      {creditsLoadable.state === "loading" ? (
        <div className="space-y-2">
          <div className="h-4 w-40 animate-pulse rounded bg-muted/50" />
          <div className="h-2.5 w-full animate-pulse rounded-full bg-muted/40" />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.billing.usage.usagePack.title;
              })}
            </p>
            <p className="text-sm font-medium tabular-nums text-foreground">
              {t(
                ($) => {
                  return $.billing.usage.creditsRemaining;
                },
                {
                  count: creditsLoadable.data.totalCredits,
                  value: formatLocalizedNumber(
                    creditsLoadable.data.totalCredits,
                  ),
                },
              )}
            </p>
          </div>
          {creditsLoadable.data.totalCredits > 0 ? (
            <div className="mt-3 flex flex-col gap-2">
              <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted/40">
                {creditsLoadable.data.purchasedCredits > 0 ? (
                  <div
                    data-testid="usage-pack-credit-purchased"
                    className="h-full bg-credit-plan-pro"
                    style={{
                      width: `${(creditsLoadable.data.purchasedCredits / creditsLoadable.data.totalCredits) * 100}%`,
                    }}
                  />
                ) : null}
                {creditsLoadable.data.bonusCredits > 0 ? (
                  <div
                    data-testid="usage-pack-credit-bonus"
                    className="h-full bg-credit-promotional"
                    style={{
                      width: `${(creditsLoadable.data.bonusCredits / creditsLoadable.data.totalCredits) * 100}%`,
                    }}
                  />
                ) : null}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {creditsLoadable.data.purchasedCredits > 0 ? (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-credit-plan-pro" />
                    <span>
                      {t(($) => {
                        return $.billing.usage.usagePack.purchased;
                      })}
                    </span>
                    <span className="tabular-nums">
                      {formatLocalizedNumber(
                        creditsLoadable.data.purchasedCredits,
                      )}
                    </span>
                  </div>
                ) : null}
                {creditsLoadable.data.bonusCredits > 0 ? (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="h-2 w-2 shrink-0 rounded-full bg-credit-promotional" />
                    <span>
                      {t(($) => {
                        return $.billing.usage.usagePack.bonus;
                      })}
                    </span>
                    <span className="tabular-nums">
                      {formatLocalizedNumber(creditsLoadable.data.bonusCredits)}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

export function CreditBalanceSection() {
  const { t } = useTranslation();
  const setActiveSection = useSet(setSettingsActiveSection$);
  const setBillingSubPage = useSet(setBillingSubPage$);
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const tab = useGet(creditBalanceTab$);
  const setTab = useSet(setCreditBalanceTab$);
  const myRange = useGet(myUsageRange$);
  const teamRange = useGet(teamUsageRange$);
  const setMyRange = useSet(setMyUsageRange$);
  const setTeamRange = useSet(setTeamUsageRange$);
  const features = useLastResolved(featureSwitch$);
  const usagePackPlansEnabled =
    features?.[FeatureSwitchKey.UsagePackPlans] ?? false;

  const goToComparePlans = () => {
    setActiveSection("billing");
    setBillingSubPage(true);
  };

  // The credit balance card stays at the section level — above the
  // My usage / Team usage tabs — so it's always visible regardless of the
  // active tab.
  const creditCard = <CreditBalanceCard onComparePlans={goToComparePlans} />;
  const usagePackCreditCard = usagePackPlansEnabled ? (
    <UsagePackCreditCard />
  ) : null;

  const activeRange = tab === "team" ? teamRange : myRange;
  const setActiveRange = tab === "team" ? setTeamRange : setMyRange;

  // Non-admins only have personal usage and cannot see the org credit balance.
  if (!isAdmin) {
    return (
      <div className="flex flex-col gap-4">
        {usagePackCreditCard}
        <div className="flex items-center justify-end">
          <UsageRangeSelect value={myRange} onChange={setMyRange} />
        </div>
        <PersonalUsageRecord range={myRange} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {usagePackCreditCard}
      {creditCard}
      <div className="flex flex-col gap-4">
        {/* One compact header row: tabs on the left, range filter on the right. */}
        <div className="flex items-center justify-between gap-3">
          <Tabs
            value={tab}
            onValueChange={(value) => {
              setTab(value as CreditBalanceTab);
            }}
          >
            <TabsList>
              <TabsTrigger value="mine">
                {t(($) => {
                  return $.usage.records.myUsage;
                })}
              </TabsTrigger>
              <TabsTrigger value="team">
                {t(($) => {
                  return $.usage.records.teamUsage;
                })}
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <UsageRangeSelect value={activeRange} onChange={setActiveRange} />
        </div>
        {tab === "mine" ? (
          <PersonalUsageRecord range={myRange} />
        ) : (
          <TeamUsageRecord range={teamRange} />
        )}
      </div>
    </div>
  );
}
