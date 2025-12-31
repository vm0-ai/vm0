"use client";

import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

interface MermaidProps {
  chart: string;
}

export function Mermaid({ chart }: MermaidProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>("");

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: "neutral",
      securityLevel: "loose",
    });

    const render = async (): Promise<void> => {
      if (!containerRef.current) return;

      const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
      const { svg: renderedSvg } = await mermaid.render(id, chart);
      setSvg(renderedSvg);
    };

    render().catch(() => {
      // Mermaid rendering errors are handled silently
    });
  }, [chart]);

  return (
    <div
      ref={containerRef}
      className="my-4 flex justify-center"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
