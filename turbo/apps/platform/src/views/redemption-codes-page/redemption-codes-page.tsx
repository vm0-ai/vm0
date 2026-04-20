import { useGet, useLastResolved, useSet } from "ccstate-react";
import { FeatureSwitchKey } from "@vm0/core";
import { Tabs, TabsList, TabsTrigger } from "@vm0/ui";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  activeTab$,
  setActiveTab$,
  type RedemptionCodesTab,
} from "../../signals/redemption-codes-page/redemption-codes.ts";
import { MintSection } from "./mint-section.tsx";
import { HistorySection } from "./history-section.tsx";

export function RedemptionCodesPage() {
  const features = useLastResolved(featureSwitch$);
  const canMint = features?.[FeatureSwitchKey.RedemptionCodes] ?? false;
  const activeTab = useGet(activeTab$);
  const setActiveTab = useSet(setActiveTab$);

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Redemption Codes
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Staff-only: mint new codes and trace which have been redeemed.
          </p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 pb-10">
        <div className="mx-auto max-w-[900px] flex flex-col gap-6">
          {canMint && (
            <Tabs
              value={activeTab}
              onValueChange={(v) => {
                setActiveTab(v as RedemptionCodesTab);
              }}
            >
              <TabsList>
                <TabsTrigger value="mint">Mint</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
              </TabsList>
            </Tabs>
          )}
          {canMint && activeTab === "mint" && <MintSection />}
          {canMint && activeTab === "history" && <HistorySection />}
        </div>
      </div>
    </div>
  );
}
