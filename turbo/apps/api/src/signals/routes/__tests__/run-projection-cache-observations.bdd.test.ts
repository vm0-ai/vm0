import { expect, test } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createProjectionObservationFixture } from "./helpers/projection-observations";

const context = testContext();

// This isolated module owns one process-local observation history.
// Independent scenarios use separate modules, without a shared cache reset.
test("observes normalized warm selection without changing the run selection cache", async () => {
  expect.hasAssertions();
  const createObservedRun = await createProjectionObservationFixture(context);
  await createObservedRun(0, "first_observation");
  await createObservedRun(0, "reuse_1", "hit", true);
});
