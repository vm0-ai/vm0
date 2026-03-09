import {
  Html,
  Head,
  Body,
  Container,
  Text,
  Link,
  Hr,
} from "@react-email/components";

interface ScheduleFailedEmailProps {
  agentName: string;
  errorMessage: string;
  logsUrl: string;
}

export function ScheduleFailedEmail({
  agentName,
  errorMessage,
  logsUrl,
}: ScheduleFailedEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Text style={errorStyle}>{errorMessage}</Text>
          <Hr style={hrStyle} />
          <Text style={signatureStyle}>{agentName} from VM0</Text>
          <Text style={footerStyle}>
            <Link href={logsUrl} style={linkStyle}>
              Audit
            </Link>
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

const errorStyle = {
  fontSize: "14px",
  color: "#991b1b",
  lineHeight: "1.6",
  whiteSpace: "pre-wrap" as const,
  margin: "0",
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
  color: "#2563eb",
  textDecoration: "underline",
};
