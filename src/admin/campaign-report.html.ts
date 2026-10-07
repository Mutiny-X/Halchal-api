/**
 * Pure HTML/SVG builder for the campaign performance report. No I/O here —
 * CampaignReportService gathers the data and hands it to buildCampaignReportHtml,
 * which is then rendered to PDF by a headless browser. Kept pure and
 * dependency-free so it's trivial to unit test without mocking Prisma or
 * Puppeteer.
 *
 * Chart specs follow the project's data-viz conventions: fixed categorical
 * hue order (slot 1 blue / slot 2 orange / slot 3 aqua) for the multi-series
 * line chart, a single sequential hue for the ranked demographic bar charts
 * (magnitude comparison, not identity), 2px lines, hairline recessive
 * gridlines, a legend for >=2 series, selective direct labels. This is a
 * static print document, not an on-screen interactive page, so there is no
 * hover layer — direct labels and the underlying numbers are the accessible
 * twin.
 */

import type { DemographicBucket } from "./campaign-report.util";

export interface CampaignReportCampaign {
  id: string;
  title: string;
  brandCompanyName: string | null;
  platforms: string[];
  category: string | null;
  status: string;
  startDate: Date | null;
  createdAt: Date;
  budgetPaise: number;
  ratePer1kPaise: number;
  maxPayoutPaise: number;
}

export interface CampaignReportTotals {
  views: number;
  reach: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  engagement: number;
}

export interface CampaignReportDailyPoint {
  date: string;
  views: number;
  reach: number;
  engagement: number;
}

export interface CampaignReportDemographics {
  age: DemographicBucket[];
  gender: DemographicBucket[];
  topCities: DemographicBucket[];
  topCountries: DemographicBucket[];
  /** How many of the campaign's participating Instagram creators actually
   * contributed data (had the right scope, had enough followers to qualify,
   * and the API call succeeded) vs. the total — shown as a coverage note so
   * the brand knows how representative this section is. */
  creatorsWithData: number;
  totalCreators: number;
}

export interface CampaignReportData {
  generatedAt: Date;
  generatedByName: string;
  reportId: string;
  campaign: CampaignReportCampaign;
  applicantCount: number;
  totals: CampaignReportTotals;
  firstDay: string | null;
  lastDay: string | null;
  dailySeries: CampaignReportDailyPoint[];
  demographics: CampaignReportDemographics;
}

// Fixed categorical order — see references/palette.md. Only the first three
// slots are used here (<=3 series), which is the range validated all-pairs.
const SLOT_1_BLUE = "#2a78d6";
const SLOT_2_ORANGE = "#eb6834";
const SLOT_3_AQUA = "#1baf7a";

const INK_PRIMARY = "#0b0b0b";
const INK_SECONDARY = "#52514e";
const INK_MUTED = "#898781";
const GRIDLINE = "#e1e0d9";
const AXIS = "#c3c2b7";
const SURFACE = "#fcfcfb";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatCompactNumber(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}${trimDecimal(abs / 1_000_000)}M`;
  if (abs >= 1_000) return `${sign}${trimDecimal(abs / 1_000)}K`;
  return `${sign}${Math.round(abs).toLocaleString("en-IN")}`;
}

function trimDecimal(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return rounded % 1 === 0 ? String(rounded) : rounded.toFixed(1);
}

export function formatPaiseAsInr(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

export function formatDate(d: Date | string | null): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(`${d}T00:00:00Z`) : d;
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

/** Rounds up to a clean axis step (1/2/5 * 10^n), matching the mark spec's
 * "y-axis ticks: round to clean numbers" rule. */
function niceStep(roughStep: number): number {
  if (roughStep <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function buildTicks(maxValue: number, targetCount = 4): number[] {
  if (maxValue <= 0) return [0];
  const step = niceStep(maxValue / targetCount);
  const ticks: number[] = [];
  for (let v = 0; v <= maxValue + step * 0.001; v += step) ticks.push(Math.round(v));
  return ticks;
}

const LOGO_SVG = `<svg viewBox="0 0 460 280" xmlns="http://www.w3.org/2000/svg" width="46" height="28">
  <rect width="460" height="280" fill="#07091A" rx="48" />
  <rect x="10" y="30" width="64" height="220" rx="32" fill="white" />
  <rect x="160" y="30" width="64" height="220" rx="32" fill="white" />
  <rect x="10" y="105" width="214" height="70" rx="20" fill="white" />
  <rect x="244" y="30" width="40" height="220" rx="20" fill="#A855F7" />
  <rect x="298" y="55" width="40" height="170" rx="20" fill="#7C3AED" />
  <rect x="352" y="80" width="40" height="120" rx="20" fill="#6D28D9" />
  <rect x="406" y="105" width="40" height="70" rx="20" fill="#4C1D95" />
</svg>`;

/** Multi-series (<=3) line chart on a single shared y-axis — views, reach,
 * and engagement are all plain counts, so one axis is correct here (never a
 * dual-axis chart). Each line gets a direct end-label; a legend backs it
 * since there are 3 series. */
function renderPerformanceLineChart(points: CampaignReportDailyPoint[]): string {
  const width = 680;
  const height = 260;
  const padding = { top: 16, right: 54, bottom: 28, left: 56 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  if (points.length < 2) {
    return emptyChartPlaceholder(width, height, "Not enough tracked days yet to plot performance over time.");
  }

  const series: { key: "views" | "reach" | "engagement"; label: string; color: string }[] = [
    { key: "views", label: "Views", color: SLOT_1_BLUE },
    { key: "reach", label: "Reach", color: SLOT_2_ORANGE },
    { key: "engagement", label: "Engagement", color: SLOT_3_AQUA },
  ];

  const maxValue = Math.max(1, ...points.flatMap((p) => [p.views, p.reach, p.engagement]));
  const ticks = buildTicks(maxValue);
  const yMax = ticks[ticks.length - 1] || 1;

  const x = (i: number) => padding.left + (points.length === 1 ? 0 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => padding.top + plotH - (v / yMax) * plotH;

  const gridlines = ticks
    .map((t) => {
      const yy = y(t);
      return `<line x1="${padding.left}" y1="${yy}" x2="${width - padding.right}" y2="${yy}" stroke="${GRIDLINE}" stroke-width="1" />
        <text x="${padding.left - 10}" y="${yy + 4}" text-anchor="end" font-size="11" fill="${INK_MUTED}">${formatCompactNumber(t)}</text>`;
    })
    .join("\n");

  const firstLabel = formatDate(points[0].date);
  const lastLabel = formatDate(points[points.length - 1].date);

  const lines = series
    .map((s) => {
      const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join(" ");
      const endX = x(points.length - 1);
      const endY = y(points[points.length - 1][s.key]);
      const endValue = formatCompactNumber(points[points.length - 1][s.key]);
      return `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        <circle cx="${endX.toFixed(1)}" cy="${endY.toFixed(1)}" r="4" fill="${s.color}" stroke="${SURFACE}" stroke-width="2" />
        <text x="${(endX + 8).toFixed(1)}" y="${(endY + 3).toFixed(1)}" font-size="11" font-weight="600" fill="${INK_PRIMARY}">${endValue}</text>`;
    })
    .join("\n");

  const legend = series
    .map(
      (s) =>
        `<span class="legend-item"><span class="legend-swatch" style="background:${s.color}"></span>${escapeHtml(s.label)}</span>`,
    )
    .join("");

  return `<div class="chart-block">
    <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Performance over time">
      <line x1="${padding.left}" y1="${padding.top + plotH}" x2="${width - padding.right}" y2="${padding.top + plotH}" stroke="${AXIS}" stroke-width="1" />
      ${gridlines}
      ${lines}
      <text x="${padding.left}" y="${height - 6}" font-size="11" fill="${INK_MUTED}">${escapeHtml(firstLabel)}</text>
      <text x="${width - padding.right}" y="${height - 6}" text-anchor="end" font-size="11" fill="${INK_MUTED}">${escapeHtml(lastLabel)}</text>
    </svg>
    <div class="legend-row">${legend}</div>
  </div>`;
}

/** Ranked horizontal bar chart — the right form for "compare magnitude"
 * (top cities/countries by follower count) and works equally well for the
 * small, fixed category sets (gender, age bands) this report also uses it
 * for. Single sequential hue throughout the demographics section for visual
 * consistency; direct value/pct labels at each bar's end since there's no
 * hover layer in a static document. */
function renderHorizontalBarChart(buckets: DemographicBucket[], emptyMessage: string): string {
  if (buckets.length === 0) {
    return emptyChartPlaceholder(320, 90, emptyMessage);
  }

  const width = 320;
  const rowHeight = 24;
  const labelWidth = 108;
  const barAreaWidth = 150;
  const height = buckets.length * rowHeight + 8;
  const maxValue = Math.max(...buckets.map((b) => b.value), 1);

  const rows = buckets
    .map((b, i) => {
      const y = i * rowHeight + 4;
      const barW = Math.max((b.value / maxValue) * barAreaWidth, 2);
      const label = b.label.length > 16 ? `${b.label.slice(0, 15)}…` : b.label;
      return `<text x="0" y="${y + 12}" font-size="11" fill="${INK_SECONDARY}">${escapeHtml(label)}</text>
        <rect x="${labelWidth}" y="${y}" width="${barW.toFixed(1)}" height="15" rx="4" fill="${SLOT_1_BLUE}" />
        <text x="${(labelWidth + barW + 8).toFixed(1)}" y="${y + 12}" font-size="10.5" font-weight="600" fill="${INK_PRIMARY}">${Math.round(b.pct)}%</text>`;
    })
    .join("\n");

  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Demographic breakdown">${rows}</svg>`;
}

function renderDemographicsSection(d: CampaignReportDemographics): string {
  if (d.totalCreators === 0) {
    return emptyChartPlaceholder(
      640,
      80,
      "No participating creators yet — demographics appear once clippers join this campaign.",
    );
  }

  return `<div class="demo-coverage">Based on ${d.creatorsWithData} of ${d.totalCreators} participating creators' Instagram audiences — the follower profile of who posted, not a measurement of who viewed this specific content (Instagram does not expose viewer-level demographics to any app).</div>
  <div class="demo-grid">
    <div class="demo-card">
      <h3>Top cities</h3>
      ${renderHorizontalBarChart(d.topCities, "No city data available.")}
    </div>
    <div class="demo-card">
      <h3>Top countries</h3>
      ${renderHorizontalBarChart(d.topCountries, "No country data available.")}
    </div>
    <div class="demo-card">
      <h3>Gender</h3>
      ${renderHorizontalBarChart(d.gender, "No gender data available.")}
    </div>
    <div class="demo-card">
      <h3>Age group</h3>
      ${renderHorizontalBarChart(d.age, "No age data available.")}
    </div>
  </div>`;
}

function emptyChartPlaceholder(width: number, height: number, message: string): string {
  return `<div class="chart-placeholder" style="width:${width}px;height:${height}px;">${escapeHtml(message)}</div>`;
}

function statTile(label: string, value: string): string {
  return `<div class="stat-tile"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(value)}</div></div>`;
}

const TERMS_AND_CONDITIONS = `
  <li>This report reflects performance data as tracked by Halchal's systems at the time of generation and is provided for informational purposes to the brand named above.</li>
  <li>View, reach, and engagement figures are sourced from the connected creators' official platform insights where available; figures may lag real-time platform dashboards and are subject to each platform's own reporting methodology.</li>
  <li>Past campaign performance does not guarantee future results on this or any other campaign.</li>
  <li>This report and the data it contains are confidential to the recipient brand and Halchal, and may not be redistributed without Halchal's written consent.</li>
  <li>Any discrepancy between this report and amounts payable under the campaign agreement is governed by the figures in Halchal's payout records, not this report.</li>
`;

export function buildCampaignReportHtml(data: CampaignReportData): string {
  const c = data.campaign;
  const platformsLabel = c.platforms.length > 0 ? c.platforms.join(", ") : "—";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    color: ${INK_PRIMARY};
    margin: 0;
    padding: 36px 40px;
    background: ${SURFACE};
    font-size: 13px;
  }
  .letterhead {
    display: flex;
    align-items: center;
    gap: 10px;
    border-bottom: 2px solid ${INK_PRIMARY};
    padding-bottom: 14px;
    margin-bottom: 20px;
  }
  .letterhead .brand-name { font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
  .letterhead .report-meta { margin-left: auto; text-align: right; color: ${INK_SECONDARY}; font-size: 11px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 0 0 10px; border-top: 1px solid ${GRIDLINE}; padding-top: 16px; }
  .subtitle { color: ${INK_SECONDARY}; font-size: 12px; margin-bottom: 20px; }
  /* Keep each titled block (and every chart) intact across a page break
     rather than letting Chromium's printer slice through the middle of a
     chart — see report-sample.pdf before this rule existed. */
  .report-section { break-inside: avoid; margin-top: 28px; }
  .report-section:first-of-type { margin-top: 0; }
  .chart-block, .stat-row { break-inside: avoid; }
  .detail-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 24px; margin-bottom: 8px; }
  .detail-item .detail-label { color: ${INK_MUTED}; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.03em; }
  .detail-item .detail-value { font-size: 13px; font-weight: 600; margin-top: 2px; }
  .stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 4px; }
  .stat-tile { border: 1px solid ${GRIDLINE}; border-radius: 8px; padding: 10px 12px; }
  .stat-label { color: ${INK_MUTED}; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.03em; }
  .stat-value { font-size: 19px; font-weight: 700; margin-top: 3px; }
  .chart-block { display: flex; align-items: flex-start; gap: 20px; flex-wrap: wrap; }
  .legend-row { display: flex; gap: 16px; margin-top: 6px; font-size: 11.5px; color: ${INK_SECONDARY}; }
  .legend-item { display: inline-flex; align-items: center; gap: 6px; }
  .legend-swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; }
  .demo-coverage { color: ${INK_SECONDARY}; font-size: 11px; margin-bottom: 14px; }
  .demo-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px 28px; }
  .demo-card { break-inside: avoid; }
  .demo-card h3 { font-size: 12px; margin: 0 0 8px; }
  .chart-placeholder {
    display: flex; align-items: center; justify-content: center;
    border: 1px dashed ${GRIDLINE}; border-radius: 8px; color: ${INK_MUTED}; font-size: 12px; text-align: center; padding: 20px;
  }
  ul.terms { margin: 0; padding-left: 18px; color: ${INK_SECONDARY}; font-size: 11px; line-height: 1.6; }
  .signoff {
    margin-top: 32px; padding-top: 16px; border-top: 1px solid ${INK_PRIMARY};
    display: flex; justify-content: space-between; align-items: flex-end; font-size: 11px; color: ${INK_SECONDARY};
  }
  .signoff .sig-label { text-transform: uppercase; letter-spacing: 0.04em; font-size: 10px; color: ${INK_MUTED}; margin-bottom: 4px; }
  .signoff .sig-value { font-size: 13px; font-weight: 600; color: ${INK_PRIMARY}; }
  .report-id { color: ${INK_MUTED}; font-size: 10px; margin-top: 2px; }
</style>
</head>
<body>
  <div class="letterhead">
    ${LOGO_SVG}
    <span class="brand-name">Halchal</span>
    <div class="report-meta">
      Campaign Performance Report<br />
      Generated ${escapeHtml(formatDate(data.generatedAt))}
    </div>
  </div>

  <h1>${escapeHtml(c.title)}</h1>
  <div class="subtitle">${escapeHtml(c.brandCompanyName ?? "—")} &middot; ${escapeHtml(platformsLabel)} &middot; Status: ${escapeHtml(c.status)}</div>

  <section class="report-section">
    <h2>Campaign details</h2>
    <div class="detail-grid">
      <div class="detail-item"><div class="detail-label">Brand</div><div class="detail-value">${escapeHtml(c.brandCompanyName ?? "—")}</div></div>
      <div class="detail-item"><div class="detail-label">Category</div><div class="detail-value">${escapeHtml(c.category ?? "—")}</div></div>
      <div class="detail-item"><div class="detail-label">Platforms</div><div class="detail-value">${escapeHtml(platformsLabel)}</div></div>
      <div class="detail-item"><div class="detail-label">Start date</div><div class="detail-value">${escapeHtml(formatDate(c.startDate))}</div></div>
      <div class="detail-item"><div class="detail-label">Created</div><div class="detail-value">${escapeHtml(formatDate(c.createdAt))}</div></div>
      <div class="detail-item"><div class="detail-label">Status</div><div class="detail-value">${escapeHtml(c.status)}</div></div>
      <div class="detail-item"><div class="detail-label">Budget</div><div class="detail-value">${escapeHtml(formatPaiseAsInr(c.budgetPaise))}</div></div>
      <div class="detail-item"><div class="detail-label">Rate / 1K views</div><div class="detail-value">${escapeHtml(formatPaiseAsInr(c.ratePer1kPaise))}</div></div>
      <div class="detail-item"><div class="detail-label">Max payout / clipper</div><div class="detail-value">${escapeHtml(formatPaiseAsInr(c.maxPayoutPaise))}</div></div>
    </div>
  </section>

  <section class="report-section">
    <h2>Overall performance</h2>
    <div class="stat-row">
      ${statTile("Applicants", String(data.applicantCount))}
      ${statTile("Total views", formatCompactNumber(data.totals.views))}
      ${statTile("Total reach", formatCompactNumber(data.totals.reach))}
      ${statTile("Engagement", formatCompactNumber(data.totals.engagement))}
    </div>
    <div class="stat-row">
      ${statTile("Likes", formatCompactNumber(data.totals.likes))}
      ${statTile("Comments", formatCompactNumber(data.totals.comments))}
      ${statTile("Shares", formatCompactNumber(data.totals.shares))}
      ${statTile("Saves", formatCompactNumber(data.totals.saves))}
    </div>
  </section>

  <section class="report-section">
    <h2>Performance over time</h2>
    <div class="subtitle">${escapeHtml(formatDate(data.firstDay))} – ${escapeHtml(formatDate(data.lastDay))}</div>
    ${renderPerformanceLineChart(data.dailySeries)}
  </section>

  <section class="report-section">
    <h2>Audience demographics</h2>
    ${renderDemographicsSection(data.demographics)}
  </section>

  <section class="report-section">
    <h2>Terms &amp; conditions</h2>
    <ul class="terms">${TERMS_AND_CONDITIONS}</ul>
  </section>

  <div class="signoff">
    <div>
      <div class="sig-label">Digitally authorized</div>
      <div class="sig-value">${escapeHtml(data.generatedByName)} &middot; Halchal</div>
      <div class="report-id">Generated ${escapeHtml(data.generatedAt.toISOString())} &middot; Report ID ${escapeHtml(data.reportId)}</div>
    </div>
  </div>
</body>
</html>`;
}
