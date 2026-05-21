// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useSet, useLoadable } from "ccstate-react";
import type { ModelProviderResponse } from "@vm0/api-contracts/contracts/model-providers";
import {
  orgAddProviderDialogOpen$,
  setOrgAddProviderDialogOpen$,
  orgConfiguredProviders$,
} from "../../../../signals/zero-page/settings/org-model-providers.ts";
import { setClaudeCodeDeviceAuthDialogState$ } from "../../../../signals/zero-page/settings/claude-code-device-auth.ts";
import { setCodexDeviceAuthDialogState$ } from "../../../../signals/zero-page/settings/codex-device-auth.ts";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
import { OrgAddProviderDialog } from "../settings/org-add-provider-dialog.tsx";
import { OrgProviderDialog } from "../settings/org-provider-dialog.tsx";
import { OrgDeleteProviderDialog } from "../settings/org-delete-provider-dialog.tsx";
import {
  ClaudeCodeDeviceAuthDialog,
  PersonalClaudeCodeDeviceAuthDialog,
} from "../settings/claude-code-device-auth-dialog.tsx";
import {
  CodexDeviceAuthDialog,
  PersonalCodexDeviceAuthDialog,
} from "../settings/codex-device-auth-dialog.tsx";
import { PersonalProviderDialog } from "../settings/personal-provider-dialog.tsx";
import { OrgModelPoliciesSection } from "./org-model-policies-section.tsx";

export function OrgProvidersTab() {
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;
  const addDialogOpen = useGet(orgAddProviderDialogOpen$);
  const setAddDialogOpen = useSet(setOrgAddProviderDialogOpen$);

  return (
    <div className="flex flex-col gap-8">
      {isAdmin && <OrgModelPoliciesSection />}
      <StaleBannerSection />
      {isAdmin && (
        <OrgAddProviderDialog
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
        />
      )}
      <OrgDeleteProviderDialog />
      <OrgProviderDialog />
      <ClaudeCodeDeviceAuthDialog />
      <CodexDeviceAuthDialog />
      {isAdmin && (
        <>
          <PersonalProviderDialog />
          <PersonalClaudeCodeDeviceAuthDialog />
          <PersonalCodexDeviceAuthDialog />
        </>
      )}
    </div>
  );
}

/**
 * Render the re-connect banner above the provider list when any
 * codex-oauth-token provider has flipped to needsReconnect=true (the
 * firewall refresh pipeline writes this on refresh failure, see #11921).
 * The banner is the primary CTA; the per-row footer also shows a destructive
 * pill so users see the failed row at a glance.
 */
function StaleBannerSection() {
  const providersLoadable = useLoadable(orgConfiguredProviders$);
  const providers =
    providersLoadable.state === "hasData" ? providersLoadable.data : [];
  return <StaleProviderBanner providers={providers} />;
}

function StaleProviderBanner({
  providers,
}: {
  providers: ModelProviderResponse[];
}) {
  const setClaudeCodeDeviceDialog = useSet(setClaudeCodeDeviceAuthDialogState$);
  const setDeviceDialog = useSet(setCodexDeviceAuthDialogState$);
  const stale = providers.find((p) => {
    return (
      (p.type === "claude-code-oauth-token" ||
        p.type === "codex-oauth-token") &&
      p.needsReconnect
    );
  });
  if (!stale) {
    return null;
  }
  const isClaudeCode = stale.type === "claude-code-oauth-token";
  return (
    <section
      className="flex items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4"
      role="alert"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">
          {isClaudeCode
            ? "Claude Code session needs reconnection"
            : "ChatGPT session needs reconnection"}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {staleMessage(stale)}
        </p>
      </div>
      <button
        type="button"
        onClick={() => {
          if (isClaudeCode) {
            return setClaudeCodeDeviceDialog({ open: true, mode: "reconnect" });
          }
          return setDeviceDialog({ open: true, mode: "reconnect" });
        }}
        className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
      >
        Reconnect
      </button>
    </section>
  );
}

function staleMessage(provider: ModelProviderResponse): string {
  switch (provider.lastRefreshErrorCode) {
    case "refresh_token_expired": {
      return provider.type === "claude-code-oauth-token"
        ? "Your Claude Code session expired. Re-connect to continue."
        : "Your ChatGPT session expired. Re-connect to continue.";
    }
    case "refresh_token_reused": {
      return "Your ChatGPT session was used elsewhere. Re-connect.";
    }
    case "refresh_token_invalidated": {
      return "Your ChatGPT session was revoked. Re-connect.";
    }
    default: {
      return provider.type === "claude-code-oauth-token"
        ? "Claude Code refresh failed. Re-connect to retry."
        : "ChatGPT refresh failed. Re-connect to retry.";
    }
  }
}
