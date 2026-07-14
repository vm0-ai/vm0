import { presentationTemplatesContract } from "@vm0/api-contracts/contracts/presentation-templates";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { presentationTemplatesRoutes } from "../presentation-templates";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { updateFeatureSwitchesForUser } from "./helpers/zero-feature-switches";

const context = testContext();

function headers() {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context, routes: presentationTemplatesRoutes })(
    presentationTemplatesContract,
  );
}

async function enableTemplates(actor: ApiTestUser): Promise<void> {
  if (!actor.orgId) {
    throw new Error("Presentation template tests require an organization");
  }
  await updateFeatureSwitchesForUser(context, actor, {
    [FeatureSwitchKey.PresentationCustomTemplates]: true,
  });
}

describe("presentation templates", () => {
  it("keeps new templates private, then shares, archives, and deletes them", async () => {
    const bdd = createBddApi(context);
    const owner = bdd.user({ orgRole: "org:admin" });
    if (!owner.orgId) {
      throw new Error("Owner organization is required");
    }
    const peer = bdd.user({ orgId: owner.orgId, orgRole: "org:member" });
    await enableTemplates(owner);

    const created = await accept(
      client().create({
        headers: headers(),
        body: { name: "Company sales", description: "Brand system" },
      }),
      [201],
    );
    expect(created.body).toMatchObject({
      name: "Company sales",
      accessScope: "private",
      activeRevision: null,
      canManage: true,
    });

    const shared = await accept(
      client().update({
        headers: headers(),
        params: { id: created.body.id },
        body: { accessScope: "organization", name: "Company sales 2026" },
      }),
      [200],
    );
    expect(shared.body.accessScope).toBe("organization");

    await enableTemplates(peer);
    const peerList = await accept(
      client().list({ headers: headers(), query: {} }),
      [200],
    );
    expect(peerList.body.templates).toHaveLength(1);
    expect(peerList.body.templates[0]).toMatchObject({
      id: created.body.id,
      canManage: false,
    });

    await enableTemplates(owner);
    await accept(
      client().archive({
        headers: headers(),
        params: { id: created.body.id },
        body: { archived: true },
      }),
      [200],
    );
    const activeList = await accept(
      client().list({ headers: headers(), query: {} }),
      [200],
    );
    expect(activeList.body.templates).toHaveLength(0);
    const archivedList = await accept(
      client().list({
        headers: headers(),
        query: { includeArchived: true },
      }),
      [200],
    );
    expect(archivedList.body.templates).toHaveLength(1);

    await accept(
      client().delete({
        headers: headers(),
        params: { id: created.body.id },
      }),
      [204],
    );
    const deletedList = await accept(
      client().list({
        headers: headers(),
        query: { includeArchived: true },
      }),
      [200],
    );
    expect(deletedList.body.templates).toHaveLength(0);
  });

  it("hides the catalog and creation endpoint while the switch is off", async () => {
    const bdd = createBddApi(context);
    const actor = bdd.user();
    await bdd.readMe(actor);

    const listed = await accept(
      client().list({ headers: headers(), query: {} }),
      [200],
    );
    expect(listed.body.templates).toStrictEqual([]);
    await accept(
      client().create({
        headers: headers(),
        body: { name: "Disabled template" },
      }),
      [404],
    );
  });
});
