// Apollo.io API firewall config.
// Source: https://docs.apollo.io/docs/api-overview

import type { FirewallConfig } from "../contracts/firewalls";

export const apolloFirewall: FirewallConfig = {
  name: "apollo",
  description: "Apollo",
  placeholders: {
    APOLLO_TOKEN: "CoffeeSafeLocalCoffeeSafeLocalCof",
  },
  apis: [
    {
      base: "https://api.apollo.io",
      auth: {
        headers: {
          "X-Api-Key": "${{ secrets.APOLLO_TOKEN }}",
        },
      },
      permissions: [],
    },
  ],
};
