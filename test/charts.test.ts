import { describe, expect, it } from "vitest";
import { barChart, sparkline } from "../src/charts";

describe("sparkline", () => {
  it("renders a placeholder for empty data", () => {
    const svg = sparkline([]);
    expect(svg).toContain("no data yet");
    expect(svg).toContain("<svg");
  });

  it("renders a single point without dividing by zero", () => {
    const svg = sparkline([{ label: "2026-07-20", value: 5 }]);
    expect(svg).toContain("<circle");
    expect(svg).not.toContain("NaN");
  });

  it("draws one point per input and scales to the max value", () => {
    const svg = sparkline([
      { label: "a", value: 1 },
      { label: "b", value: 10 },
      { label: "c", value: 5 },
    ]);
    expect(svg.match(/<circle/g)).toHaveLength(3);
    expect(svg).not.toContain("NaN");
  });

  it("escapes label text used in tooltips", () => {
    const svg = sparkline([{ label: "<script>alert(1)</script>", value: 1 }]);
    expect(svg).not.toContain("<script>alert(1)</script>");
    expect(svg).toContain("&lt;script&gt;");
  });
});

describe("barChart", () => {
  it("renders a placeholder for empty data", () => {
    const svg = barChart([]);
    expect(svg).toContain("no data yet");
  });

  it("renders one row per bar", () => {
    const svg = barChart([
      { label: "/catalog", value: 10 },
      { label: "/health", value: 2 },
    ]);
    expect(svg.match(/<rect/g)).toHaveLength(2);
    expect(svg).not.toContain("NaN");
  });

  it("escapes label text", () => {
    const svg = barChart([{ label: "<b>bold</b>", value: 1 }]);
    expect(svg).not.toContain("<b>bold</b>");
  });
});
