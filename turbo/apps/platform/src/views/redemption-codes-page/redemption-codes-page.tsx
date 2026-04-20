// oxlint-disable max-lines-per-function
import {
  useGet,
  useLastLoadable,
  useLastResolved,
  useSet,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { FeatureSwitchKey } from "@vm0/core";
import {
  Button,
  CopyButton,
  Input,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@vm0/ui";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  activeTab$,
  mintCodes$,
  mintCreditsInput$,
  mintQuantityInput$,
  mintedCodes$,
  mintedCodesHistory$,
  reloadMintedCodesHistory$,
  setActiveTab$,
  setMintCreditsInput$,
  setMintQuantityInput$,
  type MintedCodeHistoryRow,
  type RedemptionCodesTab,
} from "../../signals/redemption-codes-page/redemption-codes.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { copyToClipboard$ } from "../../signals/zero-page/clipboard.ts";
import { detach, Reason } from "../../signals/utils.ts";

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

function HistorySection() {
  const loadable = useLastLoadable(mintedCodesHistory$);
  const reload = useSet(reloadMintedCodesHistory$);

  const rows = loadable.state === "hasData" ? loadable.data : [];
  const errorMessage =
    loadable.state === "hasError"
      ? loadable.error instanceof Error
        ? loadable.error.message
        : "Failed to load history"
      : null;

  return (
    <section className="zero-card p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Minted codes</h2>
        <Button
          variant="outline"
          size="sm"
          onPointerDown={() => {
            reload();
          }}
        >
          Refresh
        </Button>
      </div>

      {loadable.state === "loading" && rows.length === 0 && (
        <p className="text-xs text-muted-foreground">Loading…</p>
      )}
      {errorMessage && (
        <p className="text-xs text-destructive">{errorMessage}</p>
      )}
      {loadable.state === "hasData" && rows.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No codes minted yet. Use the Mint tab to generate some.
        </p>
      )}
      {rows.length > 0 && <HistoryTable rows={rows} />}
    </section>
  );
}

function HistoryTable({ rows }: { rows: MintedCodeHistoryRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="text-left font-medium py-2 pr-4">Code</th>
            <th className="text-right font-medium py-2 pr-4">Credits</th>
            <th className="text-left font-medium py-2 pr-4">Status</th>
            <th className="text-left font-medium py-2 pr-4">Created</th>
            <th className="text-left font-medium py-2">Expires</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => {
            return <HistoryRow key={row.code} row={row} />;
          })}
        </tbody>
      </table>
    </div>
  );
}

function HistoryRow({ row }: { row: MintedCodeHistoryRow }) {
  const now = Date.now();
  const expired =
    row.redeemedAt === null && new Date(row.expiresAt).getTime() < now;

  return (
    <tr>
      <td className="py-2 pr-4">
        <div className="flex items-center gap-2">
          <code className="font-mono text-xs break-all">{row.code}</code>
          <CopyButton text={row.code} />
        </div>
      </td>
      <td className="py-2 pr-4 text-right tabular-nums">
        {row.creditsPerCode.toLocaleString()}
      </td>
      <td className="py-2 pr-4">
        <HistoryStatus row={row} expired={expired} />
      </td>
      <td className="py-2 pr-4 text-muted-foreground">
        {formatTimestamp(row.createdAt)}
      </td>
      <td className="py-2 text-muted-foreground">
        {formatTimestamp(row.expiresAt)}
      </td>
    </tr>
  );
}

function HistoryStatus({
  row,
  expired,
}: {
  row: MintedCodeHistoryRow;
  expired: boolean;
}) {
  if (row.redeemedAt) {
    return (
      <span className="flex flex-col">
        <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Redeemed
        </span>
        <span className="text-muted-foreground">
          {row.redeemedByUserId ?? "unknown user"} ·{" "}
          {formatTimestamp(row.redeemedAt)}
        </span>
      </span>
    );
  }
  if (expired) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
        Expired
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
      Outstanding
    </span>
  );
}

const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "short",
});

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : TIMESTAMP_FORMATTER.format(d);
}
