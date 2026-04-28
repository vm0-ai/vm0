import {
  Html,
  Head,
  Body,
  Container,
  Markdown,
  Text,
  Link,
  Hr,
} from "@react-email/components";
import { UnsubscribeFooter } from "./unsubscribe-footer";

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
          <Markdown
            markdownContainerStyles={markdownContainerStyle}
            markdownCustomStyles={markdownCustomStyles}
          >
            {output}
          </Markdown>
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

const markdownContainerStyle = {
  fontSize: "14px",
  color: "#222222",
  lineHeight: "1.5",
  fontFamily,
};

const markdownCustomStyles = {
  h1: { fontSize: "18px", fontWeight: "bold" as const, margin: "16px 0 8px" },
  h2: { fontSize: "16px", fontWeight: "bold" as const, margin: "14px 0 6px" },
  h3: { fontSize: "15px", fontWeight: "bold" as const, margin: "12px 0 4px" },
  p: { margin: "0 0 10px", lineHeight: "1.5" },
  link: { color: "#1a73e8" },
  bold: { fontWeight: "bold" as const },
  codeInline: {
    fontFamily: "monospace",
    fontSize: "13px",
    backgroundColor: "#f1f3f4",
    padding: "1px 4px",
    borderRadius: "3px",
  },
  codeBlock: {
    fontFamily: "monospace",
    fontSize: "13px",
    backgroundColor: "#f1f3f4",
    padding: "12px",
    borderRadius: "4px",
    overflowX: "auto" as const,
    lineHeight: "1.4",
  },
  blockQuote: {
    borderLeft: "3px solid #dadce0",
    margin: "8px 0",
    paddingLeft: "12px",
    color: "#5f6368",
  },
  ul: { margin: "0 0 10px", paddingLeft: "24px" },
  ol: { margin: "0 0 10px", paddingLeft: "24px" },
  li: { margin: "2px 0" },
  hr: { borderColor: "#dadce0", margin: "16px 0" },
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
