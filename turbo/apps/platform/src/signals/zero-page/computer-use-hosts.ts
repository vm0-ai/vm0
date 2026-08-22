import { command, computed, state } from "ccstate";
import { desktopProductFromClientHeader } from "@okouai/api-contracts/contracts/client-headers";
import {
  computerUseHostsContract,
  type ComputerUseHost,
} from "@okouai/api-contracts/contracts/computer-use";
import { accept } from "../../lib/accept.ts";
import { resolveApiBaseForNavigation } from "../api-base.ts";
import { apiClient$ } from "../api-client.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { onRef, tapError } from "../utils.ts";

const OKOU_DESKTOP_DMG_DOWNLOAD_PATH =
  "/api/desktop/updates/stable/darwin/arm64/dmg";

export const OKOU_DESKTOP_DOWNLOAD_URL = new URL(
  OKOU_DESKTOP_DMG_DOWNLOAD_PATH,
  resolveApiBaseForNavigation("api"),
).toString();

type DesktopDownloadSupportStatus = "available" | "unsupported-intel-mac";

interface UserAgentDataValues {
  readonly architecture?: string;
  readonly platform?: string;
}

interface DesktopNavigator {
  readonly platform?: string;
  readonly userAgent?: string;
  readonly userAgentData?: {
    readonly platform?: string;
    readonly getHighEntropyValues?: (
      hints: readonly string[],
    ) => Promise<UserAgentDataValues>;
  };
}

function isMacPlatform(
  platform: string | undefined,
  userAgent: string | undefined,
): boolean {
  return (
    Boolean(platform?.toLowerCase().includes("mac")) ||
    /Macintosh/i.test(userAgent ?? "")
  );
}

function isIntelArchitecture(architecture: string | undefined): boolean {
  const normalized = architecture?.toLowerCase();
  return (
    normalized === "x86" ||
    normalized === "x86_64" ||
    normalized === "amd64" ||
    normalized === "ia32"
  );
}

async function isUnsupportedIntelMacForDesktop(
  navigatorRef: DesktopNavigator | null | undefined = typeof navigator ===
  "undefined"
    ? undefined
    : navigator,
): Promise<boolean> {
  const userAgentData = navigatorRef?.userAgentData;
  if (!navigatorRef || !userAgentData?.getHighEntropyValues) {
    return false;
  }

  const highEntropyValues = await tapError(
    userAgentData.getHighEntropyValues(["architecture", "platform"]),
  );
  if (!highEntropyValues) {
    return false;
  }

  const platform =
    highEntropyValues.platform ??
    userAgentData.platform ??
    navigatorRef.platform;
  return (
    isMacPlatform(platform, navigatorRef.userAgent) &&
    isIntelArchitecture(highEntropyValues.architecture)
  );
}

export const desktopDownloadSupportStatus$ = computed(
  async (): Promise<DesktopDownloadSupportStatus> => {
    return (await isUnsupportedIntelMacForDesktop())
      ? "unsupported-intel-mac"
      : "available";
  },
);

const computerUseHostsReload$ = state(0);

const reloadComputerUseHosts$ = command(({ set }) => {
  set(computerUseHostsReload$, (n) => {
    return n + 1;
  });
});

export const subscribeComputerUseHostsChanged$ = command(
  async ({ set }, signal: AbortSignal) => {
    const onChanged$ = command(({ set }) => {
      set(reloadComputerUseHosts$);
      return false;
    });
    await set(
      setAblyLoop$,
      {
        topic: "computerUseHostsChanged",
        loopCommand$: onChanged$,
      },
      signal,
    );
  },
);

const subscribeComputerUseHostsChangedOnRef$ = command(
  async ({ set }, _el: HTMLElement, signal: AbortSignal) => {
    await set(subscribeComputerUseHostsChanged$, signal);
  },
);

export const subscribeComputerUseHostsChangedRef$ = onRef(
  subscribeComputerUseHostsChangedOnRef$,
);

interface ListedComputerUseHost extends Pick<
  ComputerUseHost,
  "id" | "displayName" | "lastSeenAt" | "status"
> {
  readonly product: NonNullable<ComputerUseHost["product"]>;
  readonly hostName: string;
}

type SelectableComputerUseHost = Pick<ComputerUseHost, "id" | "status">;

export function selectedComputerUseHostId(
  hosts: readonly { readonly id: string }[],
  selectedHostId: string | null | undefined,
): string | null {
  if (!selectedHostId) {
    return null;
  }
  return hosts.some((host) => {
    return host.id === selectedHostId;
  })
    ? selectedHostId
    : null;
}

export function visibleComputerUseHosts<Host extends SelectableComputerUseHost>(
  hosts: readonly Host[],
  selectedHostId: string | null | undefined,
): Host[] {
  const selected = selectedComputerUseHostId(hosts, selectedHostId);
  return hosts.filter((host) => {
    return host.status === "online" || host.id === selected;
  });
}

export const computerUseHosts$ = computed(
  async (get): Promise<ListedComputerUseHost[]> => {
    get(computerUseHostsReload$);

    const client = get(apiClient$)(computerUseHostsContract);
    const result = await accept(client.list({}), [200, 403]);
    if (result.status !== 200) {
      return [];
    }

    return result.body.hosts.map((host) => {
      return {
        id: host.id,
        product: desktopProductFromClientHeader(host.product),
        hostName: host.hostName ?? host.displayName,
        displayName: host.displayName,
        lastSeenAt: host.lastSeenAt,
        status: host.status,
      };
    });
  },
);
