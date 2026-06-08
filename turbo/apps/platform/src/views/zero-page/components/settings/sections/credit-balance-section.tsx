import { useGet, useLoadable, useSet } from "ccstate-react";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui";
import {
  OrgUsageTab,
  CreditBalanceCard,
} from "../../org-manage/org-usage-tab.tsx";
import { PersonalUsageRecord } from "../../preferences/personal-usage-record.tsx";
import { isOrgAdmin$ } from "../../../../../signals/org.ts";
import { setSettingsActiveSection$ } from "../../../../../signals/zero-page/settings/settings-dialog.ts";
import { setBillingSubPage$ } from "../../../../../signals/zero-page/settings/org-manage-tabs-state.ts";
import {
  creditBalanceTab$,
  setCreditBalanceTab$,
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

  const goToComparePlans = () => {
    setActiveSection("billing");
    setBillingSubPage(true);
  };

  // The credit balance card stays at the section level — above the Mine/Team
  // tabs — so it's always visible regardless of the active tab.
  const creditCard = <CreditBalanceCard onComparePlans={goToComparePlans} />;

  // Non-admins only have personal usage — no Team layer, so skip the tabs.
  if (!isAdmin) {
    return (
      <div className="flex flex-col gap-6">
        {creditCard}
        <PersonalUsageRecord />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {creditCard}
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value as CreditBalanceTab);
        }}
      >
        <TabsList>
          <TabsTrigger value="mine">Mine</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "mine" ? (
        <PersonalUsageRecord />
      ) : (
        <OrgUsageTab
          showCreditBalance={false}
          onComparePlans={goToComparePlans}
        />
      )}
    </div>
  );
}
