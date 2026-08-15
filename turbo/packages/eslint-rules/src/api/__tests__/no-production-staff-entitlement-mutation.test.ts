import { RuleTester } from "@typescript-eslint/rule-tester";
import { afterAll, describe, it } from "vitest";

import { noProductionStaffEntitlementMutation } from "../rules/no-production-staff-entitlement-mutation.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester();
const fixtureModule = "../../../test-fixtures/org-plan-entitlement";
const staffOrgId = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";

ruleTester.run(
  "no-production-staff-entitlement-mutation",
  noProductionStaffEntitlementMutation,
  {
    valid: [
      {
        name: "fixed staff identity remains valid for read and hash behavior",
        code: `
          const STAFF_ORG_ID = "${staffOrgId}";
          expect(hash(STAFF_ORG_ID)).toBe(expectedHash);
          const actor = user({ orgId: STAFF_ORG_ID });
          await client.read({ params: { orgId: actor.orgId } });
        `,
      },
      {
        name: "ordinary unique actor entitlement remains valid",
        code: `
          import { randomUUID } from "node:crypto";
          const actor = user({ orgId: "org_" + randomUUID() });
          await api.grantProEntitlement(actor);
        `,
      },
      {
        name: "unique staff fixture mutations remain valid",
        code: `
          import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
          import { upsertOrgPlanEntitlementFixture, deleteOrgPlanEntitlementFixture } from "${fixtureModule}";
          const orgId = createUniqueStaffOrgIdFixture();
          await upsertOrgPlanEntitlementFixture({ orgId });
          await deleteOrgPlanEntitlementFixture(orgId);
        `,
      },
      {
        name: "uncalled defensive fixed-id branch is not a mutation flow",
        code: `
          const STAFF_ORG_ID = "${staffOrgId}";
          async function entitledChatActor(options = {}) {
            const actor = user(options);
            await api.grantProEntitlement(actor, options.orgId === STAFF_ORG_ID ? { customerId: "staff" } : {});
          }
          await entitledChatActor({ orgId: "org_fixture" });
        `,
      },
    ],
    invalid: [
      {
        name: "destructured namespace fixture mutation is rejected",
        code: `
          import * as entitlement from "${fixtureModule}";
          const STAFF_ORG_ID = "${staffOrgId}";
          const { upsertOrgPlanEntitlementFixture: writeEntitlement } = entitlement;
          await writeEntitlement({ orgId: STAFF_ORG_ID });
        `,
        errors: [{ messageId: "productionStaffMutation" }],
      },
      {
        name: "namespace fixture mutation of fixed staff is rejected",
        code: `
          import * as entitlement from "${fixtureModule}";
          const STAFF_ORG_ID = "${staffOrgId}";
          await entitlement.upsertOrgPlanEntitlementFixture({ orgId: STAFF_ORG_ID });
        `,
        errors: [{ messageId: "productionStaffMutation" }],
      },
      {
        name: "destructured options wrapper propagation is rejected",
        code: `
          import { upsertOrgPlanEntitlementFixture } from "${fixtureModule}";
          const STAFF_ORG_ID = "${staffOrgId}";
          async function writeEntitlement({ orgId }) {
            await upsertOrgPlanEntitlementFixture({ orgId });
          }
          await writeEntitlement({ orgId: STAFF_ORG_ID });
        `,
        errors: [{ messageId: "productionStaffMutation" }],
      },
      {
        name: "direct fixed entitlement upsert is rejected",
        code: `
          import { upsertOrgPlanEntitlementFixture } from "${fixtureModule}";
          await upsertOrgPlanEntitlementFixture({ orgId: "${staffOrgId}" });
        `,
        errors: [{ messageId: "productionStaffMutation" }],
      },
      {
        name: "const alias fixed entitlement delete is rejected",
        code: `
          import { deleteOrgPlanEntitlementFixture } from "${fixtureModule}";
          const STAFF_ORG_ID = "${staffOrgId}";
          await deleteOrgPlanEntitlementFixture(STAFF_ORG_ID);
        `,
        errors: [{ messageId: "productionStaffMutation" }],
      },
      {
        name: "fixed staff actor grant is rejected",
        code: `
          const STAFF_ORG_ID = "${staffOrgId}";
          const actor = user({ orgId: STAFF_ORG_ID });
          await api.grantProEntitlement(actor);
        `,
        errors: [{ messageId: "productionStaffMutation" }],
      },
      {
        name: "wrapper parameter propagation is rejected",
        code: `
          const STAFF_ORG_ID = "${staffOrgId}";
          async function grant(actor) {
            await api.grantProEntitlement(actor);
          }
          await grant(user({ orgId: STAFF_ORG_ID }));
        `,
        errors: [{ messageId: "productionStaffMutation" }],
      },
      {
        name: "local mutation alias is rejected",
        code: `
          import { upsertOrgPlanEntitlementFixture } from "${fixtureModule}";
          const writeEntitlement = upsertOrgPlanEntitlementFixture;
          const orgId = "${staffOrgId}";
          await writeEntitlement({ orgId });
        `,
        errors: [{ messageId: "productionStaffMutation" }],
      },
      {
        name: "options-object wrapper propagation is rejected",
        code: `
          import { upsertOrgPlanEntitlementFixture } from "${fixtureModule}";
          const STAFF_ORG_ID = "${staffOrgId}";
          async function writeEntitlement(options) {
            await upsertOrgPlanEntitlementFixture(options);
          }
          await writeEntitlement({ orgId: STAFF_ORG_ID });
        `,
        errors: [{ messageId: "productionStaffMutation" }],
      },
    ],
  },
);
