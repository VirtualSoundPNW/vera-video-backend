/**
 * Dependency-free SVG chart helpers for the status page. No client JS, no
 * canvas, no charting library — each function takes plain data and returns
 * a self-contained <svg> string that renders the same in any browser.
 */

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

export interface Point {
  label: string;
  value: number;
}

const WIDTH = 640;
const HEIGHT = 160;
const PAD = 24;

/** Line chart for a time series (videos/day, quota/day, traffic/day). */
export function sparkline(points: Point[]): string {
  if (points.length === 0) {
    return `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><text x="${WIDTH / 2}" y="${HEIGHT / 2}" text-anchor="middle" fill="#888">no data yet</text></svg>`;
  }

  const max = Math.max(...points.map((p) => p.value), 1);
  const innerW = WIDTH - PAD * 2;
  const innerH = HEIGHT - PAD * 2;
  const step = points.length > 1 ? innerW / (points.length - 1) : 0;

  const coords = points.map((p, i) => {
    const x = PAD + i * step;
    const y = PAD + innerH - (p.value / max) * innerH;
    return { x, y, p };
  });

  const path = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const dots = coords
    .map(
      (c) =>
        `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="2.5" fill="currentColor"><title>${escapeXml(c.p.label)}: ${c.p.value}</title></circle>`
    )
    .join("");

  return `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img">
  <path d="${path}" fill="none" stroke="currentColor" stroke-width="2" />
  ${dots}
</svg>`;
}

/** Horizontal bar chart for per-category totals (endpoint usage, video status). */
export function barChart(bars: Point[]): string {
  const rowH = 28;
  const height = Math.max(bars.length * rowH + PAD, 60);
  if (bars.length === 0) {
    return `<svg width="${WIDTH}" height="60" viewBox="0 0 ${WIDTH} 60"><text x="${WIDTH / 2}" y="30" text-anchor="middle" fill="#888">no data yet</text></svg>`;
  }

  const max = Math.max(...bars.map((b) => b.value), 1);
  const labelW = 140;
  const barMaxW = WIDTH - labelW - PAD * 2;

  const rows = bars
    .map((b, i) => {
      const y = PAD / 2 + i * rowH;
      const w = (b.value / max) * barMaxW;
      return `<text x="${labelW - 8}" y="${y + rowH / 2 + 4}" text-anchor="end" font-size="12" fill="currentColor">${escapeXml(b.label)}</text>
  <rect x="${labelW}" y="${y + 4}" width="${w.toFixed(1)}" height="${rowH - 8}" fill="currentColor" opacity="0.75" />
  <text x="${(labelW + w + 6).toFixed(1)}" y="${y + rowH / 2 + 4}" font-size="12" fill="currentColor">${b.value}</text>`;
    })
    .join("\n  ");

  return `<svg width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img">
  ${rows}
</svg>`;
}
