/** Phone number for a log line: country code and last four digits only. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return "(none)";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 6) return "••••";
  return `${phone.startsWith("+") ? "+" : ""}${digits.slice(0, 2)}••••••${digits.slice(-4)}`;
}

/** Email for a log line: first character and the domain only. */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return "(none)";
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}
