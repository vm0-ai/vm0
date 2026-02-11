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
      <Preview>Scheduled run for &quot;{agentName}&quot; failed</Preview>
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Text style={headingStyle}>
            Scheduled run for &quot;{agentName}&quot; failed
          </Text>
          <Section style={errorSectionStyle}>
            <Text style={errorStyle}>{errorMessage}</Text>
          </Section>
          <Hr style={hrStyle} />
          <Text style={footerStyle}>
            <Link href={logsUrl} style={linkStyle}>
              View logs
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

const headingStyle = {
  fontSize: "18px",
  fontWeight: "600" as const,
  color: "#dc2626",
  margin: "0 0 16px",
};

const errorSectionStyle = {
  backgroundColor: "#fef2f2",
  borderRadius: "6px",
  padding: "12px 16px",
  borderLeft: "3px solid #dc2626",
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

const footerStyle = {
  fontSize: "13px",
  color: "#6b7280",
  margin: "0",
};

const linkStyle = {
  color: "#2563eb",
  textDecoration: "underline",
};
