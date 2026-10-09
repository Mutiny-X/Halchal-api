import { registerDecorator, type ValidationOptions } from "class-validator";

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/** The passwords people reach for first. Compared case-insensitively. */
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password12", "password123", "password1234", "passw0rd", "p@ssw0rd", "p@ssword1",
  "1234567890", "12345678910", "0123456789", "0987654321", "9876543210", "1111111111", "0000000000", "1234512345",
  "qwertyuiop", "qwerty1234", "qwerty12345", "1q2w3e4r5t", "1qaz2wsx3edc", "qazwsxedc1", "asdfghjkl1", "zxcvbnm123",
  "iloveyou12", "iloveyou123", "letmein123", "welcome123", "welcome1234", "admin12345", "admin@1234", "admin@12345",
  "changeme123", "changeme123!", "halchal123", "halchal1234", "halchal@123", "halchal@1234", "viralcut123", "viralcut@123",
  "india@1234", "india12345", "abc1234567", "abcd123456", "a1b2c3d4e5", "test123456", "test@12345", "default123",
  "monkey12345", "dragon12345", "football123", "cricket1234", "sachin12345", "superman123", "master12345", "login12345",
]);

/** Why a password isn't acceptable, or null when it is. One rule set for
 * every place a password is chosen (change, reset, first-time setup). */
export function passwordProblem(value: unknown): string | null {
  if (typeof value !== "string") return "Password is required";
  if (value.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (value.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return "Password must include at least one letter and one number";
  if (new Set(value).size < 5) return "Password is too repetitive";
  if (COMMON_PASSWORDS.has(value.toLowerCase())) return "That password is too common — choose something harder to guess";
  return null;
}

/** class-validator decorator for a newly chosen password. */
export function IsAcceptablePassword(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isAcceptablePassword",
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => passwordProblem(value) === null,
        defaultMessage: (args) => passwordProblem(args?.value) ?? "Password is not acceptable",
      },
    });
  };
}
