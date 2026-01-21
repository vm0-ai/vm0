"use client";

import React from "react";
import Navbar from "../../components/Navbar";
import Footer from "../../components/Footer";
import Particles from "../skills/Particles";

function PricingCard({
  title,
  price,
  period,
  description,
  features,
  buttonText,
  buttonHref,
  buttonClassName,
  badge,
}: {
  title: string;
  price: string;
  period: string;
  description: string;
  features: string[];
  buttonText: string;
  buttonHref: string;
  buttonClassName: string;
  badge?: string;
}) {
  const [isHovered, setIsHovered] = React.useState(false);

  return (
    <div
      style={{
        background: "var(--card-bg)",
        backgroundImage: `
          linear-gradient(rgba(237, 78, 1, 0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(237, 78, 1, 0.03) 1px, transparent 1px)
        `,
        backgroundSize: "40px 40px",
        border: "1px solid var(--border-light)",
        borderRadius: "12px",
        padding: "40px 32px",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        transition: "all 0.3s ease",
        transform: isHovered ? "translateY(-2px)" : "translateY(0)",
        position: "relative",
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {badge && (
        <div
          style={{
            position: "absolute",
            top: "16px",
            right: "16px",
            padding: "4px 12px",
            background:
              "linear-gradient(135deg, #FF8C42 0%, #FFB74D 50%, #FFD54F 100%)",
            borderRadius: "6px",
            fontSize: "11px",
            fontWeight: 700,
            color: "#000000",
            letterSpacing: "0.5px",
            textTransform: "uppercase",
            boxShadow:
              "0 4px 20px rgba(255, 183, 77, 0.6), 0 0 30px rgba(255, 140, 66, 0.4)",
          }}
        >
          {badge}
        </div>
      )}
      <h3
        style={{
          fontSize: "18px",
          fontWeight: 600,
          fontFamily: '"Fira Mono", monospace',
          color: "#ed4e01",
          marginBottom: "16px",
          letterSpacing: "0.5px",
          textTransform: "uppercase",
        }}
      >
        {title}
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
        {price}
        <span
          style={{
            fontSize: "15px",
            fontWeight: 300,
            color: "var(--text-muted)",
            letterSpacing: "0.2px",
            marginLeft: "8px",
          }}
        >
          {period}
        </span>
      </div>
      <p
        style={{
          fontSize: "15px",
          fontWeight: 300,
          color: "var(--text-secondary)",
          lineHeight: 1.6,
          marginBottom: "32px",
          letterSpacing: "0.1px",
        }}
      >
        {description}
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
        {features.map((feature, index) => (
          <li
            key={index}
            style={{
              marginBottom: "12px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              letterSpacing: "0.1px",
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#ed4e01"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ flexShrink: 0 }}
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      <a
        href={buttonHref}
        style={{
          display: "block",
          width: "100%",
          textAlign: "center",
          marginTop: "auto",
          textDecoration: "none",
          fontSize: "15px",
        }}
        className={buttonClassName}
      >
        {buttonText}
      </a>
    </div>
  );
}

function CustomPlanCard() {
  const [isHovered, setIsHovered] = React.useState(false);

  return (
    <div
      style={{
        background: "var(--card-bg)",
        backgroundImage: `
          linear-gradient(rgba(237, 78, 1, 0.03) 1px, transparent 1px),
          linear-gradient(90deg, rgba(237, 78, 1, 0.03) 1px, transparent 1px)
        `,
        backgroundSize: "40px 40px",
        border: "1px solid var(--border-light)",
        borderRadius: "12px",
        padding: "24px 32px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        transition: "all 0.3s ease",
        transform: isHovered ? "translateY(-2px)" : "translateY(0)",
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div>
        <h3
          style={{
            fontSize: "18px",
            fontWeight: 600,
            fontFamily: '"Fira Mono", monospace',
            color: "#ed4e01",
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
          For large organizations with advanced customization and self-host
          options
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
  );
}

export default function PricingPage() {
  return (
    <>
      <Particles />
      <Navbar />

      {/* Hero Section */}
      <section className="hero-section" style={{ paddingBottom: "40px" }}>
        <div className="container">
          <div>
            <h1 className="hero-title">Simple, simple pricing</h1>
            <p className="hero-description">
              We&apos;re in early access, so we keep it straightforward. No
              gotchas, no surprises. Start free and scale when you&apos;re
              ready.
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
            {/* Custom Pricing Cards with Clerk integration */}
            <div
              style={{
                marginBottom: "40px",
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(350px, 1fr))",
                gap: "20px",
                maxWidth: "1200px",
                margin: "0 auto 40px",
              }}
            >
              {/* Basic Plan */}
              <PricingCard
                title="Basic"
                price="$0"
                period="/month"
                description="For exploration and demos. Get started with agent workflows and test capabilities."
                features={[
                  "100 agent runs/month",
                  "3 total agents",
                  "500 MB artifact storage",
                  "Community support",
                ]}
                buttonText="Get started"
                buttonHref="/sign-up?plan=basic"
                buttonClassName="btn-secondary-large"
              />

              {/* Master Plan */}
              <PricingCard
                title="Master"
                price="$45"
                period="/month"
                description="For diverse automation scenarios at scale. Build production workflows with advanced features."
                features={[
                  "5000 agent runs/month",
                  "50 total agents",
                  "20 GB artifact storage",
                  "Priority email support",
                ]}
                buttonText="Start free trial"
                buttonHref="/sign-up?plan=master"
                buttonClassName="btn-primary-large"
                badge="1 Month Free"
              />
            </div>

            {/* Enterprise Plan - Compact */}
            <CustomPlanCard />
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
                    description="Number of times you can execute vm0 run or vm0 cook each month"
                    free="100"
                    pro="5000"
                  />
                  <TableRow2
                    feature="Total agents"
                    description="Maximum number of agents you can create and manage"
                    free="3"
                    pro="50"
                  />
                  <TableRow2
                    feature="Concurrent runs"
                    description="Number of agents that can run simultaneously"
                    free="1"
                    pro="25"
                  />
                  <TableRow2
                    feature="Session length"
                    description="Maximum duration for a single agent execution session"
                    free="1 hour"
                    pro="24 hours"
                  />

                  <TableSection title="Storage & Data" />
                  <TableRow2
                    feature="Artifact storage"
                    description="Storage space for generated files and outputs from agent runs"
                    free="500 MB"
                    pro="20 GB"
                  />
                  <TableRow2
                    feature="Volume storage"
                    description="Persistent storage for agent data and files across runs"
                    free="1 GB"
                    pro="5 GB"
                  />
                  <TableRow2
                    feature="Log retention"
                    description="How long execution logs and history are stored"
                    free="3 days"
                    pro="90 days"
                  />
                  <TableRow2
                    feature="Checkpoint retention"
                    description="Duration to keep saved agent execution checkpoints"
                    free={false}
                    pro="90 days"
                  />

                  <TableSection title="Automation" />
                  <TableRow2
                    feature="Scheduled agents"
                    description="Number of agents that can run on a schedule automatically"
                    free="1"
                    pro="20"
                  />
                  <TableRow2
                    feature="API keys"
                    description="Number of API keys for programmatic access"
                    free="1"
                    pro="10"
                  />
                  <TableRow2
                    feature="API rate limit"
                    description="Maximum number of API requests allowed per time period"
                    free="Standard"
                    pro="Unlimited"
                  />

                  <TableSection title="Features" />
                  <TableRow2
                    feature="Pre-built skills"
                    description="Access to ready-to-use agent capabilities and integrations"
                    free={true}
                    pro={true}
                  />
                  <TableRow2
                    feature="Resume from checkpoints"
                    description="Continue agent execution from a saved state after interruption"
                    free={false}
                    pro={true}
                  />
                  <TableRow2
                    feature="Bring your own LLM"
                    description="Use your own language model API keys and configurations"
                    free={true}
                    pro={true}
                  />

                  <TableSection title="Support" />
                  <TableRow2
                    feature="Community support"
                    description="Access to community forums, Discord, and documentation"
                    free={true}
                    pro={true}
                  />
                  <TableRow2
                    feature="Priority email support"
                    description="Dedicated email support with guaranteed response time"
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
                gap: "12px",
              }}
            >
              <FAQItem
                question="What happens when I reach my plan limit?"
                answer="When you reach your plan limit, you'll be notified and can upgrade to continue. Your agent will stop immediately."
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
                question="How does the free month work for Master?"
                answer="New Master subscribers get their first month completely free. No credit card required to start the trial. Cancel anytime before the trial ends."
              />
              <FAQItem
                question="Where to upgrade?"
                answer="Log in to the Platform, navigate to the Billing section, and you can upgrade your plan from there."
              />
              <FAQItem
                question="Do you offer annual billing or discounts?"
                answer="Contact us to discuss volume pricing, annual billing discounts, and custom arrangements for your team."
              />
              <FAQItem
                question="What happens to my agents if I downgrade?"
                answer="You must manually delete or archive your agents before downgrading. Directly downgrading may affect your existing resources. The downgrade takes effect immediately, ending your current billing cycle and starting a new one."
              />
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </>
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
  description,
  free,
  pro,
}: {
  feature: string;
  description?: string;
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
          stroke="#ed4e01"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ margin: "0 auto", display: "block" }}
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <span style={{ color: "var(--text-muted)", fontSize: "14px" }}>—</span>
      );
    }
    return value;
  };

  return (
    <tr>
      <td
        style={{
          padding: "16px 20px",
          borderBottom: "1px solid var(--border-light)",
        }}
      >
        <div style={{ color: "var(--text-secondary)" }}>{feature}</div>
        {description && (
          <div
            style={{
              fontSize: "13px",
              color: "#827D77",
              marginTop: "4px",
              lineHeight: 1.4,
            }}
          >
            {description}
          </div>
        )}
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

function FAQItem({ question, answer }: { question: string; answer: string }) {
  const [isExpanded, setIsExpanded] = React.useState(false);

  return (
    <div
      style={{
        background: "var(--card-bg)",
        border: "1px solid var(--border-light)",
        borderRadius: "16px",
        padding: "24px 32px",
        transition: "border-color 0.2s ease",
        cursor: "pointer",
      }}
      onClick={() => setIsExpanded(!isExpanded)}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--border-lighter)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border-light)";
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "16px",
        }}
      >
        <h4
          style={{
            fontSize: "18px",
            fontWeight: 400,
            color: "var(--text-primary)",
            margin: 0,
            letterSpacing: "-0.2px",
          }}
        >
          {question}
        </h4>
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--text-secondary)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            flexShrink: 0,
            transition: "transform 0.3s ease",
            transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>
      {isExpanded && (
        <p
          style={{
            fontSize: "15px",
            fontWeight: 300,
            color: "var(--text-secondary)",
            lineHeight: 1.7,
            margin: "16px 0 0 0",
            paddingTop: "16px",
            borderTop: "1px solid var(--border-light)",
          }}
        >
          {answer}
        </p>
      )}
    </div>
  );
}
