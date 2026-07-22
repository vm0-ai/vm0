import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from "react";
import {
  IconBrandGoogleDrive,
  IconDownload,
  IconLoader2,
  IconPresentation,
  IconShare,
} from "@tabler/icons-react";
import {
  cn,
  Popover,
  PopoverContent,
  PopoverOverlay,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  zeroConnectorOauthStartContract,
  zeroConnectorOpenIdStartContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import type { ChatThreadArtifactFile } from "@vm0/api-contracts/contracts/chat-threads";
import type { PublicConnectorCatalogStatusItem } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { accept, ApiError } from "../../lib/accept.ts";
import {
  OAUTH_API_BASE,
  zeroClient$,
  type ZeroClientFactory,
} from "../../signals/api-client.ts";
import {
  connectorCatalogStatusByRef$,
  connectors$,
} from "../../signals/external/connectors.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason, tapError, withCleanup } from "../../signals/utils.ts";
import {
  artifactDownloadMenuOpenKey$,
  artifactDownloadPendingKey$,
  closeArtifactDownloadMenu$,
  finishArtifactDownload$,
  openArtifactDownloadMenu$,
  startArtifactDownload$,
} from "../../signals/zero-page/zero-artifact-actions.ts";
import {
  syncArtifactFileToGoogleDrive,
  waitForGoogleDriveAuthorization$,
} from "../../signals/chat-page/artifact-google-drive-sync.ts";
import { uploadPresentationToGoogleSlides$ } from "../../signals/chat-page/artifact-google-slides-upload.ts";
import {
  getOnlyAvailableCatalogBrowserAuthMethodDetail,
  type ConnectorCatalogBrowserAuthMethodDetail,
} from "../../signals/zero-page/settings/connectors.ts";
import {
  copyAttachmentLinkToClipboard,
  downloadAttachmentUrl,
  publicAttachmentUrl,
} from "./zero-attachment-url.ts";
import {
  buildPresentationHtmlPptxBlobFromUrl,
  downloadPresentationHtmlPptx,
} from "./presentation-html-pptx-download.ts";

const CONNECT_GOOGLE_DRIVE_ARTIFACT_UPLOAD_TOOLTIP =
  "Connect Google Drive to upload artifacts";
const GOOGLE_DRIVE_CONNECTOR_REF = "google-drive";
const ARTIFACT_FLOATING_LAYER_CLASS =
  "!z-[10000] transition-[opacity,transform] duration-[180ms] ease data-[state=open]:!animate-none data-[state=closed]:!animate-none data-[state=open]:translate-y-0 data-[state=open]:opacity-100 data-[state=closed]:translate-y-2 data-[state=closed]:opacity-0";

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

type WaitForGoogleDriveAuthorizationFn = (
  params: {
    readonly agentId: string;
    readonly authorizeConnected?: boolean;
  },
  signal: AbortSignal,
) => Promise<unknown>;

type GoogleDriveReadyRun = () => Promise<void>;

export type ArtifactDownloadSyncTarget = {
  readonly agentId: string | null | undefined;
  readonly disconnected: boolean;
  readonly fileId: string;
  readonly filename: string;
  readonly onSyncSuccess: () => void;
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

function runWhenGoogleDriveReady(params: {
  agentId: string | null | undefined;
  authorizeConnected: boolean;
  pageSignal: AbortSignal;
  run: GoogleDriveReadyRun;
  waitForGoogleDriveAuthorization: WaitForGoogleDriveAuthorizationFn;
  description: string;
}): void {
  if (!params.agentId) {
    toast.error("Agent is still loading");
    return;
  }
  const agentId = params.agentId;
  detach(
    (async () => {
      await params.waitForGoogleDriveAuthorization(
        { agentId, authorizeConnected: params.authorizeConnected },
        params.pageSignal,
      );
      await params.run();
    })(),
    Reason.DomCallback,
    params.description,
  );
}

function startGoogleDriveConnectAndRun(params: {
  agentId: string | null | undefined;
  authMethod: ConnectorCatalogBrowserAuthMethodDetail;
  connector: PublicConnectorCatalogStatusItem;
  createClient: ZeroClientFactory;
  pageSignal: AbortSignal;
  run: GoogleDriveReadyRun;
  waitForGoogleDriveAuthorization: WaitForGoogleDriveAuthorizationFn;
  description: string;
}): void {
  if (!params.agentId) {
    toast.error("Agent is still loading");
    return;
  }
  const agentId = params.agentId;
  const authWindow = window.open(
    "about:blank",
    "_blank",
    "width=600,height=700",
  );
  if (!authWindow) {
    toast.error("Failed to open Google Drive connection page");
    return;
  }
  detach(
    (async () => {
      const request = {
        params: { type: params.connector.connectorRef },
        body: {
          authMethod: params.authMethod.id,
          agentId,
          authorizeAgent: true as const,
        },
        fetchOptions: { signal: params.pageSignal },
      };
      const result =
        params.authMethod.grantKind === "openid-auth"
          ? await accept(
              params
                .createClient(zeroConnectorOpenIdStartContract, {
                  apiBase: "api",
                })
                .start(request),
              [200],
            )
          : await accept(
              params
                .createClient(zeroConnectorOauthStartContract, {
                  apiBase: OAUTH_API_BASE,
                })
                .start(request),
              [200],
            );
      params.pageSignal.throwIfAborted();
      authWindow.location.href = result.body.authorizationUrl;
    })(),
    Reason.DomCallback,
    "artifact google drive oauth start",
  );
  runWhenGoogleDriveReady({
    agentId,
    authorizeConnected: false,
    pageSignal: params.pageSignal,
    run: params.run,
    waitForGoogleDriveAuthorization: params.waitForGoogleDriveAuthorization,
    description: params.description,
  });
}

function authorizeGoogleDriveAndRun(params: {
  agentId: string | null | undefined;
  pageSignal: AbortSignal;
  run: GoogleDriveReadyRun;
  waitForGoogleDriveAuthorization: WaitForGoogleDriveAuthorizationFn;
  description: string;
}): void {
  runWhenGoogleDriveReady({ ...params, authorizeConnected: true });
}

async function downloadPresentationPptx(params: {
  filename: string;
  signal: AbortSignal;
  url: string;
}): Promise<void> {
  await tapError(downloadPresentationHtmlPptx(params), (error) => {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      toast.error("PPTX download failed");
    }
  });
}

type UploadPresentationSlidesFn = (
  params: {
    readonly threadId: string;
    readonly filename: string;
    readonly blob: Blob;
  },
  signal: AbortSignal,
) => Promise<{ readonly webViewLink: string | null }>;

async function uploadPresentationToGoogleSlides(params: {
  filename: string;
  pageSignal: AbortSignal;
  threadId: string;
  upload: UploadPresentationSlidesFn;
  url: string;
}): Promise<void> {
  const toastId = toast.loading("Uploading to Google Slides...");
  await tapError(
    (async () => {
      const built = await buildPresentationHtmlPptxBlobFromUrl({
        filename: params.filename,
        signal: params.pageSignal,
        url: params.url,
      });
      await params.upload(
        {
          threadId: params.threadId,
          filename: built.filename,
          blob: built.blob,
        },
        params.pageSignal,
      );
      toast.success("Uploaded to Google Slides", { id: toastId });
    })(),
    (error) => {
      toast.dismiss(toastId);
      if (!(error instanceof ApiError)) {
        toast.error("Failed to upload to Google Slides");
      }
    },
  );
}

function iconButtonClassName(className?: string): string {
  return cn(
    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
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
  children: ReactNode;
  label: string;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} className={ARTIFACT_FLOATING_LAYER_CLASS}>
          <p className="text-xs">{label}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ArtifactShareButton({
  ariaLabel = "Share",
  className,
  iconSize = 16,
  url,
}: {
  ariaLabel?: string;
  className?: string;
  iconSize?: number;
  url: string;
}) {
  return (
    <ArtifactActionTooltip label={ariaLabel}>
      <a
        href={publicAttachmentUrl(url)}
        onClick={(event) => {
          if (!isPlainPrimaryLinkClick(event)) {
            return;
          }
          event.preventDefault();
          detach(shareArtifactUrl(url), Reason.DomCallback, "artifact share");
        }}
        aria-label={ariaLabel}
        title={publicAttachmentUrl(url)}
        className={iconButtonClassName(className)}
      >
        <IconShare size={iconSize} stroke={1.5} />
      </a>
    </ArtifactActionTooltip>
  );
}

type ArtifactDownloadMenuItemProps = Omit<
  ComponentPropsWithoutRef<"button">,
  "type"
> & {
  children: ReactNode;
};

function ArtifactDownloadMenuItem({
  children,
  className,
  disabled = false,
  ...props
}: ArtifactDownloadMenuItemProps) {
  return (
    <button
      {...props}
      type="button"
      role="menuitem"
      aria-disabled={disabled ? "true" : undefined}
      disabled={disabled}
      className={cn(
        "relative flex w-full select-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent focus:bg-accent disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        disabled ? "cursor-default" : "cursor-pointer",
        className,
      )}
    >
      {children}
    </button>
  );
}

function useGoogleDriveAvailability(
  syncTarget: ArtifactDownloadSyncTarget | undefined,
) {
  const connectorListLoadable = useLoadable(connectors$);
  const lastConnectorList = useLastResolved(connectors$);
  const catalogByRefLoadable = useLoadable(connectorCatalogStatusByRef$);
  const lastCatalogByRef = useLastResolved(connectorCatalogStatusByRef$);
  const connectorList =
    connectorListLoadable.state === "hasData"
      ? connectorListLoadable.data
      : connectorListLoadable.state === "loading"
        ? lastConnectorList
        : undefined;
  const catalogByRef =
    catalogByRefLoadable.state === "hasData"
      ? catalogByRefLoadable.data
      : catalogByRefLoadable.state === "loading"
        ? lastCatalogByRef
        : undefined;
  const googleDriveConnected =
    connectorList?.connectors.some((connector) => {
      return (
        connector.type === GOOGLE_DRIVE_CONNECTOR_REF &&
        connector.connectionStatus === "connected"
      );
    }) ?? false;
  const googleDriveConnector =
    catalogByRef?.get(GOOGLE_DRIVE_CONNECTOR_REF) ?? null;
  const googleDriveAuthMethod =
    googleDriveConnector === null
      ? null
      : getOnlyAvailableCatalogBrowserAuthMethodDetail(googleDriveConnector);

  return {
    connectorListLoaded:
      connectorList !== undefined &&
      (googleDriveConnected || catalogByRef !== undefined),
    googleDriveAuthMethod,
    googleDriveConnected,
    googleDriveConnector,
    googleDriveReady: googleDriveConnected && syncTarget?.disconnected !== true,
  };
}

function GoogleDriveMenuItem({
  closeMenu,
  syncTarget,
}: {
  closeMenu: () => void;
  syncTarget?: ArtifactDownloadSyncTarget;
}) {
  const {
    connectorListLoaded,
    googleDriveAuthMethod,
    googleDriveConnected,
    googleDriveConnector,
    googleDriveReady,
  } = useGoogleDriveAvailability(syncTarget);
  const createClient = useGet(zeroClient$);
  const pageSignal = useGet(pageSignal$);
  const waitForGoogleDriveAuthorization = useSet(
    waitForGoogleDriveAuthorization$,
  );

  if (!syncTarget) {
    return (
      <ArtifactDownloadMenuItem disabled>
        <IconBrandGoogleDrive size={14} stroke={1.5} />
        Upload to Google Drive
      </ArtifactDownloadMenuItem>
    );
  }

  if (syncTarget.synced) {
    return (
      <ArtifactDownloadMenuItem disabled>
        <IconBrandGoogleDrive size={14} stroke={1.5} />
        Synced to Google Drive
      </ArtifactDownloadMenuItem>
    );
  }

  if (!connectorListLoaded) {
    return (
      <ArtifactDownloadMenuItem
        className={syncTarget.disconnected ? "text-muted-foreground" : ""}
        disabled
      >
        <IconBrandGoogleDrive size={14} stroke={1.5} />
        {syncTarget.disconnected
          ? "Connect Google Drive"
          : "Upload to Google Drive"}
      </ArtifactDownloadMenuItem>
    );
  }

  const syncOrConnect = () => {
    closeMenu();
    const run = async () => {
      const success = await syncArtifactFileToGoogleDrive({
        createClient,
        threadId: syncTarget.threadId,
        runId: syncTarget.runId,
        fileId: syncTarget.fileId,
        filename: syncTarget.filename,
        signal: pageSignal,
      });
      if (success) {
        syncTarget.onSyncSuccess();
      }
    };
    if (googleDriveReady) {
      detach(run(), Reason.DomCallback, "artifact google drive sync");
      return;
    }
    if (googleDriveConnected) {
      authorizeGoogleDriveAndRun({
        agentId: syncTarget.agentId,
        pageSignal,
        run,
        waitForGoogleDriveAuthorization,
        description: "artifact google drive authorize sync",
      });
      return;
    }
    if (!googleDriveConnector || !googleDriveAuthMethod) {
      return;
    }
    startGoogleDriveConnectAndRun({
      agentId: syncTarget.agentId,
      authMethod: googleDriveAuthMethod,
      connector: googleDriveConnector,
      createClient,
      pageSignal,
      run,
      waitForGoogleDriveAuthorization,
      description: "artifact google drive connect sync",
    });
  };

  if (googleDriveReady) {
    return (
      <ArtifactDownloadMenuItem onClick={syncOrConnect}>
        <IconBrandGoogleDrive size={14} stroke={1.5} />
        Upload to Google Drive
      </ArtifactDownloadMenuItem>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <ArtifactDownloadMenuItem
            disabled={
              !googleDriveConnected &&
              (!googleDriveConnector || !googleDriveAuthMethod)
            }
            onClick={syncOrConnect}
          >
            <IconBrandGoogleDrive size={14} stroke={1.5} />
            Connect Google Drive
          </ArtifactDownloadMenuItem>
        </TooltipTrigger>
        <TooltipContent side="left" className={ARTIFACT_FLOATING_LAYER_CLASS}>
          {CONNECT_GOOGLE_DRIVE_ARTIFACT_UPLOAD_TOOLTIP}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function GoogleSlidesMenuItem({
  closeMenu,
  filename,
  syncTarget,
  threadId,
  url,
}: {
  closeMenu: () => void;
  filename: string;
  syncTarget: ArtifactDownloadSyncTarget;
  threadId: string;
  url: string;
}) {
  const {
    connectorListLoaded,
    googleDriveAuthMethod,
    googleDriveConnected,
    googleDriveConnector,
    googleDriveReady,
  } = useGoogleDriveAvailability(syncTarget);
  const createClient = useGet(zeroClient$);
  const pageSignal = useGet(pageSignal$);
  const upload = useSet(uploadPresentationToGoogleSlides$);
  const waitForGoogleDriveAuthorization = useSet(
    waitForGoogleDriveAuthorization$,
  );
  const run = () => {
    return uploadPresentationToGoogleSlides({
      filename,
      pageSignal,
      threadId,
      upload,
      url,
    });
  };

  if (!connectorListLoaded) {
    return (
      <ArtifactDownloadMenuItem disabled>
        <IconPresentation size={14} stroke={1.5} />
        Connect Google Drive
      </ArtifactDownloadMenuItem>
    );
  }

  const connectOrUpload = () => {
    closeMenu();
    if (googleDriveReady) {
      detach(run(), Reason.DomCallback, "presentation google slides upload");
      return;
    }
    if (googleDriveConnected) {
      authorizeGoogleDriveAndRun({
        agentId: syncTarget.agentId,
        pageSignal,
        run,
        waitForGoogleDriveAuthorization,
        description: "presentation google slides authorize upload",
      });
      return;
    }
    if (!googleDriveConnector || !googleDriveAuthMethod) {
      return;
    }
    startGoogleDriveConnectAndRun({
      agentId: syncTarget.agentId,
      authMethod: googleDriveAuthMethod,
      connector: googleDriveConnector,
      createClient,
      pageSignal,
      run,
      waitForGoogleDriveAuthorization,
      description: "presentation google slides connect upload",
    });
  };

  const label = googleDriveReady
    ? "Upload to Google Slides"
    : "Connect Google Drive";
  return (
    <ArtifactDownloadMenuItem
      disabled={
        !googleDriveConnected &&
        (!googleDriveConnector || !googleDriveAuthMethod)
      }
      onClick={connectOrUpload}
    >
      <IconPresentation size={14} stroke={1.5} />
      {label}
    </ArtifactDownloadMenuItem>
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
  ...props
}: ComponentPropsWithoutRef<"button"> & {
  ariaLabel: string;
  downloadPending: boolean;
  iconSize: number;
  open: boolean;
}) {
  return (
    <button
      {...props}
      type="button"
      aria-label={ariaLabel}
      aria-busy={downloadPending ? "true" : undefined}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={downloadPending}
      className={iconButtonClassName(
        cn(
          "data-[state=open]:bg-muted/60 data-[state=open]:text-foreground disabled:pointer-events-none disabled:opacity-70",
          className,
        ),
      )}
    >
      {downloadPending ? (
        <IconLoader2 size={iconSize} stroke={1.5} className="animate-spin" />
      ) : (
        <IconDownload size={iconSize} stroke={1.5} />
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
  readonly closeMenu: () => void;
  readonly description: string;
  readonly download: Promise<void>;
  readonly downloadKey: string;
  readonly finish: (key: string) => void;
  readonly start: (key: string) => void;
}): void {
  params.closeMenu();
  params.start(params.downloadKey);
  detach(
    withCleanup(params.download, () => {
      params.finish(params.downloadKey);
    }),
    Reason.DomCallback,
    params.description,
  );
}

function shouldShowGoogleSlidesUpload(
  artifactKind: ChatThreadArtifactFile["artifactKind"] | undefined,
  features: Record<string, boolean | undefined>,
): boolean {
  return (
    artifactKind === "presentation-html" &&
    (features[FeatureSwitchKey.PresentationGoogleSlidesUpload] ?? false)
  );
}

export function ArtifactDownloadMenu({
  align = "end",
  ariaLabel = "Download options",
  artifactKind,
  className,
  filename,
  iconSize = 16,
  menuInstanceKey,
  syncTarget,
  url,
}: ArtifactDownloadMenuProps) {
  const artifactDownloadKey = `${url}:${filename}`;
  const openKey = useGet(artifactDownloadMenuOpenKey$);
  const pendingKey = useGet(artifactDownloadPendingKey$);
  const openMenu = useSet(openArtifactDownloadMenu$);
  const closeMenu = useSet(closeArtifactDownloadMenu$);
  const startArtifactDownload = useSet(startArtifactDownload$);
  const finishArtifactDownload = useSet(finishArtifactDownload$);
  const pageSignal = useGet(pageSignal$);
  const features = useGet(featureSwitch$);
  const open = openKey === `${menuInstanceKey}:${artifactDownloadKey}`;
  const downloadPending = pendingKey === artifactDownloadKey;
  const downloadFilename = artifactDownloadFilename(
    artifactKind,
    filename,
    url,
  );
  return (
    <Popover
      modal={false}
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
      <ArtifactActionTooltip label={ariaLabel}>
        <PopoverTrigger asChild>
          <ArtifactDownloadTrigger
            ariaLabel={ariaLabel}
            className={className}
            downloadPending={downloadPending}
            iconSize={iconSize}
            open={open}
          />
        </PopoverTrigger>
      </ArtifactActionTooltip>
      {open && (
        <PopoverOverlay
          data-testid="artifact-download-menu-dismiss-layer"
          aria-label="Close download menu"
          className="z-[9999]"
        />
      )}
      <PopoverContent
        role="menu"
        align={align}
        sideOffset={6}
        style={{ pointerEvents: "auto" }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
        }}
        className={cn(
          "pointer-events-auto w-56 p-1",
          ARTIFACT_FLOATING_LAYER_CLASS,
        )}
      >
        <ArtifactDownloadMenuItem
          onClick={() => {
            startArtifactDownloadWithCleanup({
              closeMenu,
              description: "artifact download",
              download: downloadAttachmentUrl(
                url,
                pageSignal,
                downloadFilename,
              ),
              downloadKey: artifactDownloadKey,
              finish: finishArtifactDownload,
              start: startArtifactDownload,
            });
          }}
        >
          <IconDownload size={14} stroke={1.5} />
          Download
        </ArtifactDownloadMenuItem>
        {artifactKind === "presentation-html" && (
          <ArtifactDownloadMenuItem
            onClick={() => {
              startArtifactDownloadWithCleanup({
                closeMenu,
                description: "presentation html pptx download",
                download: downloadPresentationPptx({
                  filename: downloadFilename,
                  signal: pageSignal,
                  url,
                }),
                downloadKey: artifactDownloadKey,
                finish: finishArtifactDownload,
                start: startArtifactDownload,
              });
            }}
          >
            <IconDownload size={14} stroke={1.5} />
            Download (.pptx)
          </ArtifactDownloadMenuItem>
        )}
        {shouldShowGoogleSlidesUpload(artifactKind, features) && syncTarget && (
          <GoogleSlidesMenuItem
            closeMenu={closeMenu}
            filename={downloadFilename}
            syncTarget={syncTarget}
            threadId={syncTarget.threadId}
            url={url}
          />
        )}
        <GoogleDriveMenuItem closeMenu={closeMenu} syncTarget={syncTarget} />
      </PopoverContent>
    </Popover>
  );
}
