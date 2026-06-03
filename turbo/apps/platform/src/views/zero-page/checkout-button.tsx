import { useLoadableSet } from "ccstate-react/experimental";
import { Button } from "@vm0/ui";
import {
  type BillingTier,
  startCheckout$,
} from "../../signals/zero-page/billing.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function CheckoutButton({
  selectedTier,
  isUpgrade,
  isDowngrade,
  pageSignal,
  openDowngrade,
}: {
  selectedTier: BillingTier;
  isUpgrade: boolean;
  isDowngrade: boolean;
  pageSignal: AbortSignal;
  openDowngrade: () => void;
}) {
  const [checkoutLoadable, checkout] = useLoadableSet(startCheckout$);
  const loading = checkoutLoadable.state === "loading";

  if (!isUpgrade && !isDowngrade) {
    return null;
  }

  const handleAction = (e: React.MouseEvent) => {
    if (isUpgrade && (selectedTier === "pro" || selectedTier === "team")) {
      const newTab = e.metaKey || e.ctrlKey;
      detach(checkout(selectedTier, newTab, pageSignal), Reason.DomCallback);
    } else if (isDowngrade) {
      openDowngrade();
    }
  };

  return (
    <div className="flex justify-end mt-4">
      <Button
        disabled={loading}
        variant={isDowngrade ? "outline" : "default"}
        onClick={handleAction}
      >
        {loading
          ? "Redirecting..."
          : isUpgrade
            ? `Upgrade to ${selectedTier.charAt(0).toUpperCase() + selectedTier.slice(1)}`
            : "Downgrade"}
      </Button>
    </div>
  );
}
