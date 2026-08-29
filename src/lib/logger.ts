/**
 * Zero-dependency plain-text logger that writes human-readable key=value lines
 * to stdout/stderr.
 *
 * Fly.io's log shipper forwards stdout to the Grafana Logs panel where it is
 * accessible via plain-text search. We prefer this format over JSON because
 * it is readable directly in `fly logs` while debugging in the terminal.
 */

export const logger = {
  info(event: string, ctx?: Record<string, unknown>): void {
    console.info(formatLine("info", event, ctx));
  },
  warn(event: string, ctx?: Record<string, unknown>): void {
    console.warn(formatLine("warn", event, ctx));
  },
  error(event: string, err?: unknown, ctx?: Record<string, unknown>): void {
    console.error(formatLine("error", event, ctx, err));
  },
};

function formatLine(
  level: "info" | "warn" | "error",
  event: string,
  ctx?: Record<string, unknown>,
  err?: unknown,
): string {
  // e.g. `[info]  login.success` (padding ensures levels align nicely)
  const levelPadded = `[${level}]`.padEnd(7, " ");
  let line = `${levelPadded} ${event}`;

  if (ctx) {
    const pairs = Object.entries(ctx).map(([k, v]) => `${k}=${formatValue(v)}`);
    if (pairs.length > 0) {
      line += `  ${pairs.join(" ")}`;
    }
  }

  if (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    line += `  err=${formatValue(errMsg)}`;

    if (err instanceof Error && err.stack) {
      // Indent stack trace continuation lines so it's clearly part of the same event
      const stackLines = err.stack.split("\n");
      line += "\n" + stackLines.map((l) => `        ${l.trim()}`).join("\n");
    }
  }

  return line;
}

function formatValue(v: unknown): string {
  if (v === null) return "null";

  if (typeof v === "object") {
    try {
      // JSON.stringify handles escaping correctly.
      return JSON.stringify(v);
    } catch {
      return '"[object]"';
    }
  }

  const str = String(v);
  if (
    str.includes(" ") ||
    str.includes("=") ||
    str.includes('"') ||
    str.includes("\n")
  ) {
    return JSON.stringify(str);
  }
  return str;
}
