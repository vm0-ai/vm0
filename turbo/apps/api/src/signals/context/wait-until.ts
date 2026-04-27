import { waitUntil as vercelWaitUntil } from "@vercel/functions";

import { detach, Mechanism } from "../utils";

export function waitUntil(work: Promise<unknown>): void {
  vercelWaitUntil(work);
  detach(work, Mechanism.WaitUntil);
}
