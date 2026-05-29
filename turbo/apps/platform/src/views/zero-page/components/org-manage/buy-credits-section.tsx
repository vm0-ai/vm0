import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Button, Input } from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { detachedNavigateTo$ } from "../../../../signals/route.ts";
import { ROUTES } from "../../../../signals/route-paths.ts";
import {
  buyCreditsCoupon$,
  buyCreditsCustomDollars$,
  buyCreditsSelection$,
  setBuyCreditsCoupon$,
  setBuyCreditsCustomDollars$,
  setBuyCreditsSelection$,
  startCreditCheckout$,
  type BillingTier,
  type BuyCreditsSelection,
  type CreditCheckoutSelection,
} from "../../../../signals/zero-page/billing.ts";

const CREDITS_PER_DOLLAR = 1000;
const PRESETS = [10, 20, 50] as const;
const MIN_CUSTOM_USD = 1;
const MAX_CUSTOM_USD = 10_000;

type Preset = (typeof PRESETS)[number];

const settingsCardBorder = {
  border: "0.7px solid hsl(var(--gray-400))",
} as const;

function formatUsd(dollars: number): string {
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatCredits(dollars: number): string {
  return `${(dollars * CREDITS_PER_DOLLAR).toLocaleString("en-US")} credits`;
}

const tileBaseClass =
  "flex flex-col rounded-xl bg-background px-4 py-3 text-left transition-colors";

function tileBorderClass(selected: boolean): string {
  return selected
    ? "border border-foreground ring-1 ring-foreground"
    : "zero-border hover:border-muted-foreground/30";
}

function PresetTile({
  dollars,
  selected,
  onSelect,
}: {
  dollars: Preset;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`${tileBaseClass} ${tileBorderClass(selected)}`}
    >
      <span className="text-sm font-semibold text-foreground">${dollars}</span>
      <span className="mt-1 text-[13px] text-muted-foreground">
        {formatCredits(dollars)}
      </span>
    </button>
  );
}

function CustomTile({
  selected,
  value,
  onSelect,
  onChange,
}: {
  selected: boolean;
  value: string;
  onSelect: () => void;
  onChange: (next: string) => void;
}) {
  if (!selected) {
    return (
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={false}
        className={`${tileBaseClass} ${tileBorderClass(false)}`}
      >
        <span className="text-sm font-semibold text-foreground">Custom</span>
        <span className="mt-1 text-[13px] text-muted-foreground">
          Any amount
        </span>
      </button>
    );
  }
  return (
    <div className={`${tileBaseClass} ${tileBorderClass(true)}`}>
      <div className="flex items-baseline gap-1">
        <span className="text-sm font-semibold text-foreground">$</span>
        <Input
          type="text"
          inputMode="numeric"
          value={value}
          autoFocus
          onChange={(e) => {
            const next = e.target.value;
            if (next !== "" && !/^\d+$/.test(next)) {
              return;
            }
            onChange(next);
          }}
          placeholder="100"
          className="h-6 w-full border-0 bg-transparent p-0 text-sm font-semibold shadow-none focus-visible:ring-0"
          aria-label="Custom dollar amount"
        />
      </div>
      <span className="mt-1 text-[13px] text-muted-foreground">
        {value === "" ? "Any amount" : formatCredits(Number(value))}
      </span>
    </div>
  );
}

function TileGrid({
  selection,
  customDollars,
  onSelect,
  onCustomChange,
}: {
  selection: BuyCreditsSelection;
  customDollars: string;
  onSelect: (next: BuyCreditsSelection) => void;
  onCustomChange: (next: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      {PRESETS.map((dollars) => {
        return (
          <PresetTile
            key={dollars}
            dollars={dollars}
            selected={selection === dollars}
            onSelect={() => {
              onSelect(dollars);
            }}
          />
        );
      })}
      <CustomTile
        selected={selection === "custom"}
        value={customDollars}
        onSelect={() => {
          onSelect("custom");
        }}
        onChange={onCustomChange}
      />
    </div>
  );
}

function ActionsRow({
  coupon,
  onCouponChange,
  onRedeem,
  redeemDisabled,
  buyLabel,
  buyDisabled,
  onBuy,
}: {
  coupon: string;
  onCouponChange: (next: string) => void;
  onRedeem: () => void;
  redeemDisabled: boolean;
  buyLabel: string;
  buyDisabled: boolean;
  onBuy: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
      <div className="flex items-center gap-2">
        <Input
          type="text"
          value={coupon}
          onChange={(e) => {
            onCouponChange(e.target.value);
          }}
          placeholder="Enter coupon code"
          className="h-9 w-[200px]"
          aria-label="Coupon code"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-9 px-4 text-sm"
          disabled={redeemDisabled}
          onClick={onRedeem}
        >
          Redeem
        </Button>
      </div>
      <Button
        size="sm"
        className="h-9 px-4 text-sm font-medium"
        disabled={buyDisabled}
        onClick={onBuy}
      >
        {buyLabel}
      </Button>
    </div>
  );
}

function resolveBuyDollars(
  selection: BuyCreditsSelection,
  customDollars: string,
): number | null {
  if (selection !== "custom") {
    return selection;
  }
  const value = Number(customDollars);
  const valid =
    customDollars !== "" &&
    Number.isInteger(value) &&
    value >= MIN_CUSTOM_USD &&
    value <= MAX_CUSTOM_USD;
  return valid ? value : null;
}

export function BuyCreditsSection({
  currentTier,
}: {
  currentTier: BillingTier;
}) {
  const pageSignal = useGet(pageSignal$);
  const [checkoutLoadable, checkout] = useLoadableSet(startCreditCheckout$);
  const navigateTo = useSet(detachedNavigateTo$);
  const selection = useGet(buyCreditsSelection$);
  const customDollars = useGet(buyCreditsCustomDollars$);
  const coupon = useGet(buyCreditsCoupon$);
  const setSelection = useSet(setBuyCreditsSelection$);
  const setCustomDollars = useSet(setBuyCreditsCustomDollars$);
  const setCoupon = useSet(setBuyCreditsCoupon$);

  if (currentTier === "free" || currentTier === "pro-suspend") {
    return null;
  }

  const redirecting = checkoutLoadable.state === "loading";
  const buyDollars = resolveBuyDollars(selection, customDollars);
  const buyDisabled = redirecting || buyDollars === null;
  const buyLabel = redirecting
    ? "Redirecting..."
    : buyDollars === null
      ? "Quick buy"
      : `Quick buy ${formatUsd(buyDollars)}`;

  const handleBuy = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (buyDollars === null) {
      toast.error(`Enter between $${MIN_CUSTOM_USD} and $${MAX_CUSTOM_USD}`);
      return;
    }
    const credits = buyDollars * CREDITS_PER_DOLLAR;
    const payload: CreditCheckoutSelection =
      selection === "custom" ? { credits, customAmount: true } : { credits };
    const newTab = e.metaKey || e.ctrlKey;
    detach(checkout(payload, newTab, pageSignal), Reason.DomCallback);
  };

  const trimmedCoupon = coupon.trim();
  const handleRedeem = () => {
    if (trimmedCoupon === "") {
      return;
    }
    navigateTo(ROUTES.redeemCampaign, {
      pathParams: { campaign: trimmedCoupon },
    });
  };

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-foreground">Buy credits</h3>
      <div
        className="overflow-hidden rounded-xl bg-card"
        style={settingsCardBorder}
      >
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Amount</p>
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Credits never expire. 1 USD = 1,000 credits.
            </p>
          </div>
          <TileGrid
            selection={selection}
            customDollars={customDollars}
            onSelect={setSelection}
            onCustomChange={setCustomDollars}
          />
        </div>
        <div className="h-0 zero-border-t mx-5" />
        <ActionsRow
          coupon={coupon}
          onCouponChange={setCoupon}
          onRedeem={handleRedeem}
          redeemDisabled={trimmedCoupon === ""}
          buyLabel={buyLabel}
          buyDisabled={buyDisabled}
          onBuy={handleBuy}
        />
      </div>
    </section>
  );
}
