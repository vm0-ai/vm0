// Auto-generated from Pika Developer API docs.
// Source: https://github.com/Pika-Labs/Pika-Skills
// Regenerate: cd turbo && pnpm -F @vm0/firewalls-generator generate:pika

import type { FirewallConfig } from "../contracts/firewalls";

export const pikaFirewall = {
  name: "pika",
  description: "Pika",
  placeholders: {
    PIKA_TOKEN: "dk_PikaDevKeyPlaceholder0000000000000000",
  },
  apis: [
    {
      base: "https://srkibaanghvsriahb.pika.art",
      auth: {
        headers: {
          Authorization: "DevKey ${{ secrets.PIKA_TOKEN }}",
        },
      },
      permissions: [
        {
          name: "all",
          description: "Full access to all Pika API endpoints",
          rules: ["ANY /{path*}"],
        },
      ],
    },
  ],
} as const satisfies FirewallConfig;
