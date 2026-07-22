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

  it("labels the y axis with 0 and the max value", () => {
    const svg = sparkline([
      { label: "2026-07-01", value: 0 },
      { label: "2026-07-02", value: 42 },
    ]);
    expect(svg).toContain(">0<");
    expect(svg).toContain(">42<");
  });

  it("labels the x axis with (shortened) dates, not just tooltips", () => {
    const svg = sparkline([
      { label: "2026-07-01", value: 1 },
      { label: "2026-07-15", value: 2 },
      { label: "2026-07-30", value: 3 },
    ]);
    expect(svg).toContain(">07-01<");
    expect(svg).toContain(">07-30<");
    expect(svg).not.toContain("2026-07-01<");
  });

  it("caps x-axis ticks instead of printing one label per day", () => {
    const points = Array.from({ length: 30 }, (_, i) => ({
      label: `2026-07-${String(i + 1).padStart(2, "0")}`,
      value: i,
    }));
    const svg = sparkline(points);
    const tickCount = (svg.match(/text-anchor="middle" font-size="10"/g) ?? []).length;
    expect(tickCount).toBeLessThanOrEqual(6);
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

  it("draws a value scale across the top, not just per-bar numbers", () => {
    const svg = barChart([
      { label: "/catalog", value: 8 },
      { label: "/health", value: 2 },
    ]);
    expect(svg.match(/<line/g)?.length).toBe(3); // 0%, 50%, 100% gridlines
    expect(svg).toContain(">8<");
  });
});
