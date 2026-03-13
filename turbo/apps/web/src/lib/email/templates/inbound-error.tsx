import {
  Html,
  Head,
  Body,
  Container,
  Text,
  Link,
  Hr,
} from "@react-email/components";

interface InboundErrorEmailProps {
  errorMessage: string;
  unsubscribeUrl?: string;
}

export function InboundErrorEmail({
  errorMessage,
  unsubscribeUrl,
}: InboundErrorEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Text style={errorStyle}>{errorMessage}</Text>
          <Hr style={hrStyle} />
          <Text style={signatureStyle}>VM0</Text>
          {unsubscribeUrl && (
            <Text style={unsubscribeFooterStyle}>
              <Link href={unsubscribeUrl} style={linkStyle}>
                Unsubscribe
              </Link>
            </Text>
          )}
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
  margin: "0",
};

const unsubscribeFooterStyle = {
  fontSize: "12px",
  color: "#9ca3af",
  margin: "16px 0 0",
};

const linkStyle = {
  color: "#2563eb",
  textDecoration: "underline",
};
