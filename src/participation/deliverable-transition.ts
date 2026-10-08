import { BadRequestException } from "@nestjs/common";
import { FormatDeliverableStatus, Prisma } from "@prisma/client";

type DeliverableClient = {
  formatDeliverable: {
    updateMany(args: Prisma.FormatDeliverableUpdateManyArgs): Promise<{ count: number }>;
    findUniqueOrThrow(args: { where: { id: string } }): Promise<Prisma.FormatDeliverableGetPayload<object>>;
  };
};

/**
 * Moves a deliverable to its next state only if it is still in one of
 * `from`. Checking the status first and then writing unconditionally lets
 * two reviewers (or a reviewer and the creator resubmitting) both pass the
 * check: the last write wins, and the creator gets two contradictory
 * notifications. Here the database decides — exactly one request moves it,
 * the other gets `lostRaceMessage` as a normal validation error.
 */
export async function transitionDeliverable(
  client: DeliverableClient,
  id: string,
  from: FormatDeliverableStatus[],
  data: Prisma.FormatDeliverableUncheckedUpdateManyInput,
  lostRaceMessage: string,
) {
  const { count } = await client.formatDeliverable.updateMany({
    where: { id, status: { in: from } },
    data,
  });
  if (count === 0) {
    throw new BadRequestException({ code: "VALIDATION_ERROR", message: lostRaceMessage });
  }
  return client.formatDeliverable.findUniqueOrThrow({ where: { id } });
}

export const DRAFT_REVIEWABLE: FormatDeliverableStatus[] = [FormatDeliverableStatus.under_review];

/** live_submitted is the legacy name for proof_under_review — both await review. */
export const PROOF_REVIEWABLE: FormatDeliverableStatus[] = [
  FormatDeliverableStatus.proof_under_review,
  FormatDeliverableStatus.live_submitted,
];

export const PROOF_FILLABLE: FormatDeliverableStatus[] = [
  FormatDeliverableStatus.draft_approved,
  FormatDeliverableStatus.proof_rejected,
];

const PLATFORM_HOSTS: Record<string, { name: string; hosts: string[] }> = {
  instagram: { name: "Instagram", hosts: ["instagram.com", "instagr.am"] },
  youtube: { name: "YouTube", hosts: ["youtube.com", "youtu.be"] },
  twitter: { name: "X (Twitter)", hosts: ["twitter.com", "x.com"] },
  tiktok: { name: "TikTok", hosts: ["tiktok.com"] },
};

/**
 * A live link has to be a post on the platform the format is for — an
 * Instagram Reel slot can't be filled with a YouTube or random website link.
 * Returns the error message, or null when the link fits. Formats on a
 * platform not listed here aren't restricted.
 */
export function liveLinkProblem(platform: string, url: string): string | null {
  const family = PLATFORM_HOSTS[platform.split("_")[0]?.toLowerCase() ?? ""];
  if (!family) return null;
  let host: string;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:") {
      return `Submit the https:// link to your live ${family.name} post.`;
    }
    host = parsed.hostname.toLowerCase();
  } catch {
    return `Submit the link to your live ${family.name} post.`;
  }
  const matches = family.hosts.some((h) => host === h || host.endsWith(`.${h}`));
  return matches ? null : `This isn't a ${family.name} link. Submit the link to your live ${family.name} post.`;
}

/** The same post written with or without a trailing slash. */
export function liveLinkVariants(url: string): string[] {
  const trimmed = url.trim();
  // Trailing slashes are stripped by index, not with a regex: /\/+$/ slows
  // down badly on a long run of slashes that isn't at the very end.
  let end = trimmed.length;
  while (end > 0 && trimmed[end - 1] === "/") end -= 1;
  const bare = trimmed.slice(0, end);
  return Array.from(new Set([trimmed, bare, `${bare}/`]));
}
