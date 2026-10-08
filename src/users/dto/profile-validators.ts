import { registerDecorator, type ValidationOptions } from "class-validator";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "10.0.2.2"]);

function parseHttps(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url;
  // Local-disk uploads in development are served over plain http.
  if (url.protocol === "http:" && process.env.NODE_ENV !== "production" && LOCAL_HOSTS.has(url.hostname)) return url;
  return null;
}

/** Why a social-links map isn't acceptable, or null. Every value is shown
 * as a clickable link to admins and team members, so each must be a real
 * https address — never "javascript:", "data:" or free text. */
export function socialLinksProblem(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "socialLinks must be an object";
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 12) return "socialLinks has too many entries";
  for (const [key, link] of entries) {
    if (!/^[a-z][a-z0-9_]{0,29}$/i.test(key)) return `socialLinks has an invalid key: ${key.slice(0, 30)}`;
    if (typeof link !== "string") return `socialLinks.${key} must be text`;
    if (link.trim() === "") continue;
    if (link.length > 300) return `socialLinks.${key} is too long`;
    if (!parseHttps(link.trim())) return `socialLinks.${key} must be a full https:// link`;
  }
  return null;
}

/** Why an avatar address isn't acceptable, or null. An avatar is loaded by
 * every admin who opens the profile, so it has to be a file on our own
 * storage — an address anywhere else would tell that server who looked. */
export function avatarUrlProblem(value: unknown): string | null {
  if (typeof value !== "string") return "avatarUrl must be text";
  if (value.trim() === "") return null;
  if (value.length > 500) return "avatarUrl is too long";
  const url = parseHttps(value.trim());
  if (!url) return "avatarUrl must be an https:// link to an uploaded image";
  const storageBase = process.env.S3_PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  if (storageBase && url.protocol === "https:" && !`${url.origin}${url.pathname}`.startsWith(`${storageBase}/`)) {
    return "avatarUrl must be an image uploaded through the app";
  }
  return null;
}

function problemDecorator(name: string, problem: (v: unknown) => string | null) {
  return (options?: ValidationOptions) => (object: object, propertyName: string) => {
    registerDecorator({
      name,
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => problem(value) === null,
        defaultMessage: (args) => problem(args?.value) ?? `${propertyName} is not valid`,
      },
    });
  };
}

export const IsSocialLinks = problemDecorator("isSocialLinks", socialLinksProblem);
export const IsOwnAvatarUrl = problemDecorator("isOwnAvatarUrl", avatarUrlProblem);
