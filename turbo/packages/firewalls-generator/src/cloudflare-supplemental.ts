export type CloudflareSupplementalAuthBehavior =
  | "connector"
  | "preserveAuthorization";

export type CloudflareSupplementalOpenApiPresence = "present" | "absent";

export interface CloudflareSupplementalOperation {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  readonly path: string;
  readonly permission: string;
  readonly authBehavior: CloudflareSupplementalAuthBehavior;
  readonly openApi: CloudflareSupplementalOpenApiPresence;
  readonly source: string;
  readonly reason: string;
}

export const CLOUDFLARE_SUPPLEMENTAL_OPERATIONS = [
  {
    method: "GET",
    path: "/accounts/{account_id}/pages/projects/{project_name}/upload-token",
    permission: "page.write",
    authBehavior: "connector",
    openApi: "absent",
    source:
      "https://github.com/cloudflare/workers-sdk/blob/1cea1299432fdf8e15a8e91816d8fe5e3b53e520/packages/wrangler/src/pages/upload.ts",
    reason: "Wrangler fetches a Pages upload JWT before direct asset upload.",
  },
  {
    method: "POST",
    path: "/pages/assets/check-missing",
    permission: "page.write",
    authBehavior: "preserveAuthorization",
    openApi: "absent",
    source:
      "https://github.com/cloudflare/workers-sdk/blob/1cea1299432fdf8e15a8e91816d8fe5e3b53e520/packages/wrangler/src/pages/upload.ts",
    reason:
      "Cloudflare Pages asset service expects the provider-issued upload JWT.",
  },
  {
    method: "POST",
    path: "/pages/assets/upload",
    permission: "page.write",
    authBehavior: "preserveAuthorization",
    openApi: "absent",
    source:
      "https://github.com/cloudflare/workers-sdk/blob/1cea1299432fdf8e15a8e91816d8fe5e3b53e520/packages/wrangler/src/pages/upload.ts",
    reason:
      "Cloudflare Pages asset service expects the provider-issued upload JWT.",
  },
  {
    method: "POST",
    path: "/pages/assets/upsert-hashes",
    permission: "page.write",
    authBehavior: "preserveAuthorization",
    openApi: "absent",
    source:
      "https://github.com/cloudflare/workers-sdk/blob/1cea1299432fdf8e15a8e91816d8fe5e3b53e520/packages/wrangler/src/pages/upload.ts",
    reason:
      "Cloudflare Pages asset service expects the provider-issued upload JWT.",
  },
  {
    method: "POST",
    path: "/accounts/{account_id}/workers/dispatch/namespaces/{dispatch_namespace}/scripts/{script_name}/assets-upload-session",
    permission: "workers-scripts.write",
    authBehavior: "connector",
    openApi: "present",
    source:
      "https://github.com/cloudflare/workers-sdk/blob/1cea1299432fdf8e15a8e91816d8fe5e3b53e520/packages/deploy-helpers/src/deploy/helpers/assets.ts",
    reason:
      "Wrangler Workers for Platforms initializes an asset upload session before uploading static assets.",
  },
  {
    method: "POST",
    path: "/accounts/{account_id}/workers/assets/upload",
    permission: "workers-scripts.write",
    authBehavior: "preserveAuthorization",
    openApi: "present",
    source:
      "https://developers.cloudflare.com/workers/static-assets/direct-upload/index.md",
    reason:
      "Workers static asset upload expects the temporary JWT returned by the upload-session endpoint.",
  },
  {
    method: "POST",
    path: "/accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}/tails",
    permission: "page.write",
    authBehavior: "connector",
    openApi: "absent",
    source:
      "https://github.com/cloudflare/workers-sdk/blob/1cea1299432fdf8e15a8e91816d8fe5e3b53e520/packages/wrangler/src/tail/createTail.ts",
    reason: "Wrangler Pages deployment tail uses this Cloudflare endpoint.",
  },
  {
    method: "DELETE",
    path: "/accounts/{account_id}/pages/projects/{project_name}/deployments/{deployment_id}/tails/{tail_id}",
    permission: "page.write",
    authBehavior: "connector",
    openApi: "absent",
    source:
      "https://github.com/cloudflare/workers-sdk/blob/1cea1299432fdf8e15a8e91816d8fe5e3b53e520/packages/wrangler/src/tail/createTail.ts",
    reason: "Wrangler Pages deployment tail uses this Cloudflare endpoint.",
  },
] as const satisfies readonly CloudflareSupplementalOperation[];
