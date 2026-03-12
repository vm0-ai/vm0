import {
  Html,
  Head,
  Body,
  Container,
  Text,
  Link,
  Hr,
} from "@react-email/components";

interface DataExportReadyEmailProps {
  downloadUrl: string;
  expiresAt: string;
  artifactCount: number;
}

export function DataExportReadyEmail({
  downloadUrl,
  expiresAt,
  artifactCount,
}: DataExportReadyEmailProps) {
  return (
    <Html>
      <Head />
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Text style={headingStyle}>Your data export is ready</Text>
          <Text style={textStyle}>
            Your requested data export has been generated and is ready for
            download.
          </Text>
          <Text style={textStyle}>
            <Link href={downloadUrl} style={linkStyle}>
              Download your export
            </Link>
          </Text>
          {artifactCount > 0 && (
            <Text style={textStyle}>
              Your export also includes {artifactCount} artifact
              {artifactCount === 1 ? "" : "s"} with separate download links in
              the artifacts-manifest.json file inside the ZIP.
            </Text>
          )}
          <Hr style={hrStyle} />
          <Text style={footerStyle}>
            This download link expires on {expiresAt}. If you need a new export
            after it expires, you can request one again.
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
