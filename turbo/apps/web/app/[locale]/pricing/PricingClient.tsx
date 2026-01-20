"use client";

import { useTranslations } from "next-intl";
import Navbar from "../../components/Navbar";
import Footer from "../../components/Footer";
import Link from "next/link";

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

          {/* Pricing Cards Section */}
          <section
            style={{
              padding: "40px 20px 80px",
              display: "flex",
              justifyContent: "center",
              gap: "32px",
              flexWrap: "wrap",
            }}
          >
            {/* Basic Plan Card */}
            <div
              style={{
                background: "var(--card-bg)",
                border: "1px solid var(--border-light)",
                borderRadius: "16px",
                padding: "40px 32px",
                boxShadow: "0 4px 24px rgba(237, 78, 1, 0.08)",
                transition: "all 0.3s ease",
                maxWidth: "380px",
                width: "100%",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <h3
                style={{
                  fontSize: "18px",
                  fontWeight: 600,
                  fontFamily: '"Fira Mono", monospace',
                  color: "var(--primary)",
                  marginBottom: "16px",
                  letterSpacing: "0.5px",
                  textTransform: "uppercase",
                }}
              >
                Basic
              </h3>
              <div
                style={{
                  fontSize: "42px",
                  fontWeight: 300,
                  color: "var(--text-primary)",
                  letterSpacing: "-1.5px",
                  lineHeight: 1,
                  marginBottom: "8px",
                }}
              >
                $0
                <span
                  style={{
                    fontSize: "15px",
                    fontWeight: 300,
                    color: "var(--text-muted)",
                    letterSpacing: "0.2px",
                    marginLeft: "8px",
                  }}
                >
                  /month
                </span>
              </div>
              <p
                style={{
                  fontSize: "15px",
                  fontWeight: 300,
                  color: "var(--text-secondary)",
                  lineHeight: 1.6,
                  marginBottom: "28px",
                  letterSpacing: "0.1px",
                }}
              >
                Perfect for trying out VM0 and small projects.
              </p>
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: "0 0 32px 0",
                  fontSize: "14px",
                  fontWeight: 300,
                  color: "var(--text-secondary)",
                }}
              >
                <li
                  style={{
                    marginBottom: "12px",
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    letterSpacing: "0.1px",
                  }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--primary)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>100 agent runs/month</span>
                </li>
                <li
                  style={{
                    marginBottom: "12px",
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    letterSpacing: "0.1px",
                  }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--primary)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>3 total agents</span>
                </li>
                <li
                  style={{
                    marginBottom: "12px",
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    letterSpacing: "0.1px",
                  }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--primary)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>500 MB artifact storage</span>
                </li>
                <li
                  style={{
                    marginBottom: "12px",
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    letterSpacing: "0.1px",
                  }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--primary)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>Community support</span>
                </li>
              </ul>
              <Link
                href="/sign-up?plan=basic"
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "center",
                  padding: "8px 16px",
                  fontSize: "15px",
                  fontWeight: 500,
                  marginTop: "auto",
                  borderRadius: "8px",
                  transition: "all 0.2s ease",
                  textDecoration: "none",
                }}
                className="btn-secondary-large"
              >
                Get started
              </Link>
            </div>

            {/* Master Plan Card */}
            <div
              style={{
                background: "var(--card-bg)",
                border: "1px solid var(--border-light)",
                borderRadius: "16px",
                padding: "40px 32px",
                boxShadow: "0 4px 24px rgba(237, 78, 1, 0.08)",
                transition: "all 0.3s ease",
                maxWidth: "380px",
                width: "100%",
                display: "flex",
                flexDirection: "column",
              }}
            >
              <h3
                style={{
                  fontSize: "18px",
                  fontWeight: 600,
                  fontFamily: '"Fira Mono", monospace',
                  color: "var(--primary)",
                  marginBottom: "16px",
                  letterSpacing: "0.5px",
                  textTransform: "uppercase",
                }}
              >
                Master
              </h3>
              <div
                style={{
                  fontSize: "42px",
                  fontWeight: 300,
                  color: "var(--text-primary)",
                  letterSpacing: "-1.5px",
                  lineHeight: 1,
                  marginBottom: "8px",
                }}
              >
                $39
                <span
                  style={{
                    fontSize: "15px",
                    fontWeight: 300,
                    color: "var(--text-muted)",
                    letterSpacing: "0.2px",
                    marginLeft: "8px",
                  }}
                >
                  /month
                </span>
              </div>
              <p
                style={{
                  fontSize: "15px",
                  fontWeight: 300,
                  color: "var(--text-secondary)",
                  lineHeight: 1.6,
                  marginBottom: "28px",
                  letterSpacing: "0.1px",
                }}
              >
                For professionals and growing teams.
              </p>
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: "0 0 32px 0",
                  fontSize: "14px",
                  fontWeight: 300,
                  color: "var(--text-secondary)",
                }}
              >
                <li
                  style={{
                    marginBottom: "12px",
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    letterSpacing: "0.1px",
                  }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--primary)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>5000 agent runs/month</span>
                </li>
                <li
                  style={{
                    marginBottom: "12px",
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    letterSpacing: "0.1px",
                  }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--primary)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>50 total agents</span>
                </li>
                <li
                  style={{
                    marginBottom: "12px",
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    letterSpacing: "0.1px",
                  }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--primary)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>20 GB artifact storage</span>
                </li>
                <li
                  style={{
                    marginBottom: "12px",
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    letterSpacing: "0.1px",
                  }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="var(--primary)"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span>Priority email support</span>
                </li>
              </ul>
              <Link
                href="/sign-up?plan=master"
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "center",
                  padding: "8px 16px",
                  fontSize: "15px",
                  fontWeight: 500,
                  marginTop: "auto",
                  borderRadius: "8px",
                  transition: "all 0.2s ease",
                  textDecoration: "none",
                }}
                className="btn-primary-large"
              >
                Start free trial
              </Link>
            </div>
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}
