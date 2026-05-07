import {
  Html,
  Head,
  Body,
  Container,
  Text,
  Link,
  Hr,
} from "@react-email/components";
import { UnsubscribeFooter } from "./unsubscribe-footer";
import { EmailMarkdown } from "./email-markdown";

interface AgentReplyEmailProps {
  agentName: string;
  output: string;
  logsUrl?: string;
  unsubscribeUrl?: string;
}

export function AgentReplyEmail({
  agentName,
  output,
  logsUrl,
  unsubscribeUrl,
}: AgentReplyEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={bodyStyle}>
        <Container align="left" style={containerStyle}>
          <EmailMarkdown>{output}</EmailMarkdown>
          <Hr style={hrStyle} />
          <Text style={signatureStyle}>{agentName} from VM0</Text>
          <Text style={footerStyle}>
            {logsUrl ? (
              <>
                <Link href={logsUrl} style={linkStyle}>
                  Audit
                </Link>{" "}
                ·{" "}
              </>
            ) : null}
            Reply to continue
          </Text>
          <UnsubscribeFooter unsubscribeUrl={unsubscribeUrl} />
        </Container>
      </Body>
    </Html>
  );
}

const fontFamily = "Arial, Helvetica, sans-serif";

const bodyStyle = {
  backgroundColor: "#ffffff",
  fontFamily,
};

const containerStyle = {
  margin: "0",
  padding: "0 24px",
};

const hrStyle = {
  borderColor: "#e5e7eb",
  margin: "20px 0",
};

const signatureStyle = {
  fontSize: "13px",
  fontWeight: "600" as const,
  color: "#374151",
  margin: "0 0 4px",
};

const footerStyle = {
  fontSize: "13px",
  color: "#6b7280",
  margin: "0",
};

const linkStyle = {
  color: "#1a73e8",
  textDecoration: "underline",
};
