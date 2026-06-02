import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Button, Input } from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import {
  buyCreditsCustomDollars$,
  buyCreditsSelection$,
  setBuyCreditsCustomDollars$,
  setBuyCreditsSelection$,
  startCreditCheckout$,
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
    ? "border border-primary ring-2 ring-primary/20"
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

export function BuyCreditsSection() {
  const pageSignal = useGet(pageSignal$);
  const [checkoutLoadable, checkout] = useLoadableSet(startCreditCheckout$);
  const selection = useGet(buyCreditsSelection$);
  const customDollars = useGet(buyCreditsCustomDollars$);
  const setSelection = useSet(setBuyCreditsSelection$);
  const setCustomDollars = useSet(setBuyCreditsCustomDollars$);

  const redirecting = checkoutLoadable.state === "loading";
  const buyDollars = resolveBuyDollars(selection, customDollars);
  const buyInvalid = buyDollars === null;
  const buyLabel = redirecting
    ? "Redirecting..."
    : buyDollars === null
      ? "Quick buy"
      : `Quick buy ${formatUsd(buyDollars)}`;

  const handleBuy = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (buyDollars === null) {
      toast.error(
        `Enter between $${MIN_CUSTOM_USD} and $${MAX_CUSTOM_USD.toLocaleString(
          "en-US",
        )}`,
      );
      return;
    }
    const credits = buyDollars * CREDITS_PER_DOLLAR;
    const payload: CreditCheckoutSelection =
      selection === "custom" ? { credits, customAmount: true } : { credits };
    const newTab = e.metaKey || e.ctrlKey;
    detach(checkout(payload, newTab, pageSignal), Reason.DomCallback);
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
        <div className="flex justify-end px-5 py-4">
          <Button
            type="button"
            size="sm"
            className={`h-9 px-4 text-sm font-medium ${
              buyInvalid ? "opacity-60" : ""
            }`}
            disabled={redirecting}
            aria-disabled={buyInvalid}
            onClick={handleBuy}
          >
            {buyLabel}
          </Button>
        </div>
      </div>
    </section>
  );
}
