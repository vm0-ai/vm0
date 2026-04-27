// oxlint-disable-next-line no-restricted-imports -- this file is the wrapper around @vercel/functions waitUntil, confirmed by ethan@vm0.ai
import { waitUntil as vercelWaitUntil } from "@vercel/functions";

import { detach, Mechanism } from "../utils";

export function waitUntil(work: Promise<unknown>): void {
  vercelWaitUntil(work);
  detach(work, Mechanism.WaitUntil);
}
