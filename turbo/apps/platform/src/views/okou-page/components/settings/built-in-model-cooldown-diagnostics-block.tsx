import type { BuiltInModelCooldownDiagnostics } from "@okouai/api-contracts/contracts/model-provider-routes";
import { Button } from "@okouai/ui/components/ui/button";
import { useLastResolved, useLoadableState, useSet } from "ccstate-react";
import { ChevronDown, ChevronUp, Cpu, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { formatLocalizedNumber } from "../../../../i18n/format.ts";
import {
  builtInModelCooldownDiagnostics$,
  reloadBuiltInModelCooldownDiagnostics$,
} from "../../../../signals/okou-page/settings/built-in-model-cooldown-diagnostics.ts";

function CooldownDiagnosticsSummary({
  diagnostics,
}: {
  readonly diagnostics: BuiltInModelCooldownDiagnostics;
}) {
  const { t } = useTranslation();

  return (
    <summary className="flex w-full cursor-pointer list-none items-start gap-4 p-4 text-left transition-colors hover:bg-state-hover [&::-webkit-details-marker]:hidden">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center">
        <Cpu size={22} className="text-muted-foreground" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <span
          id="built-in-model-cooldown-diagnostics-title"
          className="text-sm font-medium text-foreground"
        >
          {t(($) => {
            return $.settings.preferences.debug.builtInModelCooldown.title;
          })}
        </span>
        <span className="text-sm text-muted-foreground">
          {t(($) => {
            return $.settings.preferences.debug.builtInModelCooldown
              .description;
          })}
        </span>
        <span className="flex flex-wrap gap-1.5 font-mono text-[11px] text-foreground">
          <span className="zero-badge rounded-md px-2 py-0.5">
            {t(($) => {
              return $.settings.preferences.debug.builtInModelCooldown
                .workspaceFallback;
            })}
            :{" "}
            {diagnostics.fallbackEnabled
              ? t(($) => {
                  return $.settings.preferences.debug.builtInModelCooldown
                    .enabled;
                })
              : t(($) => {
                  return $.settings.preferences.debug.builtInModelCooldown
                    .disabled;
                })}
          </span>
          <span className="zero-badge rounded-md px-2 py-0.5">
            {t(($) => {
              return $.settings.preferences.debug.builtInModelCooldown
                .globalActive;
            })}
            : {formatLocalizedNumber(diagnostics.activeCooldowns.length)}
          </span>
        </span>
      </span>
      <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted-foreground group-open:hidden" />
      <ChevronUp className="mt-1 hidden h-4 w-4 shrink-0 text-muted-foreground group-open:block" />
    </summary>
  );
}

function CooldownDiagnosticsContent({
  diagnostics,
  loading,
}: {
  readonly diagnostics: BuiltInModelCooldownDiagnostics;
  readonly loading: boolean;
}) {
  const { t } = useTranslation();
  const reloadDiagnostics = useSet(reloadBuiltInModelCooldownDiagnostics$);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl text-xs leading-5 text-muted-foreground">
          {t(($) => {
            return $.settings.preferences.debug.builtInModelCooldown
              .globalExplanation;
          })}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 px-2.5 text-xs"
          disabled={loading}
          onClick={() => {
            reloadDiagnostics();
          }}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t(($) => {
            return $.settings.preferences.debug.builtInModelCooldown.refresh;
          })}
        </Button>
      </div>

      {!diagnostics.fallbackEnabled && (
        <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-5 text-foreground">
          {t(($) => {
            return $.settings.preferences.debug.builtInModelCooldown
              .disabledExplanation;
          })}
        </div>
      )}

      {diagnostics.activeCooldowns.length === 0 ? (
        <div className="rounded-md bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground">
          {t(($) => {
            return $.settings.preferences.debug.builtInModelCooldown.empty;
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {diagnostics.activeCooldowns.map((cooldown) => {
            const key = JSON.stringify([
              cooldown.selectedModel,
              cooldown.providerType,
              cooldown.upstreamModel,
            ]);
            return (
              <dl
                key={key}
                className="grid gap-2 rounded-md bg-muted/30 px-3 py-3 font-mono text-[11px] sm:grid-cols-2"
              >
                <div className="min-w-0">
                  <dt className="text-muted-foreground">
                    {t(($) => {
                      return $.settings.preferences.debug.builtInModelCooldown
                        .selectedModel;
                    })}
                  </dt>
                  <dd className="break-all text-foreground">
                    {cooldown.selectedModel}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-muted-foreground">
                    {t(($) => {
                      return $.settings.preferences.debug.builtInModelCooldown
                        .providerType;
                    })}
                  </dt>
                  <dd className="break-all text-foreground">
                    {cooldown.providerType}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-muted-foreground">
                    {t(($) => {
                      return $.settings.preferences.debug.builtInModelCooldown
                        .upstreamModel;
                    })}
                  </dt>
                  <dd className="break-all text-foreground">
                    {cooldown.upstreamModel}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-muted-foreground">
                    {t(($) => {
                      return $.settings.preferences.debug.builtInModelCooldown
                        .unavailableUntil;
                    })}
                  </dt>
                  <dd className="break-all text-foreground">
                    <time dateTime={cooldown.unavailableUntil}>
                      {cooldown.unavailableUntil}
                    </time>
                  </dd>
                </div>
              </dl>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function BuiltInModelCooldownDiagnosticsBlock() {
  const { t } = useTranslation();
  const reloadDiagnostics = useSet(reloadBuiltInModelCooldownDiagnostics$);
  const diagnostics = useLastResolved(builtInModelCooldownDiagnostics$);
  const loading =
    useLoadableState(builtInModelCooldownDiagnostics$) === "loading";

  return (
    <section
      aria-labelledby="built-in-model-cooldown-diagnostics-title"
      className="overflow-hidden rounded-xl bg-card zero-border"
    >
      {diagnostics ? (
        <details className="group">
          <CooldownDiagnosticsSummary diagnostics={diagnostics} />
          <div className="border-t border-border/60 p-4">
            <CooldownDiagnosticsContent
              diagnostics={diagnostics}
              loading={loading}
            />
          </div>
        </details>
      ) : (
        <div className="flex items-start gap-4 p-4">
          <div className="shrink-0">
            <div className="flex h-7 w-7 items-center justify-center">
              <Cpu size={22} className="text-muted-foreground" />
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div
              id="built-in-model-cooldown-diagnostics-title"
              className="text-sm font-medium text-foreground"
            >
              {t(($) => {
                return $.settings.preferences.debug.builtInModelCooldown.title;
              })}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">
                {loading
                  ? t(($) => {
                      return $.settings.preferences.debug.builtInModelCooldown
                        .loading;
                    })
                  : t(($) => {
                      return $.settings.preferences.debug.builtInModelCooldown
                        .unavailable;
                    })}
              </div>
              {!loading && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 px-2.5 text-xs"
                  onClick={() => {
                    reloadDiagnostics();
                  }}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t(($) => {
                    return $.settings.preferences.debug.builtInModelCooldown
                      .refresh;
                  })}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
