import { CampaignStatus } from "@prisma/client";

/** Not visible to creators or the public: still being written (draft) or
 * waiting for an admin to approve it (pending_review). */
export const UNPUBLISHED_STATUSES: readonly CampaignStatus[] = [
  CampaignStatus.draft,
  CampaignStatus.pending_review,
];

export function isUnpublished(status: CampaignStatus | string): boolean {
  return (UNPUBLISHED_STATUSES as readonly string[]).includes(status);
}
