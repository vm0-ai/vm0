import { useSet } from "ccstate-react";
import { OrgUsageTab } from "../../org-manage/org-usage-tab.tsx";
import { setSettingsActiveSection$ } from "../../../../../signals/zero-page/settings/settings-dialog.ts";
import { setBillingSubPage$ } from "../../../../../signals/zero-page/settings/org-manage-tabs-state.ts";

export function CreditBalanceSection() {
  const setActiveSection = useSet(setSettingsActiveSection$);
  const setBillingSubPage = useSet(setBillingSubPage$);

  return (
    <OrgUsageTab
      onComparePlans={() => {
        setActiveSection("billing");
        setBillingSubPage(true);
      }}
    />
  );
}
