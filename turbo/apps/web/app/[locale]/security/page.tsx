import { Metadata } from "next";
import SecurityPage from "./SecurityPage";

export const metadata: Metadata = {
  title: "VM0 Security - Built for Trust",
  description:
    "Learn how VM0 keeps your data safe with isolated execution, secret management, full audit trails, and an open-source security model. Backed by Y Combinator.",
  openGraph: {
    title: "VM0 Security - Built for Trust",
    description:
      "Isolated execution, secret management, audit trails, and open-source transparency.",
    type: "website",
  },
};

export default function Page() {
  return <SecurityPage />;
}
