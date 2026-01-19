"use client";

import { PricingTable } from "@clerk/nextjs";
import { useTranslations } from "next-intl";
import Navbar from "../../components/Navbar";
import Footer from "../../components/Footer";

export default function PricingClient() {
  const t = useTranslations("pricing");

  return (
    <>
      <Navbar />
      <main
        style={{
          minHeight: "100vh",
          paddingTop: "80px",
        }}
      >
        <div className="container">
          <section
            style={{
              textAlign: "center",
              padding: "60px 20px",
            }}
          >
            <h1
              style={{
                fontSize: "3rem",
                fontWeight: 700,
                marginBottom: "16px",
                background: "linear-gradient(135deg, #fff 0%, #a0a0a0 100%)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
              }}
            >
              {t("title")}
            </h1>
            <p
              style={{
                fontSize: "1.25rem",
                color: "var(--text-secondary, #888)",
                maxWidth: "600px",
                margin: "0 auto",
              }}
            >
              {t("subtitle")}
            </p>
          </section>
          <section
            style={{
              padding: "40px 20px 80px",
              display: "flex",
              justifyContent: "center",
            }}
          >
            <PricingTable />
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}
