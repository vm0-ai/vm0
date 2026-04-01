import type { PermissionNamesOf } from "./index";
import { vercelFirewall } from "./vercel.generated";
import { registerCategories } from "./categories";

const vercelCategories: Record<
  PermissionNamesOf<typeof vercelFirewall>,
  string
> = {
  // Admin (14)
  "access-groups:read": "Admin",
  "access-groups:write": "Admin",
  "authentication:read": "Admin",
  "authentication:write": "Admin",
  "billing:read": "Admin",
  "billing:write": "Admin",
  "marketplace:read": "Admin",
  "marketplace:write": "Admin",
  "projectMembers:read": "Admin",
  "projectMembers:write": "Admin",
  "security:read": "Admin",
  "security:write": "Admin",
  "teams:read": "Admin",
  "teams:write": "Admin",
  "user:write": "Admin",

  // Deploy (4)
  "deployments:write": "Deploy",
  "checks:write": "Deploy",
  "checks-v2:write": "Deploy",
  "rolling-release:write": "Deploy",

  // Read — all non-admin :read permissions
  "aliases:read": "Read",
  "api-observability:read": "Read",
  "artifacts:read": "Read",
  "bulk-redirects:read": "Read",
  "certs:read": "Read",
  "checks:read": "Read",
  "checks-v2:read": "Read",
  "connect:read": "Read",
  "deployments:read": "Read",
  "dns:read": "Read",
  "domains:read": "Read",
  "domains-registrar:read": "Read",
  "drains:read": "Read",
  "edge-config:read": "Read",
  "environment:read": "Read",
  "feature-flags:read": "Read",
  "integrations:read": "Read",
  "logDrains:read": "Read",
  "logs:read": "Read",
  "microfrontends:read": "Read",
  "project-routes:read": "Read",
  "projects:read": "Read",
  "rolling-release:read": "Read",
  "sandboxes:read": "Read",
  "sandboxes-v2-beta:read": "Read",
  "user:read": "Read",
  "webhooks:read": "Read",

  // Write — all remaining :write not in Deploy or Admin
  "aliases:write": "Write",
  "api-observability:write": "Write",
  "artifacts:write": "Write",
  "bulk-redirects:write": "Write",
  "certs:write": "Write",
  "connect:write": "Write",
  "dns:write": "Write",
  "domains:write": "Write",
  "domains-registrar:write": "Write",
  "drains:write": "Write",
  "edge-cache:write": "Write",
  "edge-config:write": "Write",
  "environment:write": "Write",
  "feature-flags:write": "Write",
  "integrations:write": "Write",
  "logDrains:write": "Write",
  "microfrontends:write": "Write",
  "project-routes:write": "Write",
  "projects:write": "Write",
  "sandboxes:write": "Write",
  "sandboxes-v2-beta:write": "Write",
  "static-ips:write": "Write",
  "webhooks:write": "Write",
};

const vercelCategoryOrder = ["Read", "Deploy", "Write", "Admin"] as const;

registerCategories("vercel", {
  categories: vercelCategories,
  displayOrder: vercelCategoryOrder,
});
