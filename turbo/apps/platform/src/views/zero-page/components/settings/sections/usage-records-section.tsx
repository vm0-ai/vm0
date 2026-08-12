import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui";

import {
  PersonalUsageRecord,
  TeamUsageRecord,
  UsageRangeSelect,
} from "../../preferences/personal-usage-record.tsx";
import { isOrgAdmin$ } from "../../../../../signals/org.ts";
import { billingStatusAsync$ } from "../../../../../signals/zero-page/billing.ts";
import { setSettingsActiveSection$ } from "../../../../../signals/zero-page/settings/settings-dialog.ts";
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

/**
 * A one-line reminder of what is left to spend, so reading the records never
 * requires switching back to Credit balance to know whether it matters.
 */
function BalanceSummary() {
  const { t } = useTranslation();
  const setActiveSection = useSet(setSettingsActiveSection$);
  const billingLoadable = useLoadable(billingStatusAsync$);
  if (billingLoadable.state !== "hasData") {
    return null;
  }
  const billing = billingLoadable.data;

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl bg-card px-5 py-3 zero-border">
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.billing.usage.orgCredits;
        })}{" "}
        <span className="font-medium tabular-nums text-foreground">
          {formatLocalizedNumber(billing.credits)}
        </span>
      </p>
      <button
        type="button"
        data-testid="usage-records-see-balance"
        className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => {
          setActiveSection("usage");
        }}
      >
        {t(($) => {
          return $.settings.dialog.sections.usage.balanceTitle;
        })}
        <ArrowRight size={13} className="shrink-0" />
      </button>
    </div>
  );
}

export function UsageRecordsSection() {
  const { t } = useTranslation();
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const tab = useGet(creditBalanceTab$);
  const setTab = useSet(setCreditBalanceTab$);
  const myRange = useGet(myUsageRange$);
  const teamRange = useGet(teamUsageRange$);
  const setMyRange = useSet(setMyUsageRange$);
  const setTeamRange = useSet(setTeamUsageRange$);

  // Team usage and the organization balance are admin data. Members still get
  // their own records, which is the whole point of the section for them.
  if (!isAdmin) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex justify-end">
          <UsageRangeSelect value={myRange} onChange={setMyRange} />
        </div>
        <PersonalUsageRecord range={myRange} />
      </div>
    );
  }

  const activeRange = tab === "team" ? teamRange : myRange;
  const setActiveRange = tab === "team" ? setTeamRange : setMyRange;

  return (
    <div className="flex flex-col gap-4">
      <BalanceSummary />
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
  );
}
