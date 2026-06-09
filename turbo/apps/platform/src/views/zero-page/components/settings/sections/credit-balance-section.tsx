import { useGet, useLoadable, useSet } from "ccstate-react";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui";
import {
  OrgUsageTab,
  CreditBalanceCard,
} from "../../org-manage/org-usage-tab.tsx";
import {
  PersonalUsageRecord,
  SourceFilter,
} from "../../preferences/personal-usage-record.tsx";
import { isOrgAdmin$ } from "../../../../../signals/org.ts";
import { setSettingsActiveSection$ } from "../../../../../signals/zero-page/settings/settings-dialog.ts";
import { setBillingSubPage$ } from "../../../../../signals/zero-page/settings/org-manage-tabs-state.ts";
import {
  creditBalanceTab$,
  setCreditBalanceTab$,
  usageSourceFilter$,
  setUsageSourceFilter$,
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
  const sourceFilter = useGet(usageSourceFilter$);
  const setSourceFilter = useSet(setUsageSourceFilter$);

  const goToComparePlans = () => {
    setActiveSection("billing");
    setBillingSubPage(true);
  };

  // The credit balance card stays at the section level — above the
  // My usage / Team usage tabs — so it's always visible regardless of the
  // active tab.
  const creditCard = <CreditBalanceCard onComparePlans={goToComparePlans} />;

  // The source filter only applies to the personal (My usage) list.
  const personalFilter = (
    <SourceFilter value={sourceFilter} onChange={setSourceFilter} />
  );

  // Non-admins only have personal usage — no Team layer, so skip the tabs and
  // keep just the filter aligned to the right of the list.
  if (!isAdmin) {
    return (
      <div className="flex flex-col gap-6">
        {creditCard}
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-end">{personalFilter}</div>
          <PersonalUsageRecord />
        </div>
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
          {tab === "mine" ? personalFilter : null}
        </div>
        {tab === "mine" ? (
          <PersonalUsageRecord />
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
