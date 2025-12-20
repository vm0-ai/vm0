"use client";

export default function Particles() {
  const particles = [];
  for (let i = 0; i < 30; i++) {
    const size = i % 3 === 0 ? "large" : i % 3 === 1 ? "medium" : "small";
    particles.push(<div key={i} className={`particle particle-${size}`}></div>);
  }

  return (
    <>
      {/* Grid Background - only hero area with fade */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: "100vh",
          zIndex: 0,
          pointerEvents: "none",
          backgroundImage:
            "linear-gradient(rgba(255, 140, 77, 0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 140, 77, 0.1) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
          opacity: 0.3,
          maskImage:
            "linear-gradient(to bottom, black 0%, black 50%, transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, black 0%, black 50%, transparent 100%)",
        }}
      />
      {/* Particles */}
      <div
        className="particles"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 0,
          pointerEvents: "none",
        }}
      >
        {particles}
      </div>
    </>
  );
}
