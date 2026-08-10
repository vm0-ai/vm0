import { initContract } from "@vm0/api-contracts/contracts/trpc-contract";
import { command } from "ccstate";
import { z } from "zod";

import {
  fetchHostHasBlockedAddress,
  resolveFetchHostAddresses,
} from "../../lib/blocked-fetch-host";
import { request$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const c = initContract();

export const workerRuntimeProbeContract = c.router({
  outboundSafety: {
    method: "POST",
    path: "/api/test/worker-runtime/outbound-safety",
    headers: z.object({
      "x-vm0-test-endpoint-bypass": z.string().optional(),
    }),
    body: z.object({}),
    responses: {
      200: z.object({
        ok: z.literal(true),
        dns_private_address_blocked: z.boolean(),
        native_private_fetch_blocked: z.boolean(),
      }),
      404: z.unknown(),
    },
  },
});

const probeWorkerOutboundSafety$ = command(
  async ({ get }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const privateHostname = "localtest.me";
    const addresses = await resolveFetchHostAddresses(privateHostname);
    signal.throwIfAborted();
    const dnsPrivateAddressBlocked = fetchHostHasBlockedAddress(addresses);
    const [privateFetch] = await Promise.allSettled([
      fetch(`https://${privateHostname}`, {
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      }),
    ]);
    signal.throwIfAborted();
    if (privateFetch.status === "fulfilled") {
      await privateFetch.value.body?.cancel();
    }
    return {
      status: 200 as const,
      body: {
        ok: true as const,
        dns_private_address_blocked: dnsPrivateAddressBlocked,
        native_private_fetch_blocked: privateFetch.status === "rejected",
      },
    };
  },
);

export const workerRuntimeProbeRoutes: readonly RouteEntry[] = [
  {
    route: workerRuntimeProbeContract.outboundSafety,
    handler: probeWorkerOutboundSafety$,
  },
];
