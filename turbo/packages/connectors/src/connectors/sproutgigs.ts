import type { ConnectorConfig } from "../connectors";

export const sproutgigs = {
  sproutgigs: {
    label: "SproutGigs",
    category: "marketing-content-growth",
    tags: [
      "microtasks",
      "jobs",
      "gigs",
      "freelancers",
      "crowdsourcing",
      "picoworkers",
    ],
    helpText:
      "Connect SproutGigs to manage buyer jobs, gigs, freelancer lists, profiles, balances, and task reviews through the SproutGigs API",
    authMethods: {
      "api-token": {
        label: "API Secret",
        helpText:
          "1. Log in to [SproutGigs](https://sproutgigs.com)\n2. Open **Account Settings** and go to the **Settings** tab\n3. Create or reset your API secret\n4. Enter your SproutGigs user ID and API secret. SproutGigs signs requests with HTTP Basic Auth using `USER_ID:API_SECRET`.",
        storage: {
          secrets: ["SPROUTGIGS_API_SECRET"],
          variables: ["SPROUTGIGS_USER_ID"],
        },
        grant: {
          kind: "manual",
          fields: {
            SPROUTGIGS_USER_ID: {
              label: "User ID",
              required: true,
              storage: "variable",
              placeholder: "your-user-id",
            },
            SPROUTGIGS_API_SECRET: {
              label: "API Secret",
              required: true,
              placeholder: "your-sproutgigs-api-secret",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            SPROUTGIGS_USER_ID: "$vars.SPROUTGIGS_USER_ID",
            SPROUTGIGS_API_SECRET: "$secrets.SPROUTGIGS_API_SECRET",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
