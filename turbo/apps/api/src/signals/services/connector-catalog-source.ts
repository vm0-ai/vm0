import { createHash } from "node:crypto";

import { env } from "../../lib/env";
import { safeUrlParse } from "../utils";

export interface ConnectorCatalogSource {
  readonly bucket: string;
  readonly sourceId: string;
}

export function connectorCatalogSource(): ConnectorCatalogSource {
  const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const endpoint =
    env("S3_ENDPOINT") ??
    `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
  const endpointUrl = safeUrlParse(endpoint);
  if (
    endpointUrl === undefined ||
    (endpointUrl.protocol !== "http:" && endpointUrl.protocol !== "https:")
  ) {
    throw new Error("Connector catalog source endpoint is invalid");
  }
  const authority = endpointUrl.origin;
  const sourceId = createHash("sha256")
    .update(authority)
    .update("\0")
    .update(bucket)
    .digest("hex");
  return { bucket, sourceId };
}
