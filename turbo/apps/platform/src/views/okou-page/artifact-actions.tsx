import type { ComponentPropsWithRef, MouseEvent, ReactElement } from "react";
import { Download, Loader2, Share2 } from "lucide-react";
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  BrandGoogleDrive,
} from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import type {
  ChatThreadArtifactFile,
  ChatThreadArtifactGoogleDriveRecovery,
} from "@okouai/api-contracts/contracts/chat-threads";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import { downloadAttachment$ } from "../../signals/attachment-download.ts";
import { apiClient$ } from "../../signals/api-client.ts";
import {
  connectorCatalogStatusBySlug$,
  connectors$,
} from "../../signals/external/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason, withCleanup } from "../../signals/utils.ts";
import {
  artifactDownloadMenuOpenKey$,
  artifactDownloadPendingKey$,
  closeArtifactDownloadMenu$,
  finishArtifactDownload$,
  openArtifactDownloadMenu$,
  startArtifactDownload$,
} from "../../signals/okou-page/artifact-actions.ts";
import {
  authorizeGoogleDriveForAgent,
  syncArtifactFileToGoogleDrive,
} from "../../signals/chat-page/artifact-google-drive-sync.ts";
import {
  connectConnectorOAuthAuthCodeAndSettle$,
  getOnlyAvailableCatalogBrowserAuthMethodDetail,
} from "../../signals/okou-page/settings/connectors.ts";
import { defaultBuiltinConnectorAccountOptions } from "../../signals/okou-page/settings/connector-account-dialogs.ts";
import { copyAttachmentLinkToClipboard } from "./attachment-url.ts";
import { useAttachmentShareUrl } from "./attachment-resource.ts";

const GOOGLE_DRIVE_CONNECTOR_SLUG = "google-drive";
const ARTIFACT_FLOATING_TRANSITION_CLASS =
  "transition-[opacity,transform] duration-[180ms] ease data-open:!animate-none data-closed:!animate-none data-open:translate-y-0 data-open:opacity-100 data-closed:translate-y-2 data-closed:opacity-0";

function siteSlugFromUrl(value: string): string | null {
  if (!URL.canParse(value)) {
    return null;
  }
  const slug = new URL(value).hostname.split(".")[0];
  return slug && slug.length > 0 ? slug : null;
}

function htmlDownloadFilename(filename: string, url: string): string {
  const trimmed = filename.trim();
  const candidate =
    siteSlugFromUrl(trimmed) ??
    (trimmed === url ? siteSlugFromUrl(url) : null) ??
    trimmed;
  const pathSafe = candidate.replace(/[\\/]/g, "-").trim();
  const withoutHtml = pathSafe.replace(/\.(?:html?|xhtml)$/iu, "");
  const base =
    withoutHtml === pathSafe ? pathSafe.replace(/\.[^/.]+$/u, "") : withoutHtml;
  return `${base || siteSlugFromUrl(url) || "site"}.html`;
}

function artifactDownloadFilename(
  artifactKind: ChatThreadArtifactFile["artifactKind"] | undefined,
  filename: string,
  url: string,
): string {
  return artifactKind === "hosted-site" || artifactKind === "presentation-html"
    ? htmlDownloadFilename(filename, url)
    : filename;
}

export type ArtifactDownloadSyncTarget = {
  readonly agentId: string | null | undefined;
  readonly disconnected: boolean;
  readonly fileId: string;
  readonly filename: string;
  readonly onSyncSuccess: () => void;
  readonly recovery: ChatThreadArtifactGoogleDriveRecovery | undefined;
  readonly runId: string;
  readonly synced: boolean;
  readonly threadId: string;
};

async function shareArtifactUrl(url: string): Promise<void> {
  await copyAttachmentLinkToClipboard(url);
}

function isPlainPrimaryLinkClick(
  event: MouseEvent<HTMLAnchorElement>,
): boolean {
  return (
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

function iconButtonClassName(className?: string): string {
  return cn(
    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
    className,
  );
}

export function ArtifactActionSeparator() {
  return <span className="mx-0.5 h-5 w-px shrink-0 bg-border/70" />;
}

export function ArtifactActionTooltip({
  children,
  label,
  side = "bottom",
}: {
  children: ReactElement;
  label: string;
  side?: "top" | "right" | "bottom" | "left";
}) {
  const trigger = (children.props as { disabled?: boolean }).disabled ? (
    <span className="inline-flex">{children}</span>
  ) : (
    children
  );
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger render={trigger} />
        <TooltipContent
          side={side}
          className={ARTIFACT_FLOATING_TRANSITION_CLASS}
        >
          <p className="text-xs">{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ArtifactShareButton({
  ariaLabel,
  className,
  iconSize = 16,
  url,
}: {
  ariaLabel?: string;
  className?: string;
  iconSize?: number;
  url: string;
}) {
  const { t } = useTranslation();
  const shareUrl = useAttachmentShareUrl(url);
  const label =
    ariaLabel ??
    t(($) => {
      return $.artifacts.actions.share;
    });
  if (shareUrl === null) {
    // No address a recipient could open. Offering the action anyway would hand
    // out a link that only works for the person who copied it.
    return null;
  }
  return (
    <ArtifactActionTooltip label={label}>
      <a
        href={shareUrl}
        onClick={(event) => {
          if (!isPlainPrimaryLinkClick(event)) {
            return;
          }
          event.preventDefault();
          detach(
            shareArtifactUrl(shareUrl),
            Reason.DomCallback,
            "artifact share",
          );
        }}
        aria-label={label}
        className={iconButtonClassName(className)}
      >
        <Share2 size={iconSize} />
      </a>
    </ArtifactActionTooltip>
  );
}

function useGoogleDriveAvailability(
  syncTarget: ArtifactDownloadSyncTarget | undefined,
) {
  const connectorListLoadable = useLoadable(connectors$);
  const lastConnectorList = useLastResolved(connectors$);
  const catalogBySlugLoadable = useLoadable(connectorCatalogStatusBySlug$);
  const lastCatalogBySlug = useLastResolved(connectorCatalogStatusBySlug$);
  const connectorList =
    connectorListLoadable.state === "hasData"
      ? connectorListLoadable.data
      : connectorListLoadable.state === "loading"
        ? lastConnectorList
        : undefined;
  const catalogBySlug =
    catalogBySlugLoadable.state === "hasData"
      ? catalogBySlugLoadable.data
      : catalogBySlugLoadable.state === "loading"
        ? lastCatalogBySlug
        : undefined;
  const googleDriveConnected =
    connectorList?.connectors.some((connector) => {
      return (
        connector.slug === GOOGLE_DRIVE_CONNECTOR_SLUG &&
        connector.connectionStatus === "connected"
      );
    }) ?? false;
  const googleDriveConnector =
    catalogBySlug?.get(GOOGLE_DRIVE_CONNECTOR_SLUG) ?? null;
  const googleDriveAuthMethod =
    googleDriveConnector === null
      ? null
      : getOnlyAvailableCatalogBrowserAuthMethodDetail(googleDriveConnector);

  return {
    connectorListLoaded:
      connectorList !== undefined &&
      (googleDriveConnected || catalogBySlug !== undefined),
    googleDriveAuthMethod,
    googleDriveConnected,
    googleDriveConnector,
    googleDriveReady: googleDriveConnected && syncTarget?.disconnected !== true,
  };
}

function GoogleDriveDisabledMenuItem({
  kind,
  muted = false,
}: {
  kind: "connect" | "synced" | "upload";
  muted?: boolean;
}) {
  const { t } = useTranslation();
  const text =
    kind === "connect"
      ? t(($) => {
          return $.artifacts.googleDrive.connect;
        })
      : kind === "synced"
        ? t(($) => {
            return $.artifacts.googleDrive.synced;
          })
        : t(($) => {
            return $.artifacts.googleDrive.upload;
          });
  return (
    <DropdownMenuItem className={muted ? "text-muted-foreground" : ""} disabled>
      <BrandGoogleDrive size={14} />
      {text}
    </DropdownMenuItem>
  );
}

type GoogleDrivePendingAction =
  | { readonly kind: "authorize" }
  | {
      readonly kind: "connect";
      readonly account: ConnectorAccountMutationIntent;
      readonly useDefaultConnectorProjection: boolean;
    }
  | { readonly kind: "unavailable" };

function resolveGoogleDrivePendingAction(args: {
  readonly recovery: ChatThreadArtifactGoogleDriveRecovery | undefined;
  readonly connected: boolean;
  readonly legacyAccountOptions: ReturnType<
    typeof defaultBuiltinConnectorAccountOptions
  >;
}): GoogleDrivePendingAction {
  if (args.recovery) {
    switch (args.recovery.action) {
      case "authorize": {
        return { kind: "authorize" };
      }
      case "connect": {
        return {
          kind: "connect",
          account: { intent: "add" },
          useDefaultConnectorProjection: false,
        };
      }
      case "reconnect": {
        return {
          kind: "connect",
          account: {
            intent: "reconnect",
            connectionId: args.recovery.connectionId,
          },
          useDefaultConnectorProjection: false,
        };
      }
      case "unavailable": {
        return { kind: "unavailable" };
      }
    }
  }
  if (args.connected) {
    return { kind: "authorize" };
  }
  return args.legacyAccountOptions
    ? { kind: "connect", ...args.legacyAccountOptions }
    : { kind: "unavailable" };
}

function useGoogleDriveMenuAction(
  syncTarget: ArtifactDownloadSyncTarget | undefined,
  availability: ReturnType<typeof useGoogleDriveAvailability>,
): () => void {
  const createClient = useGet(apiClient$);
  const pageSignal = useGet(pageSignal$);
  const connectGoogleDrive = useSet(connectConnectorOAuthAuthCodeAndSettle$);

  return () => {
    if (!syncTarget) {
      return;
    }
    const run = async () => {
      const success = await syncArtifactFileToGoogleDrive(
        {
          createClient,
          threadId: syncTarget.threadId,
          runId: syncTarget.runId,
          fileId: syncTarget.fileId,
          filename: syncTarget.filename,
        },
        pageSignal,
      );
      if (success) {
        syncTarget.onSyncSuccess();
      }
    };
    if (availability.googleDriveReady) {
      detach(run(), Reason.DomCallback, "artifact google drive sync");
      return;
    }
    const action = resolveGoogleDrivePendingAction({
      recovery: syncTarget.recovery,
      connected: availability.googleDriveConnected,
      legacyAccountOptions: defaultBuiltinConnectorAccountOptions(
        availability.googleDriveConnector ?? undefined,
      ),
    });
    if (action.kind === "unavailable") {
      return;
    }
    if (!syncTarget.agentId) {
      toast.error(
        i18n.t(($) => {
          return $.artifacts.googleDrive.agentLoading;
        }),
      );
      return;
    }
    const agentId = syncTarget.agentId;
    if (action.kind === "authorize") {
      detach(
        (async () => {
          await authorizeGoogleDriveForAgent(
            { agentId, createClient },
            pageSignal,
          );
          await run();
        })(),
        Reason.DomCallback,
        "artifact google drive authorize sync",
      );
      return;
    }
    if (
      !availability.googleDriveConnector ||
      !availability.googleDriveAuthMethod
    ) {
      return;
    }
    detach(
      connectGoogleDrive(
        {
          connectorSlug: GOOGLE_DRIVE_CONNECTOR_SLUG,
          method: availability.googleDriveAuthMethod,
          onSuccess: run,
          options: {
            account: action.account,
            agentId,
            connectorIcon: availability.googleDriveConnector.icon,
            connectorLabel: availability.googleDriveConnector.label,
            ...(action.useDefaultConnectorProjection
              ? { useDefaultConnectorProjection: true }
              : {}),
          },
        },
        pageSignal,
      ),
      Reason.DomCallback,
      "artifact google drive connect sync",
    );
  };
}

function GoogleDriveMenuItem({
  syncTarget,
}: {
  syncTarget?: ArtifactDownloadSyncTarget;
}) {
  const { t } = useTranslation();
  const availability = useGoogleDriveAvailability(syncTarget);
  const syncOrConnect = useGoogleDriveMenuAction(syncTarget, availability);
  const {
    connectorListLoaded,
    googleDriveAuthMethod,
    googleDriveConnected,
    googleDriveConnector,
    googleDriveReady,
  } = availability;

  if (!syncTarget) {
    return <GoogleDriveDisabledMenuItem kind="upload" />;
  }

  if (syncTarget.synced) {
    return <GoogleDriveDisabledMenuItem kind="synced" />;
  }

  if (!connectorListLoaded) {
    return (
      <GoogleDriveDisabledMenuItem
        kind={syncTarget.disconnected ? "connect" : "upload"}
        muted={syncTarget.disconnected}
      />
    );
  }

  if (googleDriveReady) {
    return (
      <DropdownMenuItem onClick={syncOrConnect}>
        <BrandGoogleDrive size={14} />
        {t(($) => {
          return $.artifacts.googleDrive.upload;
        })}
      </DropdownMenuItem>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuItem
              disabled={
                syncTarget.recovery?.action === "unavailable" ||
                ((syncTarget.recovery?.action === "connect" ||
                  syncTarget.recovery?.action === "reconnect") &&
                  (!googleDriveConnector || !googleDriveAuthMethod)) ||
                (syncTarget.recovery === undefined &&
                  !googleDriveConnected &&
                  (!googleDriveConnector || !googleDriveAuthMethod))
              }
              onClick={syncOrConnect}
            >
              <BrandGoogleDrive size={14} />
              {t(($) => {
                return $.artifacts.googleDrive.connect;
              })}
            </DropdownMenuItem>
          }
        />
        <TooltipContent
          side="left"
          className={ARTIFACT_FLOATING_TRANSITION_CLASS}
        >
          {t(($) => {
            return $.artifacts.googleDrive.connectTooltip;
          })}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type ArtifactDownloadMenuProps = {
  align?: "center" | "end" | "start";
  ariaLabel?: string;
  artifactKind?: ChatThreadArtifactFile["artifactKind"];
  className?: string;
  filename: string;
  iconSize?: number;
  menuInstanceKey: string;
  syncTarget?: ArtifactDownloadSyncTarget;
  url: string;
};

function ArtifactDownloadTrigger({
  ariaLabel,
  className,
  downloadPending,
  iconSize,
  open,
  ref,
  ...props
}: ComponentPropsWithRef<"button"> & {
  ariaLabel: string;
  downloadPending: boolean;
  iconSize: number;
  open: boolean;
}) {
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      aria-label={ariaLabel}
      aria-busy={downloadPending ? "true" : undefined}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={downloadPending}
      className={iconButtonClassName(
        cn(
          "data-popup-open:bg-state-hover data-popup-open:text-foreground disabled:pointer-events-none disabled:opacity-70",
          className,
        ),
      )}
    >
      {downloadPending ? (
        <Loader2 size={iconSize} className="animate-spin" />
      ) : (
        <Download size={iconSize} />
      )}
    </button>
  );
}

function setArtifactDownloadMenuOpen(params: {
  readonly closeMenu: () => void;
  readonly nextOpen: boolean;
  readonly openMenu: (key: string) => void;
  readonly menuKey: string;
}): void {
  if (params.nextOpen) {
    params.openMenu(params.menuKey);
    return;
  }
  params.closeMenu();
}

function startArtifactDownloadWithCleanup(params: {
  readonly operation: string;
  readonly download: Promise<void>;
  readonly downloadKey: string;
  readonly finish: (key: string) => void;
  readonly start: (key: string) => void;
}): void {
  params.start(params.downloadKey);
  detach(
    withCleanup(params.download, () => {
      params.finish(params.downloadKey);
    }),
    Reason.DomCallback,
    params.operation,
  );
}

export function ArtifactDownloadMenu({
  align = "end",
  ariaLabel,
  artifactKind,
  className,
  filename,
  iconSize = 16,
  menuInstanceKey,
  syncTarget,
  url,
}: ArtifactDownloadMenuProps) {
  const { t } = useTranslation();
  const label =
    ariaLabel ??
    t(($) => {
      return $.artifacts.actions.downloadOptions;
    });
  const artifactDownloadKey = `${url}:${filename}`;
  const openKey = useGet(artifactDownloadMenuOpenKey$);
  const pendingKey = useGet(artifactDownloadPendingKey$);
  const openMenu = useSet(openArtifactDownloadMenu$);
  const closeMenu = useSet(closeArtifactDownloadMenu$);
  const startArtifactDownload = useSet(startArtifactDownload$);
  const finishArtifactDownload = useSet(finishArtifactDownload$);
  const downloadAttachment = useSet(downloadAttachment$);
  const pageSignal = useGet(pageSignal$);
  const open = openKey === `${menuInstanceKey}:${artifactDownloadKey}`;
  const downloadPending = pendingKey === artifactDownloadKey;
  const downloadName = artifactDownloadFilename(artifactKind, filename, url);
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        setArtifactDownloadMenuOpen({
          closeMenu,
          menuKey: `${menuInstanceKey}:${artifactDownloadKey}`,
          nextOpen,
          openMenu,
        });
      }}
    >
      <ArtifactActionTooltip label={label}>
        <DropdownMenuTrigger
          render={
            <ArtifactDownloadTrigger
              ariaLabel={label}
              className={className}
              downloadPending={downloadPending}
              iconSize={iconSize}
              open={open}
            />
          }
        />
      </ArtifactActionTooltip>
      <DropdownMenuContent
        align={align}
        sideOffset={6}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
        }}
        className={cn("w-56", ARTIFACT_FLOATING_TRANSITION_CLASS)}
      >
        <DropdownMenuItem
          onClick={() => {
            startArtifactDownloadWithCleanup({
              operation: "artifact download",
              download: downloadAttachment(
                { filename: downloadName, url },
                pageSignal,
              ),
              downloadKey: artifactDownloadKey,
              finish: finishArtifactDownload,
              start: startArtifactDownload,
            });
          }}
        >
          <Download size={14} />
          {t(($) => {
            return $.artifacts.actions.download;
          })}
        </DropdownMenuItem>
        <GoogleDriveMenuItem syncTarget={syncTarget} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
