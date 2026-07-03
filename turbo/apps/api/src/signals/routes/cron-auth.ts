import { computed } from "ccstate";

import { env } from "../../lib/env";
import { authorization$ } from "../context/hono";

interface CronUnauthorizedResponse {
  readonly status: 401;
  readonly body: {
    readonly error: {
      readonly message: "Invalid cron secret";
      readonly code: "UNAUTHORIZED";
    };
  };
}

export function cronUnauthorized(): CronUnauthorizedResponse {
  return {
    status: 401,
    body: {
      error: {
        message: "Invalid cron secret",
        code: "UNAUTHORIZED",
      },
    },
  };
}

export const hasValidCronSecret$ = computed((get): boolean => {
  return get(authorization$) === `Bearer ${env("CRON_SECRET")}`;
});
