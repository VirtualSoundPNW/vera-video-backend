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
const HEIGHT = 180;
const PAD = 24;

// Sparklines get asymmetric padding: room on the left for y-axis value
// labels, room at the bottom for x-axis date labels.
const PAD_LEFT = 40;
const PAD_BOTTOM = 24;
const MAX_X_TICKS = 6;

/** "2026-07-21" -> "07-21"; the year rarely changes within one chart's window. */
function shortDate(label: string): string {
  const m = /^\d{4}-(\d{2}-\d{2})$/.exec(label);
  return m ? m[1]! : label;
}

/** Line chart for a time series (videos/day, quota/day, traffic/day). */
export function sparkline(points: Point[]): string {
  if (points.length === 0) {
    return `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><text x="${WIDTH / 2}" y="${HEIGHT / 2}" text-anchor="middle" fill="#888">no data yet</text></svg>`;
  }

  const max = Math.max(...points.map((p) => p.value), 1);
  const innerW = WIDTH - PAD_LEFT - PAD;
  const innerH = HEIGHT - PAD - PAD_BOTTOM;
  const step = points.length > 1 ? innerW / (points.length - 1) : 0;

  const coords = points.map((p, i) => {
    const x = PAD_LEFT + i * step;
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

  // Y axis: gridlines + labels at 0%, 50% and 100% of the max value.
  const yAxis = [0, 0.5, 1]
    .map((frac) => {
      const y = PAD + innerH - frac * innerH;
      return `<line x1="${PAD_LEFT}" y1="${y.toFixed(1)}" x2="${WIDTH - PAD}" y2="${y.toFixed(1)}" stroke="currentColor" stroke-opacity="0.15" />
  <text x="${PAD_LEFT - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="currentColor" opacity="0.7">${Math.round(max * frac)}</text>`;
    })
    .join("\n  ");

  // X axis: a handful of evenly spaced date labels — every point would
  // overlap once there are more than a few days of data.
  const tickCount = Math.min(MAX_X_TICKS, coords.length);
  const tickIndices =
    tickCount <= 1 ? [0] : Array.from({ length: tickCount }, (_, i) => Math.round((i * (coords.length - 1)) / (tickCount - 1)));
  const xAxis = [...new Set(tickIndices)]
    .map((i) => {
      const c = coords[i]!;
      return `<text x="${c.x.toFixed(1)}" y="${HEIGHT - 6}" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">${escapeXml(shortDate(c.p.label))}</text>`;
    })
    .join("\n  ");

  return `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img">
  ${yAxis}
  <path d="${path}" fill="none" stroke="currentColor" stroke-width="2" />
  ${dots}
  ${xAxis}
</svg>`;
}

/** Horizontal bar chart for per-category totals (endpoint usage, video status). */
export function barChart(bars: Point[]): string {
  const rowH = 28;
  const topPad = 20; // room for the value-scale row above the bars
  const height = Math.max(bars.length * rowH + PAD + topPad, 60);
  if (bars.length === 0) {
    return `<svg width="${WIDTH}" height="60" viewBox="0 0 ${WIDTH} 60"><text x="${WIDTH / 2}" y="30" text-anchor="middle" fill="#888">no data yet</text></svg>`;
  }

  const max = Math.max(...bars.map((b) => b.value), 1);
  const labelW = 140;
  const barMaxW = WIDTH - labelW - PAD * 2;

  // Vertical scale: gridlines + labels at 0%, 50% and 100% of the max value,
  // so bar lengths can be compared to a number, not just to each other.
  const scale = [0, 0.5, 1]
    .map((frac) => {
      const x = labelW + frac * barMaxW;
      return `<line x1="${x.toFixed(1)}" y1="${topPad}" x2="${x.toFixed(1)}" y2="${(height - 4).toFixed(1)}" stroke="currentColor" stroke-opacity="0.12" />
  <text x="${x.toFixed(1)}" y="12" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">${Math.round(max * frac)}</text>`;
    })
    .join("\n  ");

  const rows = bars
    .map((b, i) => {
      const y = topPad + i * rowH;
      const w = (b.value / max) * barMaxW;
      return `<text x="${labelW - 8}" y="${y + rowH / 2 + 4}" text-anchor="end" font-size="12" fill="currentColor">${escapeXml(b.label)}</text>
  <rect x="${labelW}" y="${y + 4}" width="${w.toFixed(1)}" height="${rowH - 8}" fill="currentColor" opacity="0.75" />
  <text x="${(labelW + w + 6).toFixed(1)}" y="${y + rowH / 2 + 4}" font-size="12" fill="currentColor">${b.value}</text>`;
    })
    .join("\n  ");

  return `<svg width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img">
  ${scale}
  ${rows}
</svg>`;
}
