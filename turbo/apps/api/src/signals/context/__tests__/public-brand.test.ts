import {
  CLIENT_PRODUCT_HEADER,
  CLIENT_TYPE_APP,
  CLIENT_TYPE_DESKTOP,
  CLIENT_TYPE_HEADER,
  DESKTOP_PRODUCT_OKOU,
  DESKTOP_PRODUCT_ZERO,
} from "@okouai/api-contracts/contracts/client-headers";
import { initContract } from "@okouai/api-contracts/contracts/trpc-contract";
import { computed } from "ccstate";
import { z } from "zod";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-context";
import { mockEnv } from "../../../lib/env";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

import { publicBrand$ } from "../hono";

const context = testContext();
const c = initContract();

const publicBrandTestContract = c.router({
  read: {
    method: "GET",
    path: "/__test/public-brand",
    responses: {
      200: z.object({ publicBrand: z.enum(["vm0", "okou"]) }),
    },
  },
});

const readPublicBrand$ = computed((get) => {
  return {
    status: 200 as const,
    body: { publicBrand: get(publicBrand$) },
  };
});

interface PublicBrandRequestCase {
  readonly name: string;
  readonly environment: "development" | "preview" | "production";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly expected: PublicBrand;
}

const PUBLIC_BRAND_REQUEST_CASES: readonly PublicBrandRequestCase[] = [
  {
    name: "prefers the Okou API hostname over conflicting VM0 signals",
    environment: "production",
    url: "https://api.okou.ai/__test/public-brand",
    headers: {
      origin: "https://app.vm0.ai",
      [CLIENT_TYPE_HEADER]: CLIENT_TYPE_DESKTOP,
      [CLIENT_PRODUCT_HEADER]: DESKTOP_PRODUCT_ZERO,
    },
    expected: "okou",
  },
  {
    name: "prefers the VM0 API hostname over conflicting Okou signals",
    environment: "production",
    url: "https://api.vm0.ai/__test/public-brand",
    headers: {
      origin: "https://app.okou.ai",
      [CLIENT_TYPE_HEADER]: CLIENT_TYPE_DESKTOP,
      [CLIENT_PRODUCT_HEADER]: DESKTOP_PRODUCT_OKOU,
    },
    expected: "vm0",
  },
  {
    name: "uses a trusted Okou origin on a neutral API hostname",
    environment: "production",
    url: "https://api.test/__test/public-brand",
    headers: { origin: "https://app.okou.ai" },
    expected: "okou",
  },
  {
    name: "uses an Okou preview origin on the shared preview API domain",
    environment: "preview",
    url: "https://pr-22085-api.vm6.ai/__test/public-brand",
    headers: { origin: "https://pr-22085-app.omby.ai" },
    expected: "okou",
  },
  {
    name: "uses an Okou app Worker preview origin on the shared preview API domain",
    environment: "preview",
    url: "https://pr-22085-api.vm6.ai/__test/public-brand",
    headers: {
      origin: "https://pr-22085-app-okou-app-preview.vm0.workers.dev",
    },
    expected: "okou",
  },
  {
    name: "ignores a same-named app Worker preview from another account",
    environment: "preview",
    url: "https://pr-22085-api.vm6.ai/__test/public-brand",
    headers: {
      origin: "https://pr-22085-app-okou-app-preview.attacker.workers.dev",
    },
    expected: "vm0",
  },
  {
    name: "prefers a trusted VM0 origin over the Desktop product header",
    environment: "production",
    url: "https://api.test/__test/public-brand",
    headers: {
      origin: "https://app.vm0.ai",
      [CLIENT_TYPE_HEADER]: CLIENT_TYPE_DESKTOP,
      [CLIENT_PRODUCT_HEADER]: DESKTOP_PRODUCT_OKOU,
    },
    expected: "vm0",
  },
  {
    name: "falls through an untrusted origin to the Desktop product header",
    environment: "production",
    url: "https://api.test/__test/public-brand",
    headers: {
      origin: "https://app.okou.ai.evil.example",
      [CLIENT_TYPE_HEADER]: CLIENT_TYPE_DESKTOP,
      [CLIENT_PRODUCT_HEADER]: DESKTOP_PRODUCT_OKOU,
    },
    expected: "okou",
  },
  {
    name: "keeps legacy Desktop requests on VM0",
    environment: "production",
    url: "https://api.test/__test/public-brand",
    headers: { [CLIENT_TYPE_HEADER]: CLIENT_TYPE_DESKTOP },
    expected: "vm0",
  },
  {
    name: "ignores product headers from non-Desktop clients",
    environment: "production",
    url: "https://api.test/__test/public-brand",
    headers: {
      [CLIENT_TYPE_HEADER]: CLIENT_TYPE_APP,
      [CLIENT_PRODUCT_HEADER]: DESKTOP_PRODUCT_OKOU,
    },
    expected: "vm0",
  },
  {
    name: "defaults requests without brand signals to VM0",
    environment: "production",
    url: "https://api.test/__test/public-brand",
    expected: "vm0",
  },
];

describe("publicBrand$", () => {
  it.each(PUBLIC_BRAND_REQUEST_CASES)(
    "$name",
    async ({ environment, url, headers, expected }) => {
      mockEnv("ENV", environment);
      const app = createApp({
        signal: context.signal,
        routes: [
          {
            route: publicBrandTestContract.read,
            handler: readPublicBrand$,
          },
        ],
      });

      const response = await app.request(url, { headers });

      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(body).toStrictEqual({ publicBrand: expected });
    },
  );
});
