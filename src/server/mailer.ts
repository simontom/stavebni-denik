/**
 * Tiny SMTP helper used by the audit-verify cron to alert the BOSS when
 * the hash chain is broken. Configuration is read from the environment;
 * when it is incomplete the caller treats e-mail as "not configured" and
 * simply logs instead (so local/dev runs never fail on a missing SMTP).
 *
 * `nodemailer` is imported lazily so that importing this module has no
 * cost unless an alert actually needs to be sent.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
}

export interface MailMessage {
  subject: string;
  text: string;
}

/**
 * Build an `SmtpConfig` from environment variables, or return `null`
 * when any required value is missing. Required:
 *   SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM, ALERT_EMAIL
 * Optional:
 *   SMTP_PORT   (default 587)
 *   SMTP_SECURE (default "false"; "true" enables implicit TLS, port 465)
 */
export function readSmtpConfig(
  source: Record<string, string | undefined> = process.env,
): SmtpConfig | null {
  const host = source.SMTP_HOST;
  const user = source.SMTP_USER;
  const pass = source.SMTP_PASS;
  const from = source.SMTP_FROM;
  const to = source.ALERT_EMAIL;

  if (!host || !user || !pass || !from || !to) {
    return null;
  }

  const parsedPort = Number.parseInt(source.SMTP_PORT ?? "587", 10);
  const port = Number.isNaN(parsedPort) ? 587 : parsedPort;
  const secure = (source.SMTP_SECURE ?? "false").toLowerCase() === "true";

  return { host, port, secure, user, pass, from, to };
}

/** Send a plain-text e-mail over SMTP. Throws on transport failure. */
export async function sendMail(
  cfg: SmtpConfig,
  msg: MailMessage,
): Promise<void> {
  const { default: nodemailer } = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  await transporter.sendMail({
    from: cfg.from,
    to: cfg.to,
    subject: msg.subject,
    text: msg.text,
  });
}
