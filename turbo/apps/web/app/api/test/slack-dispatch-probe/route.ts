import { NextResponse } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { isTestEndpointAllowed } from "../../../../src/lib/auth/test-endpoint-guard";
import { handleOrgMention } from "../../../../src/lib/zero/slack-org/handlers/mention";
import { handleOrgDirectMessage } from "../../../../src/lib/zero/slack-org/handlers/direct-message";

interface ProbeBody {
  team_id: string;
  channel_id: string;
  user_id: string;
  message_text: string;
  message_ts: string;
  channel_type?: "channel" | "im";
}

/**
 * POST /api/test/slack-dispatch-probe
 *
 * Runs handleOrgMention / handleOrgDirectMessage synchronously and
 * returns the raw error on failure. The real events route wraps these
 * in `after()` and swallows errors via .catch(), which is fine in
 * production but opaque for e2e debugging. This endpoint is the
 * diagnostic escape hatch BATS reaches for when a webhook post
 * succeeds but no run row appears.
 */
export async function POST(request: Request) {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const body = (await request.json().catch(() => {
    return null;
  })) as ProbeBody | null;

  if (
    !body?.team_id ||
    !body.channel_id ||
    !body.user_id ||
    !body.message_text ||
    !body.message_ts
  ) {
    return NextResponse.json(
      {
        error:
          "team_id, channel_id, user_id, message_text, message_ts required",
      },
      { status: 400 },
    );
  }

  initServices();

  const apiStartTime = Date.now();
  try {
    if (body.channel_type === "im") {
      await handleOrgDirectMessage({
        workspaceId: body.team_id,
        channelId: body.channel_id,
        userId: body.user_id,
        messageText: body.message_text,
        messageTs: body.message_ts,
        apiStartTime,
      });
    } else {
      await handleOrgMention({
        workspaceId: body.team_id,
        channelId: body.channel_id,
        channelType: body.channel_type,
        userId: body.user_id,
        messageText: body.message_text,
        messageTs: body.message_ts,
        apiStartTime,
      });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const e = err as Error & { stack?: string; code?: string };
    return NextResponse.json(
      {
        ok: false,
        error: {
          name: e.name,
          message: e.message,
          code: e.code,
          stack: e.stack?.split("\n").slice(0, 10).join("\n"),
        },
      },
      { status: 200 },
    );
  }
}
