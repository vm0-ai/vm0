import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { FeatureSwitchKey } from "@vm0/core";
import { Button, CopyButton, Input } from "@vm0/ui";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  mintCodes$,
  mintCreditsInput$,
  mintQuantityInput$,
  mintedCodes$,
  setMintCreditsInput$,
  setMintQuantityInput$,
} from "../../signals/redemption-codes-page/redemption-codes.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { copyToClipboard$ } from "../../signals/zero-page/clipboard.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function RedemptionCodesPage() {
  const features = useLastResolved(featureSwitch$);
  const canMint = features?.[FeatureSwitchKey.RedemptionCodes] ?? false;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <header className="shrink-0 px-4 sm:px-6 pt-10 pb-3">
        <div className="mx-auto max-w-[900px]">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Redemption Codes
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Staff-only: mint new codes to hand out.
          </p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 pb-10">
        <div className="mx-auto max-w-[900px] flex flex-col gap-6">
          {canMint && <MintSection />}
        </div>
      </div>
    </div>
  );
}

function MintSection() {
  const creditsPerCode = useGet(mintCreditsInput$);
  const setCreditsPerCode = useSet(setMintCreditsInput$);
  const quantity = useGet(mintQuantityInput$);
  const setQuantity = useSet(setMintQuantityInput$);
  const codes = useGet(mintedCodes$);
  const [mintLoadable, mint] = useLoadableSet(mintCodes$);
  const copyAll = useSet(copyToClipboard$);
  const pageSignal = useGet(pageSignal$);

  const inFlight = mintLoadable.state === "loading";

  const parsedCredits = Number(creditsPerCode);
  const parsedQuantity = Number(quantity);
  const validInput =
    Number.isInteger(parsedCredits) &&
    parsedCredits > 0 &&
    Number.isInteger(parsedQuantity) &&
    parsedQuantity > 0;

  const handleMint = () => {
    if (!validInput) {
      return;
    }
    detach(
      mint(
        { creditsPerCode: parsedCredits, quantity: parsedQuantity },
        pageSignal,
      ),
      Reason.DomCallback,
      "mintCodes",
    );
  };

  const handleCopyAll = () => {
    if (codes.length === 0) {
      return;
    }
    const text = codes
      .map((c) => {
        return c.code;
      })
      .join("\n");
    detach(copyAll(text, pageSignal), Reason.DomCallback, "copyAllCodes");
  };

  return (
    <section className="zero-card p-4 flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Mint new codes</h2>
      <div className="flex flex-wrap gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Credits per code
          <Input
            type="number"
            min={1}
            max={1_000_000}
            value={creditsPerCode}
            onChange={(e) => {
              setCreditsPerCode(e.target.value);
            }}
            disabled={inFlight}
            className="w-32"
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Quantity
          <Input
            type="number"
            min={1}
            max={100}
            value={quantity}
            onChange={(e) => {
              setQuantity(e.target.value);
            }}
            disabled={inFlight}
            className="w-24"
          />
        </label>
        <Button onPointerDown={handleMint} disabled={inFlight || !validInput}>
          {inFlight ? "Generating…" : "Generate"}
        </Button>
      </div>

      {codes.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {codes.length} code{codes.length === 1 ? "" : "s"} generated —{" "}
              {codes[0]?.creditsPerCode.toLocaleString()} credits each
            </span>
            <Button variant="outline" size="sm" onPointerDown={handleCopyAll}>
              Copy all
            </Button>
          </div>
          <ul className="divide-y divide-border rounded-md border border-border">
            {codes.map((c) => {
              return (
                <li
                  key={c.code}
                  className="flex items-center justify-between px-3 py-2"
                >
                  <code className="font-mono text-sm">{c.code}</code>
                  <CopyButton text={c.code} />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
