import { useLoadable } from "ccstate-react";
import { IconGitCommit } from "@tabler/icons-react";

import {
  getBuildCommitSha,
  getBuildVersion,
} from "../../../../lib/build-info.ts";
import { backendBuildInfo$ } from "../../../../signals/zero-page/settings/build-info.ts";

const UNAVAILABLE_VALUE = "Unavailable";

function formatCommitSha(value: string | null | undefined): string {
  return value ?? UNAVAILABLE_VALUE;
}

function BuildInfoRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <code className="break-all text-xs text-foreground sm:text-right">
        {value}
      </code>
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
  const frontendCommitSha = formatCommitSha(getBuildCommitSha());
  const frontendVersion = formatCommitSha(getBuildVersion());
  const backendCommitSha = loading
    ? "Loading"
    : formatCommitSha(backendBuildInfo?.backendCommitSha);
  const backendVersion = loading
    ? "Loading"
    : formatCommitSha(backendBuildInfo?.backendVersion);

  return (
    <div className="flex items-start gap-4 bg-card p-4 rounded-xl zero-border">
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
        <div className="flex flex-col gap-2">
          <BuildInfoRow label="Frontend version" value={frontendVersion} />
          <BuildInfoRow label="Frontend commit SHA" value={frontendCommitSha} />
          <BuildInfoRow label="Backend version" value={backendVersion} />
          <BuildInfoRow label="Backend commit SHA" value={backendCommitSha} />
        </div>
      </div>
    </div>
  );
}
