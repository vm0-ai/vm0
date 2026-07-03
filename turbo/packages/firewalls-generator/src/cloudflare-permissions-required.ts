export type CloudflarePermissionsRequiredOperationMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD";

export interface CloudflarePermissionsRequiredOperation {
  readonly method: CloudflarePermissionsRequiredOperationMethod;
  readonly path: string;
  readonly cfPermission: string;
  readonly permission: string;
  readonly source: string;
  readonly reason: string;
}

interface CloudflarePermissionsRequiredRoute {
  readonly method: CloudflarePermissionsRequiredOperationMethod;
  readonly path: string;
}

interface CloudflarePermissionsRequiredRouteGroup {
  readonly cfPermission: string;
  readonly permission: string;
  readonly reason: string;
  readonly routes: readonly CloudflarePermissionsRequiredRoute[];
}

const CLOUDFLARE_OPENAPI_CF_PERMISSIONS_SOURCE =
  "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json x-cfPermissionsRequired";

function cfPermissionRoutes(
  group: CloudflarePermissionsRequiredRouteGroup,
): CloudflarePermissionsRequiredOperation[] {
  return group.routes.map((route) => {
    return {
      method: route.method,
      path: route.path,
      cfPermission: group.cfPermission,
      permission: group.permission,
      source: CLOUDFLARE_OPENAPI_CF_PERMISSIONS_SOURCE,
      reason: group.reason,
    };
  });
}

export const CLOUDFLARE_PERMISSIONS_REQUIRED_OPERATIONS: readonly CloudflarePermissionsRequiredOperation[] =
  [
    ...cfPermissionRoutes({
      cfPermission: "com.cloudflare.api.account.ai",
      permission: "ai.write",
      reason:
        "Websocket Workers AI run endpoints use the official Workers AI scope family; Cloudflare exposes read/write scopes, and existing run endpoints are covered by ai.write.",
      routes: [
        {
          method: "GET",
          path: "/accounts/{account_id}/ai/run/@cf/deepgram/aura",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai/run/@cf/deepgram/aura-1",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai/run/@cf/deepgram/aura-1-internal",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai/run/@cf/deepgram/aura-2",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai/run/@cf/deepgram/aura-2-en",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai/run/@cf/deepgram/aura-2-en-ws",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai/run/@cf/deepgram/aura-2-es",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai/run/@cf/deepgram/flux",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai/run/@cf/deepgram/nova-3",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai/run/@cf/deepgram/nova-3-internal",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai/run/@cf/deepgram/nova-3-ws",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai/run/@cf/nvidia/nemotron-speech-streaming-en-0.6b",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai/run/@cf/pipecat-ai/smart-turn-v2",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai/run/@cf/pipecat-ai/smart-turn-v3",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai/run/@cf/sven/test-pipe-http",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai/run/@cf/test/hello-world-cog",
        },
      ],
    }),
    ...cfPermissionRoutes({
      cfPermission: "com.cloudflare.api.account.ai-search",
      permission: "ai-search.read",
      reason:
        "AI Search list, fetch, stats, logs, and download endpoints map to Cloudflare's official AI Search Read OAuth scope.",
      routes: [
        { method: "GET", path: "/accounts/{account_id}/ai-search/instances" },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai-search/instances/{id}",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai-search/instances/{id}/jobs",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai-search/instances/{id}/jobs/{job_id}",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai-search/instances/{id}/jobs/{job_id}/logs",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai-search/instances/{id}/stats",
        },
        { method: "GET", path: "/accounts/{account_id}/ai-search/namespaces" },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}/items",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}/items/{item_id}",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}/items/{item_id}/chunks",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}/items/{item_id}/download",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}/items/{item_id}/logs",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}/jobs",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}/jobs/{job_id}",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}/jobs/{job_id}/logs",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}/stats",
        },
        { method: "GET", path: "/accounts/{account_id}/ai-search/tokens" },
        {
          method: "GET",
          path: "/accounts/{account_id}/ai-search/tokens/{id}",
        },
      ],
    }),
    ...cfPermissionRoutes({
      cfPermission: "com.cloudflare.api.account.ai-search",
      permission: "ai-search.write",
      reason:
        "AI Search namespace, instance, and token mutations map to Cloudflare's official AI Search Write OAuth scope.",
      routes: [
        { method: "POST", path: "/accounts/{account_id}/ai-search/instances" },
        {
          method: "DELETE",
          path: "/accounts/{account_id}/ai-search/instances/{id}",
        },
        {
          method: "PUT",
          path: "/accounts/{account_id}/ai-search/instances/{id}",
        },
        {
          method: "POST",
          path: "/accounts/{account_id}/ai-search/namespaces",
        },
        {
          method: "DELETE",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}",
        },
        {
          method: "PUT",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}",
        },
        {
          method: "POST",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances",
        },
        {
          method: "DELETE",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}",
        },
        {
          method: "PATCH",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}",
        },
        {
          method: "PUT",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}",
        },
        { method: "POST", path: "/accounts/{account_id}/ai-search/tokens" },
        {
          method: "DELETE",
          path: "/accounts/{account_id}/ai-search/tokens/{id}",
        },
        {
          method: "PUT",
          path: "/accounts/{account_id}/ai-search/tokens/{id}",
        },
      ],
    }),
    ...cfPermissionRoutes({
      cfPermission: "com.cloudflare.api.account.ai-search",
      permission: "ai-search.run",
      reason:
        "AI Search query and chat execution endpoints map to Cloudflare's official AI Search Run OAuth scope.",
      routes: [
        {
          method: "POST",
          path: "/accounts/{account_id}/ai-search/instances/{id}/chat/completions",
        },
        {
          method: "POST",
          path: "/accounts/{account_id}/ai-search/instances/{id}/search",
        },
        {
          method: "POST",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/chat/completions",
        },
        {
          method: "POST",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}/chat/completions",
        },
        {
          method: "POST",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}/search",
        },
        {
          method: "POST",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/search",
        },
      ],
    }),
    ...cfPermissionRoutes({
      cfPermission: "com.cloudflare.api.account.ai-search",
      permission: "ai-search.index",
      reason:
        "AI Search item and indexing job mutations map to Cloudflare's official AI Search Index OAuth scope.",
      routes: [
        {
          method: "POST",
          path: "/accounts/{account_id}/ai-search/instances/{id}/jobs",
        },
        {
          method: "PATCH",
          path: "/accounts/{account_id}/ai-search/instances/{id}/jobs/{job_id}",
        },
        {
          method: "POST",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}/items",
        },
        {
          method: "PUT",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}/items",
        },
        {
          method: "DELETE",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}/items/{item_id}",
        },
        {
          method: "PATCH",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}/items/{item_id}",
        },
        {
          method: "POST",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}/jobs",
        },
        {
          method: "PATCH",
          path: "/accounts/{account_id}/ai-search/namespaces/{name}/instances/{id}/jobs/{job_id}",
        },
      ],
    }),
    ...cfPermissionRoutes({
      cfPermission: "com.cloudflare.api.account.aig",
      permission: "aig.read",
      reason:
        "AI Gateway provider configuration lookup maps to Cloudflare's official AI Gateway Read OAuth scope.",
      routes: [
        {
          method: "GET",
          path: "/accounts/{account_id}/ai-gateway/gateways/{gateway_id}/provider_configs",
        },
      ],
    }),
    ...cfPermissionRoutes({
      cfPermission: "com.cloudflare.api.account.brapi.read",
      permission: "browser-rendering.write",
      reason:
        "Cloudflare marks these Browser Rendering control endpoints with brapi.read, but they use mutation methods, so the firewall keeps them under Browser Rendering Write to avoid default-allowing side effects.",
      routes: [
        {
          method: "DELETE",
          path: "/accounts/{account_id}/browser-rendering/crawl/{job_id}",
        },
        {
          method: "DELETE",
          path: "/accounts/{account_id}/browser-rendering/devtools/browser/{session_id}",
        },
        {
          method: "PUT",
          path: "/accounts/{account_id}/browser-rendering/devtools/browser/{session_id}/json/new",
        },
      ],
    }),
    ...cfPermissionRoutes({
      cfPermission: "com.cloudflare.api.account.email.sending.create",
      permission: "email-sending.write",
      reason:
        "Email Sending create and send endpoints map to Cloudflare's official Email Sending Write OAuth scope.",
      routes: [
        { method: "POST", path: "/accounts/{account_id}/email/sending/send" },
        {
          method: "POST",
          path: "/accounts/{account_id}/email/sending/send_raw",
        },
        { method: "POST", path: "/zones/{zone_id}/email/sending/subdomains" },
        {
          method: "POST",
          path: "/zones/{zone_id}/email/sending/subdomains/{subdomain_id}/dns",
        },
      ],
    }),
    ...cfPermissionRoutes({
      cfPermission: "com.cloudflare.api.account.email.sending.delete",
      permission: "email-sending.write",
      reason:
        "Email Sending delete endpoints map to Cloudflare's official Email Sending Write OAuth scope.",
      routes: [
        {
          method: "DELETE",
          path: "/zones/{zone_id}/email/sending/subdomains/{subdomain_id}",
        },
      ],
    }),
    ...cfPermissionRoutes({
      cfPermission: "com.cloudflare.api.account.email.sending.read",
      permission: "email-sending.read",
      reason:
        "Email Sending limits, DNS status, subdomain inspection, and preview endpoints map to Cloudflare's official Email Sending Read OAuth scope.",
      routes: [
        { method: "GET", path: "/accounts/{account_id}/email/sending/limits" },
        { method: "GET", path: "/zones/{zone_id}/email/sending/subdomains" },
        {
          method: "GET",
          path: "/zones/{zone_id}/email/sending/subdomains/{subdomain_id}",
        },
        {
          method: "GET",
          path: "/zones/{zone_id}/email/sending/subdomains/{subdomain_id}/dns",
        },
        {
          method: "GET",
          path: "/zones/{zone_id}/email/sending/subdomains/{subdomain_id}/dns/status",
        },
        {
          method: "POST",
          path: "/zones/{zone_id}/email/sending/subdomains/preview",
        },
      ],
    }),
    ...cfPermissionRoutes({
      cfPermission: "com.cloudflare.edge.r2.bucket.read",
      permission: "workers-r2.read",
      reason:
        "R2 bucket and object inspection endpoints map to Cloudflare's official Workers R2 Storage Read OAuth scope.",
      routes: [
        {
          method: "GET",
          path: "/accounts/{account_id}/r2/buckets/{bucket_name}",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/r2/buckets/{bucket_name}/domains/custom",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/r2/buckets/{bucket_name}/domains/managed",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/r2/buckets/{bucket_name}/local-uploads",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/r2/buckets/{bucket_name}/objects",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/r2/buckets/{bucket_name}/objects/{object_key}",
        },
        {
          method: "GET",
          path: "/accounts/{account_id}/r2/buckets/{bucket_name}/sippy",
        },
      ],
    }),
    ...cfPermissionRoutes({
      cfPermission: "com.cloudflare.edge.r2.bucket.write",
      permission: "workers-r2.write",
      reason:
        "R2 bucket, custom-domain, local-upload, object, and Sippy mutations map to Cloudflare's official Workers R2 Storage Write OAuth scope.",
      routes: [
        {
          method: "PATCH",
          path: "/accounts/{account_id}/r2/buckets/{bucket_name}",
        },
        {
          method: "POST",
          path: "/accounts/{account_id}/r2/buckets/{bucket_name}/domains/custom",
        },
        {
          method: "PUT",
          path: "/accounts/{account_id}/r2/buckets/{bucket_name}/domains/custom/{domain}",
        },
        {
          method: "PUT",
          path: "/accounts/{account_id}/r2/buckets/{bucket_name}/domains/managed",
        },
        {
          method: "PUT",
          path: "/accounts/{account_id}/r2/buckets/{bucket_name}/local-uploads",
        },
        {
          method: "PUT",
          path: "/accounts/{account_id}/r2/buckets/{bucket_name}/objects/{object_key}",
        },
        {
          method: "PUT",
          path: "/accounts/{account_id}/r2/buckets/{bucket_name}/sippy",
        },
      ],
    }),
  ];
