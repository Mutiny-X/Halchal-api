import type { UserRole } from "@prisma/client";

export interface AuthJwtPayload {
  sub: string;
  role: UserRole;
  email?: string | null;
  phone?: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

/**
 * Brands don't have accounts on the website — the Halchal team (admins and
 * staff) runs every campaign for them. Brand users still exist as the
 * owners of brand profiles, but can't sign up, sign in or use a session.
 */
/** Who issued an access token and who it is for. Verified on every request so a
 * token minted by some other service that happens to share the secret (or for
 * a different audience) is refused. */
export const JWT_ISSUER = "halchal-api";
export const JWT_AUDIENCE = "halchal-app";

export const BRAND_ACCESS_CLOSED = {
  code: "BRAND_ACCESS_CLOSED",
  message: "Brand accounts can't sign in. The Halchal team manages your campaigns — contact us for anything you need.",
} as const;

/** Brand campaign invites (which created a brand login) are switched off. */
export const BRAND_INVITES_OPEN: boolean = false;
