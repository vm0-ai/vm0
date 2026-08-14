import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { handleZeroAccountAction$ } from "../../signals/zero-page/zero-nav.ts";
import {
  closeSettingsModal$,
  settingsDialogOpen$,
} from "../../signals/zero-page/settings/settings-dialog.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";
import { Link } from "../router/link.tsx";
import { CreditPurchaseConfirmDialog } from "./components/org-manage/credit-purchase-confirm-dialog.tsx";
import { SubscriptionPurchaseConfirmDialog } from "./components/org-manage/subscription-purchase-confirm-dialog.tsx";
import { SettingsDialog } from "./components/settings/settings-dialog.tsx";
import { AccountDropdown } from "./zero-sidebar-account";

export function MinimalSidebarLayout({ children }: { children: ReactNode }) {
  const onAccountAction = useSet(handleZeroAccountAction$);
  const dialogOpen = useGet(settingsDialogOpen$);
  const closeSettingsModal = useSet(closeSettingsModal$);

  return (
    <div className="zero-app zero-viewport-shell flex w-full bg-background">
      <SettingsDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            closeSettingsModal();
          }
        }}
      />
      <CreditPurchaseConfirmDialog />
      <SubscriptionPurchaseConfirmDialog />
      <aside className="zero-nav hidden md:flex h-full w-[255px] shrink-0 flex-col bg-sidebar">
        <div className="flex-1" />
        <div className="p-2">
          <AccountDropdown
            onAccountAction={onAccountAction}
            settingsOwnerId="minimal-sidebar"
          />
        </div>
      </aside>
      <div className="flex flex-1 flex-col min-w-0 min-h-0 zero-workspace-bg">
        {children}
      </div>
    </div>
  );
}

export function ProductBrandMarkLink() {
  return (
    <Link pathname="/connectors" className="no-underline text-foreground">
      <ProductBrandMark size="compact" />
    </Link>
  );
}
