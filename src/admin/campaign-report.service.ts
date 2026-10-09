import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import puppeteer from "puppeteer";

import { InstagramOAuthService, type FollowerDemographicsBreakdown } from "../creator-profiles/instagram-oauth.service";
import { PrismaService } from "../prisma/prisma.service";
import { buildCampaignReportHtml, type CampaignReportData } from "./campaign-report.html";
import {
  aggregateAgeBreakdown,
  aggregateDemographicBreakdown,
  buildDailyCumulativeSeries,
} from "./campaign-report.util";

/** Tags a SocialAccountInsightSnapshot row as a follower-demographics
 * capture (vs. whatever other uses that table picks up later) and doubles
 * as the same-day cache key — see getOrFetchFollowerDemographics. */
const DEMOGRAPHICS_SNAPSHOT_SOURCE = "instagram_follower_demographics";

@Injectable()
export class CampaignReportService {
  private readonly logger = new Logger(CampaignReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly instagramOAuth: InstagramOAuthService,
  ) {}

  async generatePdf(campaignId: string, generatedByName: string): Promise<Buffer> {
    const data = await this.buildReportData(campaignId, generatedByName);
    const html = buildCampaignReportHtml(data);
    return this.renderPdf(html);
  }

  /** The per-reel ledger — one row per deliverable under this campaign,
   * every metric already being tracked, plus a totals row. Deliberately a
   * CSV, not embedded in the PDF: a campaign with thousands of clippers
   * would make the PDF hundreds of pages long and slow to generate, and a
   * flat document can't be sorted/filtered the way a spreadsheet can
   * anyway — see the design discussion this came out of. */
  async generateLedgerCsv(campaignId: string, generatedByName: string): Promise<string> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) {
      throw new NotFoundException({ code: "NOT_FOUND", message: "Campaign not found" });
    }

    const [deliverables, snapshots] = await Promise.all([
      this.prisma.formatDeliverable.findMany({
        where: { participation: { campaignId } },
        include: {
          participation: {
            include: {
              creator: { select: { displayName: true, username: true } },
              creatorProfile: { select: { handle: true, platform: true, label: true } },
            },
          },
        },
        orderBy: { liveSubmittedAt: "asc" },
      }),
      this.prisma.deliverableInsightSnapshot.findMany({
        where: { deliverable: { participation: { campaignId } } },
        select: { deliverableId: true, collectedAt: true, saveCount: true },
        orderBy: { collectedAt: "asc" },
      }),
    ]);

    const latestSaves = latestSaveCountByDeliverable(snapshots);

    const header = [
      "SL No",
      "Creator",
      "Platform",
      "Followers at posting",
      "Profile link",
      "Post link",
      "Posted date",
      "Views",
      "Reach",
      "Likes",
      "Comments",
      "Shares",
      "Saves",
      "Total engagement",
      "Engagement %",
    ];

    const totals = { views: 0, reach: 0, likes: 0, comments: 0, shares: 0, saves: 0, engagement: 0 };
    const rows = deliverables.map((d, i) => {
      const profile = d.participation.creatorProfile;
      const creator = d.participation.creator;
      const saves = latestSaves.get(d.id) ?? 0;
      const engagement = d.likeCount + d.commentCount + d.shareCount + saves;
      const engagementPct = d.viewCount > 0 ? (engagement / d.viewCount) * 100 : null;

      totals.views += d.viewCount;
      totals.reach += d.reach;
      totals.likes += d.likeCount;
      totals.comments += d.commentCount;
      totals.shares += d.shareCount;
      totals.saves += saves;
      totals.engagement += engagement;

      return [
        String(i + 1),
        sanitizeCsvText(profile.label ?? creator.displayName ?? creator.username ?? "Creator"),
        d.platform,
        d.followerCountAtPost != null ? String(d.followerCountAtPost) : "",
        hyperlinkFormula(profileUrlFor(profile.platform, profile.handle)),
        hyperlinkFormula(d.livePostUrl ?? ""),
        d.liveSubmittedAt ? d.liveSubmittedAt.toISOString().slice(0, 10) : "",
        String(d.viewCount),
        String(d.reach),
        String(d.likeCount),
        String(d.commentCount),
        String(d.shareCount),
        String(saves),
        String(engagement),
        engagementPct != null ? engagementPct.toFixed(2) : "",
      ];
    });

    const totalRow = [
      "",
      "TOTAL",
      "",
      "",
      "",
      "",
      "",
      String(totals.views),
      String(totals.reach),
      String(totals.likes),
      String(totals.comments),
      String(totals.shares),
      String(totals.saves),
      String(totals.engagement),
      totals.views > 0 ? ((totals.engagement / totals.views) * 100).toFixed(2) : "",
    ];

    // Same provenance/disclaimer pattern as the PDF report (Report ID,
    // generation timestamp, the "our own records govern" clause) — the
    // actual defense against a brand editing this file and later claiming
    // the edited figures are what Halchal issued isn't file protection
    // (trivially removable in Excel, not a real barrier); it's being able
    // to point to this exact Report ID as a record of what was actually
    // generated, and a standing disclaimer that this export is
    // informational, not authoritative. Leading column-A-only rows are
    // valid CSV (ragged row lengths are fine) and read as a simple header
    // block in Excel/Sheets.
    const reportId = randomBytes(6).toString("hex").toUpperCase();
    const metadata: string[][] = [
      ["Halchal — Campaign Ledger"],
      [`Campaign: ${campaign.title}`],
      [`Report ID: ${reportId}`],
      [`Generated: ${new Date().toISOString()} by ${generatedByName}`],
      [
        "This export is provided for informational purposes only. Halchal's own internal records are the authoritative source for campaign performance and payable amounts; in the event of any discrepancy, those records govern, not this file.",
      ],
      [],
    ];

    return [...metadata, header, ...rows, totalRow]
      .map((row) => row.map(csvEscape).join(","))
      .join("\r\n");
  }

  private async buildReportData(
    campaignId: string,
    generatedByName: string,
  ): Promise<CampaignReportData> {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: { brandProfile: { select: { companyName: true } } },
    });
    if (!campaign) {
      throw new NotFoundException({ code: "NOT_FOUND", message: "Campaign not found" });
    }

    const [applicantCount, deliverableTotals, snapshots, demographics] = await Promise.all([
      this.prisma.campaignParticipation.count({ where: { campaignId } }),
      this.prisma.formatDeliverable.aggregate({
        where: { participation: { campaignId } },
        _sum: {
          viewCount: true,
          reach: true,
          likeCount: true,
          commentCount: true,
          shareCount: true,
        },
      }),
      this.prisma.deliverableInsightSnapshot.findMany({
        where: { deliverable: { participation: { campaignId } } },
        select: {
          deliverableId: true,
          collectedAt: true,
          viewCount: true,
          reach: true,
          likeCount: true,
          commentCount: true,
          shareCount: true,
          saveCount: true,
        },
        orderBy: { collectedAt: "asc" },
      }),
      this.buildDemographics(campaignId),
    ]);

    // saveCount only lives on the snapshot history (FormatDeliverable has no
    // save column), so saves — unlike the other four totals — must come from
    // each deliverable's latest tracked snapshot rather than a direct sum.
    const totalSaves = sumLatestSaveCountPerDeliverable(snapshots);
    const dailySeries = buildDailyCumulativeSeries(snapshots);

    const likes = deliverableTotals._sum.likeCount ?? 0;
    const comments = deliverableTotals._sum.commentCount ?? 0;
    const shares = deliverableTotals._sum.shareCount ?? 0;

    return {
      generatedAt: new Date(),
      generatedByName,
      reportId: randomBytes(6).toString("hex").toUpperCase(),
      campaign: {
        id: campaign.id,
        title: campaign.title,
        brandCompanyName: campaign.brandProfile?.companyName ?? null,
        platforms: campaign.platforms.length > 0 ? campaign.platforms : [campaign.platform],
        category: campaign.category,
        status: campaign.status,
        startDate: campaign.startDate,
        createdAt: campaign.createdAt,
        budgetPaise: campaign.budgetPaise,
        ratePer1kPaise: campaign.ratePer1kPaise,
        maxPayoutPaise: campaign.maxPayoutPaise,
      },
      applicantCount,
      totals: {
        views: deliverableTotals._sum.viewCount ?? 0,
        reach: deliverableTotals._sum.reach ?? 0,
        likes,
        comments,
        shares,
        saves: totalSaves,
        engagement: likes + comments + shares + totalSaves,
      },
      firstDay: dailySeries[0]?.date ?? null,
      lastDay: dailySeries[dailySeries.length - 1]?.date ?? null,
      dailySeries: dailySeries.map((p) => ({
        date: p.date,
        views: p.views,
        reach: p.reach,
        engagement: p.engagement,
      })),
      demographics,
    };
  }

  /** Aggregates follower demographics across every creator participating in
   * the campaign — the account-level follower profile of who posted, not
   * viewer data (Instagram has no per-post viewer-demographics API for
   * anyone). A creator missing the right scope, below Instagram's follower
   * threshold for this metric, or whose call simply fails just contributes
   * nothing rather than failing the whole report. */
  private async buildDemographics(campaignId: string) {
    const participations = await this.prisma.campaignParticipation.findMany({
      where: { campaignId },
      select: { creatorProfileId: true },
      distinct: ["creatorProfileId"],
    });
    const totalCreators = participations.length;

    const breakdowns = await Promise.all(
      participations.map((p) => this.getOrFetchFollowerDemographics(p.creatorProfileId)),
    );
    const successful = breakdowns.filter(
      (b): b is FollowerDemographicsBreakdown => b !== null,
    );

    return {
      age: aggregateAgeBreakdown(successful.map((b) => b.age)),
      gender: aggregateDemographicBreakdown(successful.map((b) => b.gender), 8),
      topCities: aggregateDemographicBreakdown(successful.map((b) => b.city), 8),
      topCountries: aggregateDemographicBreakdown(successful.map((b) => b.country), 8),
      creatorsWithData: successful.length,
      totalCreators,
    };
  }

  /** Reuses a same-day snapshot instead of re-calling Instagram — demographics
   * barely move day to day, and without this, generating the same campaign's
   * report twice in one day would redundantly re-fetch every participating
   * creator's demographics, competing with the hourly/daily view-tracking
   * sweeps for the same API rate-limit budget. */
  private async getOrFetchFollowerDemographics(
    creatorProfileId: string,
  ): Promise<FollowerDemographicsBreakdown | null> {
    const connection = await this.prisma.instagramConnection.findUnique({
      where: { creatorProfileId },
      select: { isConnected: true, platformUserId: true, platformHandle: true },
    });
    if (!connection?.isConnected) return null;

    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const cached = await this.prisma.socialAccountInsightSnapshot.findFirst({
      where: { creatorProfileId, source: DEMOGRAPHICS_SNAPSHOT_SOURCE, collectedAt: { gte: startOfDay } },
      orderBy: { collectedAt: "desc" },
    });
    if (cached) {
      return cached.rawMetrics as unknown as FollowerDemographicsBreakdown;
    }

    const fresh = await this.instagramOAuth.getFollowerDemographics(creatorProfileId);
    if (!fresh) return null;

    await this.prisma.socialAccountInsightSnapshot
      .create({
        data: {
          creatorProfileId,
          platform: "instagram",
          platformUserId: connection.platformUserId,
          handle: connection.platformHandle,
          source: DEMOGRAPHICS_SNAPSHOT_SOURCE,
          rawMetrics: fresh as unknown as Prisma.InputJsonValue,
        },
      })
      .catch((err) =>
        this.logger.warn(`Failed to cache follower demographics for ${creatorProfileId}: ${err}`),
      );

    return fresh;
  }

  /** Renders wait their turn: each one starts a headless browser (a few
   * hundred MB), so several at once could run the API out of memory. */
  private renderQueue: Promise<unknown> = Promise.resolve();

  private renderPdf(html: string): Promise<Buffer> {
    const run = this.renderQueue.then(() => this.renderPdfNow(html));
    this.renderQueue = run.catch(() => undefined);
    return run;
  }

  private async renderPdfNow(html: string): Promise<Buffer> {
    // --no-sandbox: Railway/containerized deploys don't have the user
    // namespaces Chromium's sandbox needs; the process itself is already
    // sandboxed at the container level.
    let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        timeout: 30_000,
      });
    } catch (err) {
      // The browser couldn't start (not installed on this server, or missing
      // system libraries). Say so plainly instead of a bare 500 — the CSV
      // ledger doesn't need a browser and still works.
      this.logger.error(`Campaign report: headless browser failed to start: ${err}`);
      throw new ServiceUnavailableException({
        code: "REPORT_UNAVAILABLE",
        message: "The PDF report can't be generated on this server yet. The ledger (CSV) download still works.",
      });
    }
    try {
      const page = await browser.newPage();
      // The report is static HTML with inline SVG and system fonts: it needs
      // no script and no network. Both are switched off, so even if some
      // text ever reached the page unescaped it could neither run nor call
      // out from the server.
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const url = request.url();
        if (url.startsWith("data:") || url === "about:blank") void request.continue();
        else void request.abort();
      });
      await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "0", bottom: "0", left: "0", right: "0" },
        timeout: 60_000,
      });
      return Buffer.from(pdf);
    } finally {
      await browser.close().catch(() => undefined);
    }
  }
}

function sumLatestSaveCountPerDeliverable(
  snapshots: { deliverableId: string; collectedAt: Date; saveCount: number }[],
): number {
  const latest = latestSaveCountByDeliverable(snapshots);
  return Array.from(latest.values()).reduce((sum, v) => sum + v, 0);
}

function latestSaveCountByDeliverable(
  snapshots: { deliverableId: string; collectedAt: Date; saveCount: number }[],
): Map<string, number> {
  const latest = new Map<string, { collectedAt: Date; saveCount: number }>();
  for (const s of snapshots) {
    const existing = latest.get(s.deliverableId);
    if (!existing || s.collectedAt >= existing.collectedAt) {
      latest.set(s.deliverableId, { collectedAt: s.collectedAt, saveCount: s.saveCount });
    }
  }
  return new Map(Array.from(latest.entries()).map(([id, v]) => [id, v.saveCount]));
}

export function profileUrlFor(platform: string, handle: string): string {
  if (platform === "youtube") return `https://www.youtube.com/@${handle}`;
  if (platform === "twitter") return `https://twitter.com/${handle}`;
  return `https://www.instagram.com/${handle}/`;
}

/** Wraps a URL in an Excel/Google Sheets HYPERLINK() formula so the ledger's
 * profile/post links are actually clickable on open — a plain URL string
 * imported from a CSV does NOT get auto-linkified the way one typed
 * directly into a cell does, only a real formula makes that happen.
 *
 * Deliberately defensive: `livePostUrl` is creator-submitted free text
 * (validated upstream as a URL, but never trust that alone for something
 * feeding into a spreadsheet formula). Only ever builds a HYPERLINK() call
 * when the value actually starts with http(s):// — anything else is
 * returned as plain text, never turned into formula syntax at all, which
 * closes off CSV/formula-injection (CWE-1236) regardless of what upstream
 * validation does or doesn't catch. Internal quotes are doubled the same
 * way csvEscape doubles them, so a quote can't break out of the formula's
 * own string-literal arguments. */
export function hyperlinkFormula(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  const escaped = url.replace(/"/g, '""');
  return `=HYPERLINK("${escaped}","${escaped}")`;
}

/** Neutralizes CSV/formula injection (CWE-1236) for a plain-text cell that
 * may carry untrusted, loosely-validated input — the Creator column comes
 * from a creator's own profile label/display name/username, none of which
 * are restricted from starting with a formula-trigger character the way
 * username's regex happens to. If Excel/Sheets/LibreOffice see a leading
 * =, +, -, or @, they try to evaluate the cell as a formula on open;
 * prefixing with a single quote is the standard fix — it forces text
 * interpretation and is itself invisible in the rendered cell.
 *
 * Deliberately NOT applied inside csvEscape() or to hyperlinkFormula()'s
 * output — those `=HYPERLINK(...)` cells are intentional, pre-vetted
 * formulas we built ourselves, not untrusted text that happens to start
 * with `=`, and must be left alone to actually work as links. */
export function sanitizeCsvText(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
