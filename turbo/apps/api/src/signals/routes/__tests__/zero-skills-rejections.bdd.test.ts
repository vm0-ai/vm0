import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the custom-skill list / get / delete auth,
// empty-org, not-found and admin-only rejections. Skills with content (create,
// update, the multi-file detail, member-allowed reads, duplicate/built-in 409s
// and the invalid-body 400s) need a seeded skill volume or a raw request, so
// they stay in the kept legacy. See `api.bdd.md` (CHAIN-SKILLS-REJECTIONS).
const context = testContext();

const SKILL = "unknown-skill";

describe("custom skill rejections (API-first BDD)", () => {
  it("list rejects unauthenticated / org-less callers and is empty for a fresh org", async () => {
    const api = createBddApi(context);

    await accept(api.skills.list({ headers: {} }), [401]);

    api.actAsNoOrg();
    await accept(api.skills.list({ headers: SESSION_AUTH }), [401]);

    api.actAsAdmin();
    const empty = await accept(
      api.skills.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(empty.body).toStrictEqual([]);
  });

  it("get-by-name rejects unauthenticated / org-less callers and 404s an unknown skill", async () => {
    const api = createBddApi(context);

    await accept(
      api.skillsDetail.get({ params: { name: SKILL }, headers: {} }),
      [401],
    );

    api.actAsNoOrg();
    await accept(
      api.skillsDetail.get({ params: { name: SKILL }, headers: SESSION_AUTH }),
      [401],
    );

    api.actAsAdmin();
    const notFound = await accept(
      api.skillsDetail.get({ params: { name: SKILL }, headers: SESSION_AUTH }),
      [404],
    );
    expect(notFound.body).toStrictEqual({
      error: { message: `Skill not found: ${SKILL}`, code: "NOT_FOUND" },
    });
  });

  it("delete rejects unauthenticated / org-less / non-admin callers", async () => {
    const api = createBddApi(context);

    await accept(
      api.skillsDetail.delete({ params: { name: SKILL }, headers: {} }),
      [401],
    );

    api.actAsNoOrg();
    await accept(
      api.skillsDetail.delete({
        params: { name: SKILL },
        headers: SESSION_AUTH,
      }),
      [401],
    );

    // A non-admin member cannot delete custom skills (checked before lookup).
    api.actAsMember({ userId: "user_skill_member", orgId: "org_skill" });
    const forbidden = await accept(
      api.skillsDetail.delete({
        params: { name: SKILL },
        headers: SESSION_AUTH,
      }),
      [403],
    );
    expect(forbidden.body).toStrictEqual({
      error: {
        message: "Only org admins can delete custom skills",
        code: "FORBIDDEN",
      },
    });
  });
});
