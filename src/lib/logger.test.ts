import { describe, expect, it, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { logger } from "./logger";

describe("logger", () => {
  let consoleInfoSpy: MockInstance;
  let consoleWarnSpy: MockInstance;
  let consoleErrorSpy: MockInstance;

  beforeEach(() => {
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("formats info logs correctly without context", () => {
    logger.info("app.started");
    expect(consoleInfoSpy).toHaveBeenCalledWith("[info]  app.started");
  });

  it("formats info logs correctly with context", () => {
    logger.info("app.started", { env: "prod", port: 3000 });
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      '[info]  app.started  env=prod port=3000'
    );
  });

  it("formats warn logs correctly", () => {
    logger.warn("login.rate_limited", { ip: "127.0.0.1", limit: "ip" });
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[warn]  login.rate_limited  ip=127.0.0.1 limit=ip'
    );
  });

  it("formats error logs correctly", () => {
    const err = new Error("Connection failed");
    err.stack = "Error: Connection failed\n    at Object.<anonymous> (/app/index.js:1:1)";
    logger.error("db.error", err, { attempt: 3 });

    const expectedLine1 = '[error] db.error  attempt=3  err="Connection failed"';
    const expectedLine2 = '        Error: Connection failed';
    const expectedLine3 = '        at Object.<anonymous> (/app/index.js:1:1)';
    const expected = expectedLine1 + "\n" + expectedLine2 + "\n" + expectedLine3;

    expect(consoleErrorSpy).toHaveBeenCalledWith(expected);
  });

  it("logs undefined and null values explicitly", () => {
    logger.info("user.updated", { id: 42, name: null, role: undefined });
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      '[info]  user.updated  id=42 name=null role=undefined'
    );
  });

  it("handles complex objects in context", () => {
    logger.info("job.done", { stats: { ok: true, count: 5 } });
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      '[info]  job.done  stats={"ok":true,"count":5}'
    );
  });
  
  it("quotes strings with spaces or equals signs", () => {
    logger.info("message.sent", { to: "user 1", subject: "hello=world" });
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      '[info]  message.sent  to="user 1" subject="hello=world"'
    );
  });
});
