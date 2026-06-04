import type { ComponentPropsWithoutRef, ReactNode } from "react";
import {
  IconBrandGoogleDrive,
  IconDownload,
  IconShare,
} from "@tabler/icons-react";
import {
  cn,
  Popover,
  PopoverAnchor,
  PopoverContent,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { toast } from "@vm0/ui/components/ui/sonner";
import type { ConnectorAuthMethodIdsByGrantKind } from "@vm0/connectors/connectors";
import { zeroConnectorOauthStartContract } from "@vm0/api-contracts/contracts/zero-connectors";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { accept } from "../../lib/accept.ts";
import {
  zeroClient$,
  type ZeroClientFactory,
} from "../../signals/api-client.ts";
import { connectors$ } from "../../signals/external/connectors.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  artifactDownloadMenuOpenKey$,
  closeArtifactDownloadMenu$,
  openArtifactDownloadMenu$,
  scheduleArtifactDownloadMenuClose$,
} from "../../signals/zero-page/zero-artifact-actions.ts";
import {
  type ArtifactGoogleDriveSyncFile,
  syncArtifactFileToGoogleDrive,
  waitForGoogleDriveAndSyncArtifacts$,
} from "../../signals/chat-page/artifact-google-drive-sync.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  copyAttachmentLinkToClipboard,
  downloadAttachmentUrl,
  publicAttachmentUrl,
} from "./zero-attachment-url.ts";

const CONNECT_GOOGLE_DRIVE_ARTIFACT_UPLOAD_TOOLTIP =
  "Connect Google Drive to upload artifacts";
const GOOGLE_DRIVE_ARTIFACT_SYNC_AUTH_METHOD =
  "oauth" satisfies ConnectorAuthMethodIdsByGrantKind<
    "google-drive",
    "auth-code"
  >;
const ARTIFACT_FLOATING_LAYER_CLASS =
  "!z-[10000] transition-[opacity,transform] duration-[180ms] ease data-[state=open]:!animate-none data-[state=closed]:!animate-none data-[state=open]:translate-y-0 data-[state=open]:opacity-100 data-[state=closed]:translate-y-2 data-[state=closed]:opacity-0";

type WaitForGoogleDriveAndSyncArtifactsFn = (
  params: {
    readonly agentId: string;
    readonly threadId: string;
    readonly files: readonly ArtifactGoogleDriveSyncFile[];
  },
  signal: AbortSignal,
) => Promise<unknown>;

export type ArtifactDownloadSyncTarget = {
  readonly agentId: string | null | undefined;
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

function startGoogleDriveConnectAndSync(params: {
  agentId: string | null | undefined;
  createClient: ZeroClientFactory;
  file: ArtifactGoogleDriveSyncFile;
  pageSignal: AbortSignal;
  threadId: string;
  waitForGoogleDriveAndSyncArtifacts: WaitForGoogleDriveAndSyncArtifactsFn;
  onSyncComplete: () => void;
}): void {
  if (!params.agentId) {
    toast.error("Agent is still loading");
    return;
  }
  const authWindow = window.open(
    "about:blank",
    "_blank",
    "width=600,height=700",
  );
  if (!authWindow) {
    toast.error("Failed to open Google Drive connection page");
    return;
  }
  const agentId = params.agentId;
  detach(
    (async () => {
      const client = params.createClient(zeroConnectorOauthStartContract, {
        apiBase: "www",
      });
      const result = await accept(
        client.start({
          params: { type: "google-drive" },
          body: { authMethod: GOOGLE_DRIVE_ARTIFACT_SYNC_AUTH_METHOD },
          fetchOptions: { signal: params.pageSignal },
        }),
        [200],
      );
      params.pageSignal.throwIfAborted();
      authWindow.location.href = result.body.authorizationUrl;
    })(),
    Reason.DomCallback,
    "artifact google drive oauth start",
  );
  detach(
    (async () => {
      await params.waitForGoogleDriveAndSyncArtifacts(
        {
          agentId,
          threadId: params.threadId,
          files: [params.file],
        },
        params.pageSignal,
      );
      params.onSyncComplete();
    })(),
    Reason.DomCallback,
    "artifact google drive connect sync",
  );
}

function syncArtifactToGoogleDriveAndRefresh(params: {
  sync: Promise<boolean>;
  onSyncSuccess: () => void;
}): void {
  detach(
    (async () => {
      const success = await params.sync;
      if (success) {
        params.onSyncSuccess();
      }
    })(),
    Reason.DomCallback,
    "artifact google drive sync",
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
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => {
              detach(
                shareArtifactUrl(url),
                Reason.DomCallback,
                "artifact share",
              );
            }}
            aria-label={ariaLabel}
            title={publicAttachmentUrl(url)}
            className={iconButtonClassName(className)}
          >
            <IconShare size={iconSize} stroke={1.5} />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          className={cn("!z-[10000]", ARTIFACT_FLOATING_LAYER_CLASS)}
        >
          <p className="text-xs">Share</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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

function GoogleDriveMenuItem({
  closeMenu,
  onHover,
  syncTarget,
}: {
  closeMenu: () => void;
  onHover: () => void;
  syncTarget?: ArtifactDownloadSyncTarget;
}) {
  const connectorList = useLastResolved(connectors$);
  const googleDriveConnected =
    connectorList?.connectors.some((connector) => {
      return connector.type === "google-drive" && !connector.needsReconnect;
    }) ?? false;
  const createClient = useGet(zeroClient$);
  const pageSignal = useGet(pageSignal$);
  const waitForGoogleDriveAndSyncArtifacts = useSet(
    waitForGoogleDriveAndSyncArtifacts$,
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

  const syncOrConnect = () => {
    closeMenu();
    const file = {
      runId: syncTarget.runId,
      fileId: syncTarget.fileId,
      filename: syncTarget.filename,
    };
    if (googleDriveConnected) {
      syncArtifactToGoogleDriveAndRefresh({
        sync: syncArtifactFileToGoogleDrive({
          createClient,
          threadId: syncTarget.threadId,
          runId: syncTarget.runId,
          fileId: syncTarget.fileId,
          filename: syncTarget.filename,
          signal: pageSignal,
        }),
        onSyncSuccess: syncTarget.onSyncSuccess,
      });
      return;
    }
    startGoogleDriveConnectAndSync({
      agentId: syncTarget.agentId,
      createClient,
      file,
      pageSignal,
      threadId: syncTarget.threadId,
      waitForGoogleDriveAndSyncArtifacts,
      onSyncComplete: syncTarget.onSyncSuccess,
    });
  };

  if (googleDriveConnected) {
    return (
      <ArtifactDownloadMenuItem onClick={syncOrConnect}>
        <IconBrandGoogleDrive size={14} stroke={1.5} />
        Upload to Google Drive
      </ArtifactDownloadMenuItem>
    );
  }

  return (
    <div
      className="group/google-drive-connect relative"
      onPointerEnter={onHover}
    >
      <ArtifactDownloadMenuItem
        className="text-muted-foreground"
        onFocus={onHover}
        onPointerEnter={onHover}
        onClick={syncOrConnect}
      >
        <IconBrandGoogleDrive size={14} stroke={1.5} />
        Connect Google Drive
      </ArtifactDownloadMenuItem>
      <div
        role="tooltip"
        className={cn(
          "pointer-events-none absolute right-full top-1/2 z-[10001] mr-2 -translate-y-1/2 translate-x-1 whitespace-nowrap rounded-md border border-border/70 bg-popover px-2 py-1 text-xs text-popover-foreground opacity-0 shadow-md transition-[opacity,transform] duration-[180ms] ease",
          "group-hover/google-drive-connect:translate-x-0 group-hover/google-drive-connect:opacity-100 group-focus-within/google-drive-connect:translate-x-0 group-focus-within/google-drive-connect:opacity-100",
        )}
      >
        {CONNECT_GOOGLE_DRIVE_ARTIFACT_UPLOAD_TOOLTIP}
      </div>
    </div>
  );
}

export function ArtifactDownloadMenu({
  align = "end",
  ariaLabel = "Download options",
  className,
  filename,
  iconSize = 16,
  syncTarget,
  url,
}: {
  align?: "center" | "end" | "start";
  ariaLabel?: string;
  className?: string;
  filename: string;
  iconSize?: number;
  syncTarget?: ArtifactDownloadSyncTarget;
  url: string;
}) {
  const menuKey = `${url}:${filename}`;
  const openKey = useGet(artifactDownloadMenuOpenKey$);
  const openMenu = useSet(openArtifactDownloadMenu$);
  const closeMenu = useSet(closeArtifactDownloadMenu$);
  const scheduleCloseMenu = useSet(scheduleArtifactDownloadMenuClose$);
  const pageSignal = useGet(pageSignal$);
  const open = openKey === menuKey;

  const show = () => {
    openMenu(menuKey);
  };

  const hide = () => {
    scheduleCloseMenu(menuKey);
  };

  const closeNow = () => {
    closeMenu();
  };

  return (
    <Popover
      modal={false}
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          openMenu(menuKey);
          return;
        }
        closeMenu();
      }}
    >
      <PopoverAnchor asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          className={iconButtonClassName(className)}
          onPointerEnter={show}
          onPointerLeave={hide}
          onFocus={show}
          onBlur={hide}
          onClick={show}
        >
          <IconDownload size={iconSize} stroke={1.5} />
        </button>
      </PopoverAnchor>
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
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocus={show}
        onBlur={hide}
        className={cn(
          "pointer-events-auto w-56 p-1",
          ARTIFACT_FLOATING_LAYER_CLASS,
        )}
      >
        <ArtifactDownloadMenuItem
          onClick={() => {
            closeNow();
            detach(
              downloadAttachmentUrl(url, pageSignal, filename),
              Reason.DomCallback,
              "artifact download",
            );
          }}
        >
          <IconDownload size={14} stroke={1.5} />
          Download
        </ArtifactDownloadMenuItem>
        <GoogleDriveMenuItem
          closeMenu={closeNow}
          onHover={show}
          syncTarget={syncTarget}
        />
      </PopoverContent>
    </Popover>
  );
}
