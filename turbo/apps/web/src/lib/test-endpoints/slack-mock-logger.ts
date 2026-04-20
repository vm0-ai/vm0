import { initServices } from "../init-services";
import { e2eSlackMockCallLog } from "../../db/schema/e2e-slack-mock-call-log";

/**
 * Record a call to one of the `/api/test/slack-mock/*` endpoints so BATS
 * e2e tests can assert on the side channel after an agent run completes.
 *
 * Best-effort: logging failures must not fail the mock (would break
 * outbound WebClient calls that the real handler depends on). Errors are
 * swallowed silently.
 */
export async function logSlackMockCall(
  method: string,
  request: Request,
): Promise<void> {
  try {
    const ctype = request.headers.get("content-type") ?? "";
    const rawBody = await request.clone().text();
    let bodyJson: unknown = null;
    let teamId: string | null = null;
    let channelId: string | null = null;

    if (ctype.includes("application/json")) {
      try {
        bodyJson = JSON.parse(rawBody);
        const b = bodyJson as Record<string, unknown>;
        if (typeof b.team_id === "string") teamId = b.team_id;
        if (typeof b.channel === "string") channelId = b.channel;
        if (typeof b.channel_id === "string") channelId = b.channel_id;
      } catch {
        // leave bodyJson null
      }
    } else {
      // Slack WebClient posts form-encoded bodies even for methods with
      // nested payloads (blocks are JSON-encoded into a single form
      // field). Materialize the form body as an object too so BATS
      // assertions can read `.bodyJson.text` uniformly.
      const params = new URLSearchParams(rawBody);
      teamId = params.get("team_id");
      channelId = params.get("channel_id") ?? params.get("channel");
      const parsed: Record<string, unknown> = {};
      params.forEach((value, key) => {
        parsed[key] = value;
      });
      bodyJson = parsed;
    }

    initServices();
    await globalThis.services.db.insert(e2eSlackMockCallLog).values({
      method,
      teamId,
      channelId,
      body: rawBody,
      bodyJson: bodyJson as Record<string, unknown> | null,
    });
  } catch {
    // Never let diagnostic logging break the mock.
  }
}
