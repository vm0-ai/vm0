import type { ConnectorCatalogDiagnostics } from "@vm0/api-contracts/contracts/connector-catalog-diagnostics";
import { IconDatabase } from "@tabler/icons-react";
import { useLoadable } from "ccstate-react";
import type { ReactNode } from "react";

import { connectorCatalogDiagnostics$ } from "../../../../signals/zero-page/settings/connector-catalog-diagnostics.ts";

const EMPTY_VALUE = "None";

function formatEnumValue(value: string): string {
  const words = value.replaceAll("-", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return EMPTY_VALUE;
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function formatRejectedAttemptSource(
  lastAttempt: ConnectorCatalogDiagnostics["lastAttempt"],
): string {
  if (!lastAttempt || lastAttempt.outcome !== "rejected") {
    return EMPTY_VALUE;
  }
  if (lastAttempt.reusedCachedRejection === true) {
    return "Cached rejection";
  }
  if (lastAttempt.reusedCachedRejection === false) {
    return "Fresh evaluation";
  }
  return "Unknown";
}

function DiagnosticField({
  label,
  value,
  code = false,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly code?: boolean;
}) {
  const Value = code ? "code" : "div";
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <Value
        className={
          code
            ? "min-w-0 break-all text-xs leading-5 text-foreground"
            : "min-w-0 break-words text-sm font-medium text-foreground"
        }
      >
        {value}
      </Value>
    </div>
  );
}

function RejectedCandidateDiagnostics({
  candidate,
}: {
  readonly candidate: NonNullable<
    ConnectorCatalogDiagnostics["rejectedCandidate"]
  >;
}) {
  return (
    <div className="border-t border-border/60 pt-4">
      <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Rejected candidate
      </div>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <DiagnosticField
          label="Rejected version"
          value={candidate.catalogVersion ?? EMPTY_VALUE}
          code={candidate.catalogVersion !== null}
        />
        <DiagnosticField
          label="Rejecting backend"
          value={candidate.backendVersion ?? "Unknown"}
          code={candidate.backendVersion !== null}
        />
        <DiagnosticField
          label="Rejection failure"
          value={formatEnumValue(candidate.failureCode)}
        />
      </div>
      <div className="mt-4">
        <DiagnosticField
          label="Rejected catalog digest"
          value={candidate.catalogDigest ?? EMPTY_VALUE}
          code={candidate.catalogDigest !== null}
        />
      </div>
    </div>
  );
}

function CatalogSyncDiagnostics({
  diagnostics,
}: {
  readonly diagnostics: ConnectorCatalogDiagnostics;
}) {
  const active = diagnostics.active;
  const lastAttempt = diagnostics.lastAttempt;
  return (
    <>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <DiagnosticField
          label="Sync state"
          value={formatEnumValue(diagnostics.state)}
        />
        <DiagnosticField
          label="Last attempt"
          value={
            lastAttempt ? formatEnumValue(lastAttempt.outcome) : EMPTY_VALUE
          }
        />
        <DiagnosticField
          label="Active version"
          value={active?.catalogVersion ?? EMPTY_VALUE}
          code={active !== null}
        />
        <DiagnosticField
          label="Activated"
          value={formatTimestamp(active?.activatedAt ?? null)}
        />
        <DiagnosticField
          label="Last attempt at"
          value={formatTimestamp(lastAttempt?.at ?? null)}
        />
        <DiagnosticField
          label="Last success"
          value={formatTimestamp(diagnostics.lastSuccessAt)}
        />
        <DiagnosticField
          label="Failure code"
          value={
            lastAttempt?.failureCode
              ? formatEnumValue(lastAttempt.failureCode)
              : EMPTY_VALUE
          }
        />
        <DiagnosticField
          label="Rejected attempt source"
          value={formatRejectedAttemptSource(lastAttempt)}
        />
      </div>

      <DiagnosticField
        label="Active catalog digest"
        value={active?.catalogDigest ?? EMPTY_VALUE}
        code={active !== null}
      />

      {diagnostics.rejectedCandidate ? (
        <RejectedCandidateDiagnostics
          candidate={diagnostics.rejectedCandidate}
        />
      ) : null}
    </>
  );
}

function DiagnosticsContent({
  diagnostics,
}: {
  readonly diagnostics: ConnectorCatalogDiagnostics;
}) {
  const filteredAuthMethods = diagnostics.filtering.filteredAuthMethods;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <CatalogSyncDiagnostics diagnostics={diagnostics} />

      <div className="border-t border-border/60 pt-4">
        <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Compatibility
        </div>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <DiagnosticField
            label="Evaluation"
            value={diagnostics.filtering.stale ? "Stale" : "Current"}
          />
          <DiagnosticField
            label="Evaluated"
            value={formatTimestamp(diagnostics.filtering.evaluatedAt)}
          />
        </div>
        <div className="mt-4">
          <DiagnosticField
            label="Executable capability digest"
            value={diagnostics.filtering.capabilityDigest}
            code
          />
        </div>
        <div className="mt-4 flex min-w-0 flex-col gap-2">
          <div className="text-xs text-muted-foreground">
            Filtered auth methods
          </div>
          {filteredAuthMethods.length === 0 ? (
            <div className="text-sm font-medium text-foreground">
              {EMPTY_VALUE}
            </div>
          ) : (
            <div className="flex min-w-0 flex-col gap-2">
              {filteredAuthMethods.map((method) => {
                return (
                  <div
                    key={`${method.connectorRef}:${method.authMethodId}`}
                    className="min-w-0 rounded-lg bg-muted/40 px-3 py-2"
                  >
                    <code className="block break-all text-xs font-medium text-foreground">
                      {method.connectorRef} / {method.authMethodId}
                    </code>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {method.reasons.map(formatEnumValue).join(", ")}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-border/60 pt-4">
        <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Credential storage
        </div>
        <div className="grid grid-cols-2 gap-4">
          <DiagnosticField
            label="Missing versions"
            value={diagnostics.credentialStorage.missingConnectorVersions}
          />
          <DiagnosticField
            label="Unowned secrets"
            value={diagnostics.credentialStorage.unownedConnectorSecrets}
          />
          <DiagnosticField
            label="Unowned variables"
            value={diagnostics.credentialStorage.unownedConnectorVariables}
          />
          <DiagnosticField
            label="Unresolved bridge credentials"
            value={diagnostics.credentialStorage.unresolvedBridgeCredentials}
          />
        </div>
      </div>
    </div>
  );
}

export function ConnectorCatalogDiagnosticsBlock() {
  const diagnosticsLoadable = useLoadable(connectorCatalogDiagnostics$);
  const loading = diagnosticsLoadable.state === "loading";
  const diagnostics =
    diagnosticsLoadable.state === "hasData" ? diagnosticsLoadable.data : null;

  return (
    <section
      aria-labelledby="connector-catalog-diagnostics-title"
      className="flex items-start gap-4 rounded-xl bg-card p-4 zero-border"
    >
      <div className="shrink-0">
        <div className="flex h-7 w-7 items-center justify-center">
          <IconDatabase
            size={22}
            stroke={1.5}
            className="text-muted-foreground"
          />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div
          id="connector-catalog-diagnostics-title"
          className="text-sm font-medium text-foreground"
        >
          Connector catalog
        </div>
        {diagnostics ? (
          <DiagnosticsContent diagnostics={diagnostics} />
        ) : (
          <div className="text-sm text-muted-foreground">
            {loading ? "Loading" : "Unavailable"}
          </div>
        )}
      </div>
    </section>
  );
}
