import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  CreditBalanceCard,
  OrgUsageTab,
} from "../../org-manage/org-usage-tab.tsx";
import {
  LegacyPersonalUsageRecord,
  PersonalUsageRecord,
  SourceFilter,
  TeamUsageRecord,
  UsageRangeSelect,
} from "../../preferences/personal-usage-record.tsx";
import { isOrgAdmin$ } from "../../../../../signals/org.ts";
import { featureSwitch$ } from "../../../../../signals/external/feature-switch.ts";
import { setSettingsActiveSection$ } from "../../../../../signals/zero-page/settings/settings-dialog.ts";
import { setBillingSubPage$ } from "../../../../../signals/zero-page/settings/org-manage-tabs-state.ts";
import {
  creditBalanceTab$,
  myUsageRange$,
  setCreditBalanceTab$,
  setMyUsageRange$,
  setUsageSourceFilter$,
  setTeamUsageRange$,
  teamUsageRange$,
  usageSourceFilter$,
  type CreditBalanceTab,
} from "../../../../../signals/zero-page/settings/personal-usage-record.ts";

export function CreditBalanceSection() {
  const setActiveSection = useSet(setSettingsActiveSection$);
  const setBillingSubPage = useSet(setBillingSubPage$);
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const tab = useGet(creditBalanceTab$);
  const setTab = useSet(setCreditBalanceTab$);
  const features = useLastResolved(featureSwitch$);
  const creditUsageRecordsEnabled =
    features?.[FeatureSwitchKey.CreditUsageRecords] ?? false;
  const sourceFilter = useGet(usageSourceFilter$);
  const setSourceFilter = useSet(setUsageSourceFilter$);
  const myRange = useGet(myUsageRange$);
  const teamRange = useGet(teamUsageRange$);
  const setMyRange = useSet(setMyUsageRange$);
  const setTeamRange = useSet(setTeamUsageRange$);

  const goToComparePlans = () => {
    setActiveSection("billing");
    setBillingSubPage(true);
  };

  // The credit balance card stays at the section level — above the
  // My usage / Team usage tabs — so it's always visible regardless of the
  // active tab.
  const creditCard = <CreditBalanceCard onComparePlans={goToComparePlans} />;

  const activeRange = tab === "team" ? teamRange : myRange;
  const setActiveRange = tab === "team" ? setTeamRange : setMyRange;
  const legacyPersonalFilter = (
    <SourceFilter value={sourceFilter} onChange={setSourceFilter} />
  );

  if (!creditUsageRecordsEnabled) {
    if (!isAdmin) {
      return (
        <div className="flex flex-col gap-6">
          {creditCard}
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-end">
              {legacyPersonalFilter}
            </div>
            <LegacyPersonalUsageRecord />
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col gap-6">
        {creditCard}
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <Tabs
              value={tab}
              onValueChange={(value) => {
                setTab(value as CreditBalanceTab);
              }}
            >
              <TabsList>
                <TabsTrigger value="mine">My usage</TabsTrigger>
                <TabsTrigger value="team">Team usage</TabsTrigger>
              </TabsList>
            </Tabs>
            {tab === "mine" ? legacyPersonalFilter : null}
          </div>
          {tab === "mine" ? (
            <LegacyPersonalUsageRecord />
          ) : (
            <OrgUsageTab
              showCreditBalance={false}
              onComparePlans={goToComparePlans}
            />
          )}
        </div>
      </div>
    );
  }

  // Non-admins only have personal usage and cannot see the org credit balance.
  if (!isAdmin) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-end">
          <UsageRangeSelect value={myRange} onChange={setMyRange} />
        </div>
        <PersonalUsageRecord range={myRange} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {creditCard}
      <div className="flex flex-col gap-4">
        {/* One compact header row: tabs on the left, source filter on the right. */}
        <div className="flex items-center justify-between gap-3">
          <Tabs
            value={tab}
            onValueChange={(value) => {
              setTab(value as CreditBalanceTab);
            }}
          >
            <TabsList>
              <TabsTrigger value="mine">My usage</TabsTrigger>
              <TabsTrigger value="team">Team usage</TabsTrigger>
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
