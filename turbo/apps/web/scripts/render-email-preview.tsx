import { render } from "@react-email/components";
import { AgentReplyEmail } from "../src/lib/zero/email/templates/agent-reply";
import { writeFileSync } from "fs";

const sampleOutput = `Hi there,

Thanks for reaching out! Here's what I found:

## Summary

The deployment completed successfully with **zero downtime**. All health checks passed and the new version is now serving traffic.

### Key Metrics

- **Response time**: p50 dropped from 120ms to 45ms
- **Error rate**: 0.02% (within SLA)
- **Memory usage**: stable at ~512MB

### Changes Included

1. Upgraded the database connection pooler to handle more concurrent requests
2. Fixed the timeout issue in the webhook handler
3. Added retry logic for transient network failures

Here's the relevant config change:

\`\`\`yaml
pool:
  max_connections: 200
  idle_timeout: 30s
\`\`\`

> Note: The old pool size of 50 was causing connection exhaustion during peak hours.

You can check the full logs at the dashboard. Let me know if you need anything else or want me to roll back.

Best regards`;

async function main() {
  const html = await render(
    AgentReplyEmail({
      agentName: "Deploy Bot",
      output: sampleOutput,
      logsUrl: "https://example.com/logs/run-123",
      unsubscribeUrl: "https://example.com/unsubscribe",
    }),
  );
  writeFileSync("/tmp/email-preview.html", html);
  console.log("Written to /tmp/email-preview.html");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
