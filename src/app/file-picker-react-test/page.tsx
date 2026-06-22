"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Minimal React file-input page used to debug a mobile Chrome
 * issue where file pickers in the main app fire neither
 * `onChange` nor populate `input.files` polled directly. The
 * static `/file-picker-test.html` works on the same device —
 * so something in the React/Next layout chain is to blame.
 *
 * This page renders OUTSIDE the (app) layout group so it skips
 * TopBar, auth-aware server components, hydration metadata, etc.
 * Goal: narrow down which layer breaks file inputs.
 */
export default function FilePickerReactTest() {
  const ref = useRef<HTMLInputElement>(null);
  const [log, setLog] = useState<string[]>(["(waiting…)"]);

  function append(line: string): void {
    const ts = new Date().toISOString().substr(11, 8);
    setLog((prev) => [`${ts} ${line}`, ...prev].slice(0, 50));
  }

  useEffect(() => {
    append(
      "page mounted. UA=" +
        (typeof navigator !== "undefined" ? navigator.userAgent : "?"),
    );
    const interval = setInterval(() => {
      const el = ref.current;
      if (el?.files && el.files.length > 0 && !el.dataset.reported) {
        const f = el.files[0]!;
        append(
          `POLL found file: ${f.name} (${Math.round(f.size / 1024)} KB)`,
        );
        el.dataset.reported = "1";
      }
    }, 500);
    return () => clearInterval(interval);
  }, []);

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const fl = e.target.files;
    if (!fl || fl.length === 0) {
      append("REACT onChange fired with NO files");
      return;
    }
    const f = fl[0]!;
    append(`REACT onChange fired: ${f.name} (${Math.round(f.size / 1024)} KB)`);
  }

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif" }}>
      <h1>File picker React test</h1>
      <p>Tap and pick a photo. Watch the log below.</p>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        onChange={onChange}
        style={{
          display: "block",
          width: "100%",
          padding: 8,
          fontSize: 14,
          margin: "8px 0",
        }}
      />
      <pre
        style={{
          background: "#eee",
          padding: 8,
          fontSize: 12,
          whiteSpace: "pre-wrap",
        }}
      >
        {log.join("\n")}
      </pre>
    </div>
  );
}
