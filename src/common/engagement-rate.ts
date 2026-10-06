export type PostEngagementInputs = {
  reach: number;
  likeCount: number;
  commentCount: number;
  shareCount: number;
  saveCount: number;
};

/** Engagement rate of one specific post, as a percentage rounded to 2
 * decimals (same scale as the account-level InstagramConnection
 * .engagementRate): (likes + comments + shares + saves) / reach * 100.
 *
 * Returns null — not 0 — when reach is zero or not a positive number: with
 * no reach there's nothing to divide by, and "no rate known" must stay
 * distinguishable from a real 0%. Not capped at 100 — shares and saves can
 * come from accounts the post's reach doesn't count, and clamping would
 * hide that rather than report it. */
export function computePostEngagementRate(inputs: PostEngagementInputs): number | null {
  const { reach, likeCount, commentCount, shareCount, saveCount } = inputs;
  if (!Number.isFinite(reach) || reach <= 0) return null;
  const interactions = likeCount + commentCount + shareCount + saveCount;
  return Math.round((interactions / reach) * 10000) / 100;
}
