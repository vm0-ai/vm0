import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { Loader2 } from "lucide-react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { handleAccountAction$ } from "../../signals/okou-page/nav.ts";
import {
  closeSettingsModal$,
  settingsDialogOpen$,
} from "../../signals/okou-page/settings/settings-dialog.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";
import { Link } from "../router/link.tsx";
import { CreditPurchaseConfirmDialog } from "./components/org-manage/credit-purchase-confirm-dialog.tsx";
import { SubscriptionPurchaseConfirmDialog } from "./components/org-manage/subscription-purchase-confirm-dialog.tsx";
import { SettingsDialog } from "./components/settings/settings-dialog.tsx";
import { AccountDropdown } from "./sidebar-account";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  colorTheme$,
  shellDocumentAttributesRef$,
} from "../../signals/theme.ts";

export function MinimalSidebarLayout({ children }: { children: ReactNode }) {
  const onAccountAction = useSet(handleAccountAction$);
  const dialogOpen = useGet(settingsDialogOpen$);
  const closeSettingsModal = useSet(closeSettingsModal$);
  const colorTheme = useGet(colorTheme$);
  const features = useGet(featureSwitch$);
  const gradientColorThemesEnabled =
    features[FeatureSwitchKey.GradientColorThemes] ?? false;
  const shellDocumentAttributesRef = useSet(shellDocumentAttributesRef$);

  return (
    <div
      ref={shellDocumentAttributesRef}
      className="zero-app zero-viewport-shell flex w-full bg-background"
      data-gradient-color-themes={gradientColorThemesEnabled || undefined}
      data-color-theme={gradientColorThemesEnabled ? colorTheme : undefined}
    >
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
      <div className="flex flex-1 flex-col min-w-0 min-h-0 zero-workspace-bg zero-workspace-card">
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

export function DirectedCardShell({
  icon,
  title,
  description,
  isLoading,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly isLoading: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center pointer-events-none">
      <div className="pointer-events-auto flex w-[430px] max-w-[calc(100%-48px)] flex-col items-center gap-12 rounded-[20px] border border-border bg-background px-6 py-12 text-center">
        <ProductBrandMarkLink />
        <div className="flex w-full flex-col gap-4">
          <div className="flex flex-col items-center gap-2.5">
            {isLoading ? (
              <Loader2 size={20} className="animate-spin" />
            ) : (
              <>
                <h1 className="text-lg font-medium text-foreground">{title}</h1>
                <div className="flex items-center justify-center rounded-[10px] bg-muted p-2.5">
                  {icon}
                </div>
                <p className="w-60 text-sm text-muted-foreground">
                  {description}
                </p>
              </>
            )}
          </div>
          {!isLoading && children}
        </div>
      </div>
    </div>
  );
}
