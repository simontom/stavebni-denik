import { describe, expect, it } from "vitest";

import { readSmtpConfig } from "./mailer";

const full: Record<string, string | undefined> = {
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "alerts@example.com",
  SMTP_PASS: "secret",
  SMTP_FROM: "Stavební deník <alerts@example.com>",
  ALERT_EMAIL: "boss@example.com",
};

describe("readSmtpConfig", () => {
  it("returns null when configuration is empty", () => {
    expect(readSmtpConfig({})).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    const missingPass: Record<string, string | undefined> = { ...full };
    delete missingPass.SMTP_PASS;
    expect(readSmtpConfig(missingPass)).toBeNull();
  });

  it("parses a complete config with sensible defaults", () => {
    const cfg = readSmtpConfig(full);
    expect(cfg).not.toBeNull();
    expect(cfg?.host).toBe("smtp.example.com");
    expect(cfg?.port).toBe(587);
    expect(cfg?.secure).toBe(false);
    expect(cfg?.to).toBe("boss@example.com");
  });

  it("honours SMTP_PORT and SMTP_SECURE overrides", () => {
    const cfg = readSmtpConfig({ ...full, SMTP_PORT: "465", SMTP_SECURE: "true" });
    expect(cfg?.port).toBe(465);
    expect(cfg?.secure).toBe(true);
  });

  it("falls back to port 587 when SMTP_PORT is not a number", () => {
    const cfg = readSmtpConfig({ ...full, SMTP_PORT: "not-a-number" });
    expect(cfg?.port).toBe(587);
  });
});
