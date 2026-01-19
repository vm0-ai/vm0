import { Metadata } from "next";
import PricingClient from "./PricingClient";

export const metadata: Metadata = {
  title: "Pricing - VM0",
  description:
    "Choose the right plan for your needs. Start free and upgrade as you grow.",
  openGraph: {
    title: "Pricing - VM0",
    description:
      "Choose the right plan for your needs. Start free and upgrade as you grow.",
    type: "website",
  },
};

export default function PricingPage() {
  return <PricingClient />;
}
