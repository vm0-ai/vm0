// Hand-authored firewall config for Slock's public control API.
// Move this to the firewalls generator when Slock publishes an API spec.

import type { FirewallConfig } from "../firewall-types";

export const slockFirewall = {
  name: "slock",
  description: "Slock API",
  placeholders: {
    SLOCK_ACCESS_TOKEN: "slock_access_token_placeholder",
    SLOCK_SERVER_ID: "slock_server_id_placeholder",
  },
  apis: [
    {
      base: "https://api.slock.ai",
      auth: {
        headers: {
          Authorization: "Bearer ${{ secrets.SLOCK_ACCESS_TOKEN }}",
          "X-Server-Id": "${{ secrets.SLOCK_SERVER_ID }}",
        },
      },
    },
  ],
} as const satisfies FirewallConfig;
