import DesignSystemClient from "./DesignSystemClient";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Design System - VM0",
  description: "Complete design system reference for VM0 platform",
};

export default function DesignSystemPage() {
  return <DesignSystemClient />;
}
