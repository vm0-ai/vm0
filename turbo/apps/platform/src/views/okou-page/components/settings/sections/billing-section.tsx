import { OrgBillingTab } from "../../org-manage/org-billing-tab.tsx";

export function BillingSection({
  standalonePlans = false,
}: {
  readonly standalonePlans?: boolean;
}) {
  return <OrgBillingTab standalonePlans={standalonePlans} />;
}
