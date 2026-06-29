import { createHash } from "node:crypto";

import type { HostedSitePrepareRequest } from "@vm0/api-contracts/contracts/zero-host";

export function hostedTextFile(
  path: string,
  content: string,
  contentType = "text/html; charset=utf-8",
): HostedSitePrepareRequest["files"][number] {
  const bytes = Buffer.from(content, "utf8");
  return {
    path,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentType,
  };
}
