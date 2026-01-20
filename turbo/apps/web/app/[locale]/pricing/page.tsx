"use client";

import { PricingTable } from "@clerk/nextjs";
import Navbar from "../../components/Navbar";
import Footer from "../../components/Footer";
import Particles from "../skills/Particles";

export default function PricingPage() {
  return (
    <>
      <Particles />
      <Navbar />

      {/* Hero Section */}
      <section className="hero-section" style={{ paddingBottom: "40px" }}>
        <div className="container">
          <div>
            <h1 className="hero-title">Simple, transparent pricing</h1>
            <p className="hero-description">
              Choose the plan that fits your needs. Start free, scale as you
              grow.
            </p>
          </div>
        </div>
      </section>

      {/* Pricing Cards */}
      <section className="section-spacing" style={{ paddingTop: 0 }}>
        <div className="container">
          <div
            style={{
              marginBottom: "60px",
            }}
          >
            {/* Clerk Pricing Table for Basic & Master */}
            <div style={{ marginBottom: "40px" }}>
              <PricingTable />
            </div>

            {/* Enterprise Plan - Compact */}
            <div
              style={{
                background: "var(--card-bg)",
                border: "1px solid var(--border-light)",
                borderRadius: "12px",
                padding: "24px 32px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                transition: "all 0.2s ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "var(--border-lighter)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "var(--border-light)";
              }}
            >
              <div>
                <h3
                  style={{
                    fontSize: "18px",
                    fontWeight: 600,
                    fontFamily: '"Fira Mono", monospace',
                    color: "var(--primary)",
                    marginBottom: "2px",
                    letterSpacing: "-0.2px",
                    textTransform: "uppercase",
                  }}
                >
                  Custom plan
                </h3>
                <p
                  style={{
                    fontSize: "15px",
                    fontWeight: 300,
                    color: "var(--text-secondary)",
                    lineHeight: 1.5,
                    margin: 0,
                  }}
                >
                  For large organizations with advanced customization and self-host options
                </p>
              </div>
              <a
                href="https://calendar.app.google/csdygPrHHyNgxpTPA"
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary-large"
                style={{
                  textDecoration: "none",
                  fontSize: "15px",
                  fontWeight: 500,
                  padding: "8px 16px",
                }}
              >
                Contact us
              </a>
            </div>
          </div>

          {/* Feature Comparison Table */}
          <div style={{ marginTop: "60px" }}>
            <h2
              style={{
                fontSize: "42px",
                fontWeight: 400,
                color: "var(--text-primary)",
                marginBottom: "60px",
                textAlign: "center",
                letterSpacing: "-0.5px",
              }}
            >
              Compare plans
            </h2>
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "separate",
                  borderSpacing: 0,
                  fontSize: "15px",
                  fontWeight: 300,
                }}
              >
                <thead>
                  <tr>
                    <th
                      style={{
                        textAlign: "left",
                        padding: "24px 20px",
                        background: "transparent",
                        color: "var(--text-primary)",
                        fontSize: "16px",
                        fontWeight: 600,
                        borderBottom: "1px solid var(--border-light)",
                      }}
                    >
                      Features
                    </th>
                    <th
                      style={{
                        textAlign: "center",
                        padding: "24px 20px",
                        background: "transparent",
                        color: "var(--text-primary)",
                        fontSize: "16px",
                        fontWeight: 600,
                        borderBottom: "1px solid var(--border-light)",
                      }}
                    >
                      Basic
                    </th>
                    <th
                      style={{
                        textAlign: "center",
                        padding: "24px 20px",
                        background: "transparent",
                        color: "var(--text-primary)",
                        fontSize: "16px",
                        fontWeight: 600,
                        borderBottom: "1px solid var(--border-light)",
                      }}
                    >
                      Master
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <TableSection title="Usage & Limits" />
                  <TableRow2
                    feature="Agent runs per month"
                    free="100"
                    pro="5000"
                  />
                  <TableRow2
                    feature="Total agents"
                    free="3"
                    pro="50"
                  />
                  <TableRow2
                    feature="Concurrent runs"
                    free="1"
                    pro="25"
                  />
                  <TableRow2
                    feature="Session length"
                    free="1 hour"
                    pro="24 hours"
                  />

                  <TableSection title="Storage & Data" />
                  <TableRow2
                    feature="Artifact storage"
                    free="500 MB"
                    pro="20 GB"
                  />
                  <TableRow2
                    feature="Volume storage"
                    free="1 GB"
                    pro="5 GB"
                  />
                  <TableRow2
                    feature="Log retention"
                    free="3 days"
                    pro="90 days"
                  />
                  <TableRow2
                    feature="Checkpoint retention"
                    free={false}
                    pro="90 days"
                  />

                  <TableSection title="Automation" />
                  <TableRow2
                    feature="Scheduled agents"
                    free="1"
                    pro="20"
                  />
                  <TableRow2
                    feature="API keys"
                    free="1"
                    pro="10"
                  />
                  <TableRow2
                    feature="API rate limit"
                    free="Standard"
                    pro="Unlimited"
                  />

                  <TableSection title="Features" />
                  <TableRow2
                    feature="Pre-built skills"
                    free={true}
                    pro={true}
                  />
                  <TableRow2
                    feature="Resume from checkpoints"
                    free={false}
                    pro={true}
                  />
                  <TableRow2
                    feature="Bring your own LLM"
                    free={true}
                    pro={true}
                  />

                  <TableSection title="Support" />
                  <TableRow2
                    feature="Community support"
                    free={true}
                    pro={true}
                  />
                  <TableRow2
                    feature="Priority email support"
                    free={false}
                    pro="48h response"
                  />
                </tbody>
              </table>
            </div>
          </div>

          {/* FAQ Section */}
          <div style={{ marginTop: "120px", marginBottom: "80px" }}>
            <h2
              style={{
                fontSize: "42px",
                fontWeight: 400,
                color: "var(--text-primary)",
                marginBottom: "60px",
                textAlign: "center",
                letterSpacing: "-0.5px",
              }}
            >
              Frequently asked questions
            </h2>
            <div
              style={{
                display: "grid",
                gap: "24px",
              }}
            >
              <FAQItem
                question="What happens when I reach my plan limit?"
                answer="When you reach your plan limit, you'll be notified and can upgrade to continue. Your agents won't stop immediately - you'll have time to upgrade or manage your usage."
              />
              <FAQItem
                question="Can I change plans at any time?"
                answer="Yes! You can upgrade or downgrade your plan at any time. Changes take effect immediately, and we'll prorate charges accordingly."
              />
              <FAQItem
                question="What counts as an agent run?"
                answer="An agent run is counted each time you execute vm0 run or vm0 cook. Continuing from a checkpoint or session counts as a new run."
              />
              <FAQItem
                question="How does the free month work for Pro?"
                answer="New Pro subscribers get their first month completely free. No credit card required to start the trial. Cancel anytime before the trial ends."
              />
            </div>
          </div>
        </div>
      </section>

      <Footer />

      {/* eslint-disable-next-line react/no-unknown-property */}
      <style jsx>{`
        .pricing-card {
          position: relative;
        }
        .pricing-card:hover {
          border-color: var(--border-lighter);
          transform: translateY(-2px);
        }
        .pricing-card.featured {
          border-color: var(--border-lighter);
        }
        .pricing-card.featured:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 32px rgba(237, 78, 1, 0.12);
        }
      `}</style>
    </>
  );
}

function PricingFeature({ icon: Icon, children }: { icon: React.ElementType; children: React.ReactNode }) {
  return (
    <li
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        marginBottom: "8px",
      }}
    >
      <Icon size={14} strokeWidth={1.5} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
      <span>{children}</span>
    </li>
  );
}

function TableSection({ title }: { title: string }) {
  return (
    <tr>
      <td
        colSpan={3}
        style={{
          padding: "32px 20px 16px 20px",
          fontSize: "15px",
          fontWeight: 600,
          color: "var(--text-primary)",
          background: "transparent",
          borderTop: "1px solid var(--border-light)",
        }}
      >
        {title}
      </td>
    </tr>
  );
}

function TableRow2({
  feature,
  free,
  pro,
}: {
  feature: string;
  free: string | boolean;
  pro: string | boolean;
}) {
  const renderCell = (value: string | boolean) => {
    if (typeof value === "boolean") {
      return value ? (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--primary)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ margin: "0 auto", display: "block" }}
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <span style={{ color: "var(--text-muted)", fontSize: "14px" }}>
          —
        </span>
      );
    }
    return value;
  };

  return (
    <tr>
      <td
        style={{
          padding: "16px 20px",
          color: "var(--text-secondary)",
          borderBottom: "1px solid var(--border-light)",
        }}
      >
        {feature}
      </td>
      <td
        style={{
          padding: "16px 20px",
          textAlign: "center",
          color: "var(--text-secondary)",
          borderBottom: "1px solid var(--border-light)",
        }}
      >
        {renderCell(free)}
      </td>
      <td
        style={{
          padding: "16px 20px",
          textAlign: "center",
          color: "var(--text-secondary)",
          borderBottom: "1px solid var(--border-light)",
        }}
      >
        {renderCell(pro)}
      </td>
    </tr>
  );
}

function TableRow({
  feature,
  free,
  pro,
  enterprise,
}: {
  feature: string;
  free: string | boolean;
  pro: string | boolean;
  enterprise: string | boolean;
}) {
  const renderCell = (value: string | boolean) => {
    if (typeof value === "boolean") {
      return value ? (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--primary)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ margin: "0 auto", display: "block" }}
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <span style={{ color: "var(--text-muted)", fontSize: "14px" }}>
          —
        </span>
      );
    }
    return value;
  };

  return (
    <tr>
      <td
        style={{
          padding: "16px 20px",
          color: "var(--text-secondary)",
          borderBottom: "1px solid var(--border-light)",
        }}
      >
        {feature}
      </td>
      <td
        style={{
          padding: "16px 20px",
          textAlign: "center",
          color: "var(--text-secondary)",
          borderBottom: "1px solid var(--border-light)",
        }}
      >
        {renderCell(free)}
      </td>
      <td
        style={{
          padding: "16px 20px",
          textAlign: "center",
          color: "var(--text-secondary)",
          borderBottom: "1px solid var(--border-light)",
        }}
      >
        {renderCell(pro)}
      </td>
      <td
        style={{
          padding: "16px 20px",
          textAlign: "center",
          color: "var(--text-secondary)",
          borderBottom: "1px solid var(--border-light)",
        }}
      >
        {renderCell(enterprise)}
      </td>
    </tr>
  );
}

function FAQItem({
  question,
  answer,
}: {
  question: string;
  answer: string;
}) {
  return (
    <div
      style={{
        background: "var(--card-bg)",
        border: "1px solid var(--border-light)",
        borderRadius: "16px",
        padding: "32px",
        transition: "border-color 0.2s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--border-lighter)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border-light)";
      }}
    >
      <h4
        style={{
          fontSize: "18px",
          fontWeight: 400,
          color: "var(--text-primary)",
          marginBottom: "12px",
          letterSpacing: "-0.2px",
        }}
      >
        {question}
      </h4>
      <p
        style={{
          fontSize: "15px",
          fontWeight: 300,
          color: "var(--text-secondary)",
          lineHeight: 1.7,
          margin: 0,
        }}
      >
        {answer}
      </p>
    </div>
  );
}
