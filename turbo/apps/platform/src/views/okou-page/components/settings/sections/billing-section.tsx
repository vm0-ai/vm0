import { OrgBillingTab } from "../../org-manage/org-billing-tab.tsx";

export function BillingSection({
  standalonePlans = false,
  standaloneOpen = true,
  onStandaloneOpenChangeComplete,
}: {
  readonly standalonePlans?: boolean;
  readonly standaloneOpen?: boolean;
  readonly onStandaloneOpenChangeComplete?: (open: boolean) => void;
}) {
  return (
    <OrgBillingTab
      standalonePlans={standalonePlans}
      standaloneOpen={standaloneOpen}
      onStandaloneOpenChangeComplete={onStandaloneOpenChangeComplete}
    />
  );
}
