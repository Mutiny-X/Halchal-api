import { maskEmail } from "../common/mask";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import nodemailer from "nodemailer";
import { Resend } from "resend";

import { formatDurationLabel } from "../common/parse-duration";
import type { Env } from "../config/env";

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private resendClient: Resend | null = null;

  constructor(private readonly config: ConfigService<Env, true>) {}

  private usesResendApi(): boolean {
    return Boolean(
      this.config.get("RESEND_API_KEY") && this.config.get("EMAIL_FROM"),
    );
  }

  private usesSmtp(): boolean {
    return Boolean(
      this.config.get("SMTP_HOST") &&
        this.config.get("SMTP_USER") &&
        this.config.get("SMTP_PASS") &&
        this.config.get("EMAIL_FROM"),
    );
  }

  isConfigured(): boolean {
    return this.usesResendApi() || this.usesSmtp();
  }

  private webBaseUrl(): string {
    const webUrl = this.config.get("WEB_URL", { infer: true });
    const legacyBrand = this.config.get("BRAND_WEB_URL", { infer: true });
    const base = webUrl ?? legacyBrand ?? "http://localhost:3000";
    return base.replace(/\/$/, "");
  }

  async sendPasswordReset(email: string, resetToken: string): Promise<void> {
    const baseUrl = this.webBaseUrl();
    const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(resetToken)}`;
    const ttlLabel = formatDurationLabel(
      this.config.get("PASSWORD_RESET_TTL", { infer: true }),
    );
    const subject = "Reset your Halchal password";
    const text = `Use this link to reset your password (valid ${ttlLabel}): ${resetUrl}`;

    await this.sendMail(email, subject, text, `password reset for ${email}\n  Link: ${resetUrl}`);
  }

  async sendCampaignInvite(
    email: string,
    inviteToken: string,
    campaignTitle: string,
  ): Promise<void> {
    const baseUrl = this.webBaseUrl();
    const inviteUrl = `${baseUrl}/invite/campaign?token=${encodeURIComponent(inviteToken)}`;
    const ttlLabel = formatDurationLabel(
      this.config.get("BRAND_INVITE_TTL", { infer: true }),
    );
    const subject = `You're invited to collaborate on "${campaignTitle}"`;
    const text = `You've been invited to collaborate on the Halchal campaign "${campaignTitle}".\n\nAccept the invite (valid ${ttlLabel}): ${inviteUrl}`;

    await this.sendMail(
      email,
      subject,
      text,
      `campaign invite for ${email}\n  Campaign: ${campaignTitle}\n  Link: ${inviteUrl}`,
    );
  }

  /** Welcome for a new team member or admin. Carries a one-time link to
   * choose their password — the password itself is never emailed. */
  async sendStaffWelcome(email: string, name: string, setupToken: string): Promise<void> {
    const staffUrl = this.config.get("STAFF_WEB_URL", { infer: true });
    const baseUrl = staffUrl ? staffUrl.replace(/\/$/, "") : this.webBaseUrl();
    const setupUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(setupToken)}`;
    const subject = "Welcome to Halchal — set up your team account";
    const text = `Hi ${name},\n\nYour Halchal team account has been created for ${email}.\n\nChoose your password here (the link works once and expires in 3 days):\n${setupUrl}\n\nThen sign in at ${baseUrl}/login to manage the brands assigned to you.\n\nTeam Halchal`;
    await this.sendMail(email, subject, text, `staff welcome for ${email}\n  Link: ${setupUrl}`);
  }

  async sendAdminWelcome(email: string, name: string, setupToken: string, roleName: string): Promise<void> {
    const baseUrl = this.webBaseUrl();
    const setupUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(setupToken)}`;
    const subject = "Welcome to Halchal — set up your admin account";
    const text = `Hi ${name},\n\nYour Halchal admin account has been created for ${email} with the "${roleName}" role.\n\nChoose your password here (the link works once and expires in 3 days):\n${setupUrl}\n\nThen sign in at ${baseUrl}/admin/login.\n\nTeam Halchal`;
    await this.sendMail(email, subject, text, `admin welcome for ${email}\n  Link: ${setupUrl}`);
  }

  private getResendClient(): Resend {
    if (!this.resendClient) {
      this.resendClient = new Resend(this.config.get("RESEND_API_KEY"));
    }
    return this.resendClient;
  }

  private async sendMail(
    email: string,
    subject: string,
    text: string,
    devLogLabel: string,
  ): Promise<void> {
    const from = this.config.get("EMAIL_FROM");

    if (!this.isConfigured()) {
      if (this.config.get("NODE_ENV") !== "production") {
        this.logger.warn(`[dev] Email not configured — ${devLogLabel}`);
      } else {
        this.logger.error(
          `Email not configured in production — email not sent to ${email}`,
        );
      }
      return;
    }

    if (this.usesResendApi()) {
      const { error } = await this.getResendClient().emails.send({
        from: from!,
        to: email,
        subject,
        text,
      });

      if (error) {
        throw new Error(error.message);
      }

      this.logger.log(`Email sent via Resend to ${maskEmail(email)}: ${subject}`);
      return;
    }

    const transport = nodemailer.createTransport({
      host: this.config.get("SMTP_HOST"),
      port: this.config.get("SMTP_PORT"),
      secure: this.config.get("SMTP_PORT") === 465,
      auth: {
        user: this.config.get("SMTP_USER"),
        pass: this.config.get("SMTP_PASS"),
      },
    });

    await transport.sendMail({ from, to: email, subject, text });
    this.logger.log(`Email sent via SMTP to ${maskEmail(email)}: ${subject}`);
  }
}
