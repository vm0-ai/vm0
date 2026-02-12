import {
  Html,
  Head,
  Body,
  Container,
  Text,
  Link,
  Hr,
  Preview,
  Section,
} from "@react-email/components";

interface AgentReplyEmailProps {
  agentName: string;
  output: string;
  logsUrl: string;
}

export function AgentReplyEmail({
  agentName,
  output,
  logsUrl,
}: AgentReplyEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Reply from &quot;{agentName}&quot;</Preview>
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Text style={headingStyle}>Reply from &quot;{agentName}&quot;</Text>
          <Section style={outputSectionStyle}>
            <Text style={outputStyle}>{output}</Text>
          </Section>
          <Hr style={hrStyle} />
          <Text style={footerStyle}>
            <Link href={logsUrl} style={linkStyle}>
              View logs
            </Link>{" "}
            · Reply to continue the conversation
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const bodyStyle = {
  backgroundColor: "#f6f9fc",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
};

const containerStyle = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  padding: "20px 24px",
  maxWidth: "600px",
  borderRadius: "8px",
};

const headingStyle = {
  fontSize: "18px",
  fontWeight: "600" as const,
  color: "#1a1a1a",
  margin: "0 0 16px",
};

const outputSectionStyle = {
  backgroundColor: "#f4f4f5",
  borderRadius: "6px",
  padding: "12px 16px",
};

const outputStyle = {
  fontSize: "14px",
  color: "#374151",
  lineHeight: "1.6",
  whiteSpace: "pre-wrap" as const,
  margin: "0",
};

const hrStyle = {
  borderColor: "#e5e7eb",
  margin: "20px 0",
};

const footerStyle = {
  fontSize: "13px",
  color: "#6b7280",
  margin: "0",
};

const linkStyle = {
  color: "#2563eb",
  textDecoration: "underline",
};
