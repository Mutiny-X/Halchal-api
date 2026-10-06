/** Every stored-file URL a campaign holds: cover, sample content, and
 * uploaded ("upload from device") source files. Drive/YouTube links are
 * not files we store, so they're left out. */
export function campaignFileUrls(c: {
  coverImageUrl?: string | null;
  referenceAssets?: unknown;
  sourceAssets?: unknown;
}): string[] {
  const urls = new Set<string>();
  if (c.coverImageUrl?.trim()) urls.add(c.coverImageUrl.trim());
  const add = (raw: unknown, onlyUploads: boolean) => {
    if (!Array.isArray(raw)) return;
    for (const a of raw as Array<{ type?: unknown; url?: unknown } | null>) {
      if (!a || typeof a.url !== "string" || !a.url.trim()) continue;
      if (onlyUploads && a.type !== "upload") continue;
      urls.add(a.url.trim());
    }
  };
  add(c.referenceAssets, false);
  add(c.sourceAssets, true);
  return [...urls];
}
