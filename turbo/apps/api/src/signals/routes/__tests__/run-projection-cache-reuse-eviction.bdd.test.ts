import { expect, test } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { createProjectionObservationFixture } from "./helpers/projection-observations";

const context = testContext();

// This isolated module owns one process-local observation history.
// Independent scenarios use separate modules, without a shared cache reset.
test("observes projection eviction beyond sixteen selections without changing the run selection cache", async () => {
  expect.hasAssertions();
  const createObservedRun = await createProjectionObservationFixture(context);
  await createObservedRun(0, "first_observation");
  for (let scope = 1; scope < 16; scope++) {
    await createObservedRun(scope, "not_in_recent_history");
  }
  // Refresh the oldest entry so eviction must follow recency, not insertion.
  await createObservedRun(0, "reuse_9_16");
  await createObservedRun(16, "not_in_recent_history");
  await createObservedRun(1, "not_in_recent_history");
  await createObservedRun(1, "reuse_1", "hit");
});
