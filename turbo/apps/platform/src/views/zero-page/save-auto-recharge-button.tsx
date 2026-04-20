import { useLoadableSet } from "ccstate-react/experimental";
import { Button } from "@vm0/ui";
import { saveAutoRecharge$ } from "../../signals/zero-page/billing.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function SaveAutoRechargeButton({
  getFormValues,
  pageSignal,
}: {
  getFormValues: () => {
    enabled: boolean;
    threshold?: number;
    amount?: number;
  } | null;
  pageSignal: AbortSignal;
}) {
  const [loadable, save] = useLoadableSet(saveAutoRecharge$);
  const loading = loadable.state === "loading";
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={loading}
      onClick={() => {
        const values = getFormValues();
        if (values) {
          detach(save(values, pageSignal), Reason.DomCallback);
        }
      }}
    >
      {loading ? "Saving..." : "Save"}
    </Button>
  );
}
