import { useLastLoadable, useSet } from "ccstate-react";
import { Button, CopyButton } from "@vm0/ui";
import {
  mintedCodesHistory$,
  reloadMintedCodesHistory$,
  type MintedCodeHistoryRow,
} from "../../signals/redemption-codes-page/redemption-codes.ts";

export function HistorySection() {
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

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(d);
}
