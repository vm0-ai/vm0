import { useEffect, useState } from "react";
import { Clock3, Download, LoaderCircle, RotateCcw } from "lucide-react";
import type { DesktopZeroMigrationState } from "../desktop-zero-migration-types";
import { ZERO_MIGRATION_BRIDGE_CONFIG } from "../desktop-zero-migration-config";
import { IconButton } from "./components";

export function ZeroMigrationNotice() {
  const [state, setState] = useState<DesktopZeroMigrationState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const api = window.vm0DesktopZeroMigration;

  useEffect(() => {
    if (!api) {
      return undefined;
    }
    let active = true;
    const refresh = (): void => {
      void api
        .getState()
        .then((nextState) => {
          if (active) {
            setState(nextState);
          }
        })
        .catch((error: unknown) => {
          if (active) {
            setActionError(
              error instanceof Error
                ? error.message
                : "Unable to load the Zero migration notice.",
            );
          }
        });
    };
    refresh();
    const unsubscribe = api.subscribe(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);

  if (!api || !state || state.mode === "hidden") {
    return null;
  }

  const waiting = state.mode === "waiting_for_command";
  const paused = state.mode === "paused" || state.mode === "download_failed";
  const runAction = (
    action: () => Promise<DesktopZeroMigrationState>,
  ): void => {
    setActionError(null);
    void action()
      .then(setState)
      .catch((error: unknown) => {
        setActionError(
          error instanceof Error ? error.message : "Migration action failed.",
        );
      });
  };

  return (
    <section className="zero-migration-notice" aria-live="polite">
      <div className="zero-migration-copy">
        <strong>
          {paused
            ? ZERO_MIGRATION_BRIDGE_CONFIG.copy.pausedTitle
            : ZERO_MIGRATION_BRIDGE_CONFIG.copy.title}
        </strong>
        <span>
          {paused
            ? ZERO_MIGRATION_BRIDGE_CONFIG.copy.pausedDetail
            : waiting
              ? "Waiting for the current Computer Use command to finish. Zero will stop before the Okou download opens."
              : ZERO_MIGRATION_BRIDGE_CONFIG.copy.detail}
        </span>
        {(state.errorMessage || actionError) && (
          <span className="zero-migration-error">
            {state.errorMessage ?? actionError}
          </span>
        )}
      </div>
      <div className="zero-migration-actions">
        <IconButton
          tone="primary"
          icon={
            waiting ? (
              <LoaderCircle className="zero-migration-spinner" size={15} />
            ) : (
              <Download size={15} />
            )
          }
          disabled={waiting}
          onClick={() => {
            runAction(() => api.beginMigration());
          }}
        >
          {waiting
            ? "Finishing current work..."
            : paused
              ? "Try Download Again"
              : "Download Okou"}
        </IconButton>
        {paused ? (
          <IconButton
            icon={<RotateCcw size={15} />}
            disabled={waiting}
            onClick={() => {
              runAction(() => api.resumeZero());
            }}
          >
            Resume Zero
          </IconButton>
        ) : (
          <IconButton
            icon={<Clock3 size={15} />}
            disabled={waiting}
            onClick={() => {
              runAction(() => api.remindLater());
            }}
          >
            Remind Me Later
          </IconButton>
        )}
      </div>
    </section>
  );
}
