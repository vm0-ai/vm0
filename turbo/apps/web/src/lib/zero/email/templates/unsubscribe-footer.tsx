import { Text, Link } from "@react-email/components";

interface UnsubscribeFooterProps {
  unsubscribeUrl?: string;
}

export function UnsubscribeFooter({ unsubscribeUrl }: UnsubscribeFooterProps) {
  if (!unsubscribeUrl) return null;
  return (
    <Text style={unsubscribeFooterStyle}>
      <Link href={unsubscribeUrl} style={linkStyle}>
        Unsubscribe
      </Link>
    </Text>
  );
}

const unsubscribeFooterStyle = {
  fontSize: "12px",
  color: "#9ca3af",
  margin: "16px 0 0",
};

const linkStyle = {
  color: "#2563eb",
  textDecoration: "underline",
};
