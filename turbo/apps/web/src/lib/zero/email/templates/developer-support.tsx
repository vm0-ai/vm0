import {
  Html,
  Head,
  Body,
  Container,
  Text,
  Link,
  Hr,
} from "@react-email/components";

interface DeveloperSupportEmailProps {
  title: string;
  description: string;
  reference: string;
  userId: string;
  userEmail: string;
  orgId: string;
  orgName: string;
  runId: string;
  downloadUrl: string;
  expiresAt: string;
}

export function DeveloperSupportEmail({
  title,
  description,
  reference,
  userId,
  userEmail,
  orgId,
  orgName,
  runId,
  downloadUrl,
  expiresAt,
}: DeveloperSupportEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Text style={headingStyle}>[Developer Support] {title}</Text>
          <Text style={textStyle}>Reference: {reference}</Text>
          <Hr style={hrStyle} />
          <Text style={labelStyle}>Description</Text>
          <Text style={textStyle}>{description}</Text>
          <Hr style={hrStyle} />
          <Text style={labelStyle}>Context</Text>
          <Text style={metaStyle}>
            User: {userEmail} ({userId})
          </Text>
          <Text style={metaStyle}>
            Org: {orgName} ({orgId})
          </Text>
          <Text style={metaStyle}>Run ID: {runId}</Text>
          <Hr style={hrStyle} />
          <Text style={textStyle}>
            <Link href={downloadUrl} style={linkStyle}>
              Download diagnostic bundle
            </Link>
          </Text>
          <Text style={footerStyle}>
            This download link expires on {expiresAt}.
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
  color: "#111827",
  margin: "0 0 12px",
};

const textStyle = {
  fontSize: "14px",
  color: "#374151",
  lineHeight: "1.6",
  margin: "0 0 12px",
};

const labelStyle = {
  fontSize: "13px",
  fontWeight: "600" as const,
  color: "#6b7280",
  margin: "0 0 4px",
  textTransform: "uppercase" as const,
  letterSpacing: "0.05em",
};

const metaStyle = {
  fontSize: "13px",
  color: "#374151",
  lineHeight: "1.6",
  margin: "0 0 2px",
  fontFamily: "monospace",
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
