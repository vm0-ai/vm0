import { useLoadable } from "ccstate-react";
import {
  IconDeviceDesktop,
  IconGitCommit,
  IconPackage,
} from "@tabler/icons-react";

import {
  getBuildCommitSha,
  getBuildVersion,
} from "../../../../lib/build-info.ts";
import { backendBuildInfo$ } from "../../../../signals/zero-page/settings/build-info.ts";

const UNAVAILABLE_VALUE = "Unavailable";

function formatBuildInfoValue(value: string | null | undefined): string {
  return value ?? UNAVAILABLE_VALUE;
}

function BuildInfoTarget({
  title,
  version,
  commitSha,
  icon: Icon,
}: {
  readonly title: string;
  readonly version: string;
  readonly commitSha: string;
  readonly icon: typeof IconGitCommit;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted/60 text-muted-foreground">
            <Icon size={15} stroke={1.5} />
          </span>
          <div className="truncate text-sm font-medium text-foreground">
            {title}
          </div>
        </div>
        <code className="zero-badge min-w-0 rounded-md px-2 py-0.5 text-right text-xs font-medium text-foreground break-all">
          {version}
        </code>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="text-xs text-muted-foreground">Commit SHA</div>
        <code className="block min-h-7 break-all rounded-md bg-muted/40 px-2 py-1.5 text-[11px] leading-4 text-foreground">
          {commitSha}
        </code>
      </div>
    </div>
  );
}

export function BuildInfoBlock() {
  const backendBuildInfoLoadable = useLoadable(backendBuildInfo$);
  const loading = backendBuildInfoLoadable.state === "loading";
  const backendBuildInfo =
    backendBuildInfoLoadable.state === "hasData"
      ? backendBuildInfoLoadable.data
      : null;
  const frontendCommitSha = formatBuildInfoValue(getBuildCommitSha());
  const frontendVersion = formatBuildInfoValue(getBuildVersion());
  const backendCommitSha = loading
    ? "Loading"
    : formatBuildInfoValue(backendBuildInfo?.backendCommitSha);
  const backendVersion = loading
    ? "Loading"
    : formatBuildInfoValue(backendBuildInfo?.backendVersion);

  return (
    <div className="flex items-start gap-4 rounded-xl bg-card p-4 zero-border">
      <div className="shrink-0">
        <div className="flex h-7 w-7 items-center justify-center">
          <IconGitCommit
            size={22}
            stroke={1.5}
            className="text-muted-foreground"
          />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="text-sm font-medium text-foreground">
          Build information
        </div>
        <div className="grid gap-4 sm:grid-cols-2 sm:gap-0">
          <div className="min-w-0 sm:pr-5">
            <BuildInfoTarget
              title="Frontend"
              version={frontendVersion}
              commitSha={frontendCommitSha}
              icon={IconDeviceDesktop}
            />
          </div>
          <div className="min-w-0 border-t border-border/60 pt-4 sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
            <BuildInfoTarget
              title="Backend"
              version={backendVersion}
              commitSha={backendCommitSha}
              icon={IconPackage}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
