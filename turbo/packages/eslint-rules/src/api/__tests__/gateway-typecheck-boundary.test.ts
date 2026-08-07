import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { gatewayTypecheckBoundary } from "../rules/gateway-typecheck-boundary.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();

const GATEWAY_MODULE = "/app/src/lib/secret-kms-client.ts";
const OTHER_GATEWAY_MODULE = "/app/src/lib/singleton.ts";
const CORE_MODULE = "/app/src/signals/services/crypto.utils.ts";

const options: [{ modules: string[]; isolatedDependencies: string[] }] = [
  {
    modules: [
      GATEWAY_MODULE,
      OTHER_GATEWAY_MODULE,
      "/app/src/signals/utils.ts",
    ],
    isolatedDependencies: ["@aws-sdk", "@smithy"],
  },
];

ruleTester.run("gateway-typecheck-boundary", gatewayTypecheckBoundary, {
  valid: [
    {
      name: "gateway module imports another gateway module",
      filename: GATEWAY_MODULE,
      code: `import { singleton } from "./singleton";`,
      options,
    },
    {
      name: "gateway module imports a workspace package",
      filename: GATEWAY_MODULE,
      code: `import { formatMessage } from "@vm0/core/log-utils";`,
      options,
    },
    {
      name: "gateway module owns the isolated dependency",
      filename: GATEWAY_MODULE,
      code: `import { KMSClient } from "@aws-sdk/client-kms";
             function client(): KMSClient { return new KMSClient({}); }`,
      options,
    },
    {
      name: "gateway module exports a type it owns",
      filename: GATEWAY_MODULE,
      code: `import { DecryptCommand } from "@aws-sdk/client-kms";
             export interface SecretKmsClient {
               decrypt(request: DecryptRequest): Promise<Uint8Array>;
             }
             function build(): DecryptCommand { return new DecryptCommand({}); }`,
      options,
    },
    {
      name: "sdk type on a local inside an exported function is dropped by declaration emit",
      filename: GATEWAY_MODULE,
      code: `import { GetObjectCommandOutput } from "@aws-sdk/client-s3";
             export function read(): Promise<Buffer> {
               const response: GetObjectCommandOutput = load();
               return response.Body;
             }`,
      options,
    },
    {
      name: "core module imports the gateway wrapper",
      filename: CORE_MODULE,
      code: `import { getSecretKmsClient } from "../../lib/secret-kms-client";`,
      options,
    },
    {
      name: "unconfigured file is untouched",
      filename: CORE_MODULE,
      code: `import { KMSClient } from "@aws-sdk/client-kms";`,
    },
  ],
  invalid: [
    {
      name: "gateway module reaches outside the project",
      filename: GATEWAY_MODULE,
      code: `import { writeDb$ } from "../signals/external/db";`,
      options,
      errors: [{ messageId: "outboundImport" }],
    },
    {
      name: "gateway module reaches outside the project through a deep path",
      filename: "/app/src/signals/utils.ts",
      code: `import { nowDate } from "../lib/time";`,
      options,
      errors: [{ messageId: "outboundImport" }],
    },
    {
      name: "core module imports the isolated dependency",
      filename: CORE_MODULE,
      code: `import { DecryptCommand } from "@aws-sdk/client-kms";`,
      options,
      errors: [{ messageId: "isolatedDependency" }],
    },
    {
      name: "core module imports the isolated dependency in a type position",
      filename: CORE_MODULE,
      code: `type Output = import("@aws-sdk/client-s3").GetObjectCommandOutput;`,
      options,
      errors: [{ messageId: "isolatedDependency" }],
    },
    {
      name: "gateway module leaks an sdk type through an exported signature",
      filename: GATEWAY_MODULE,
      code: `import { KMSClient } from "@aws-sdk/client-kms";
             export function getClient(): KMSClient { return new KMSClient({}); }`,
      options,
      errors: [{ messageId: "exportedSdkType" }],
    },
    {
      name: "gateway module leaks an sdk type through an exported alias",
      filename: GATEWAY_MODULE,
      code: `import type { DecryptCommandOutput } from "@aws-sdk/client-kms";
             export type Decrypted = DecryptCommandOutput;`,
      options,
      errors: [{ messageId: "exportedSdkType" }],
    },
    {
      name: "gateway module re-exports the isolated dependency",
      filename: GATEWAY_MODULE,
      code: `export { KMSClient } from "@aws-sdk/client-kms";`,
      options,
      errors: [{ messageId: "exportedSdkType" }],
    },
  ],
});
