// A throwaway RFC 3161 time-stamping authority for the anchor test (scripts/audit/anchor-test.sh). It signs with a test CA
// that the test creates: nothing here is trusted by anything but that test. It is `openssl ts -reply` behind an HTTP POST.
//
//   node fake-tsa.mjs <directory with tsa.conf, tsa.pem, tsa.key and tsa_serial> <file that receives the port>
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [dir, portFile] = process.argv.slice(2);
if (!dir || !portFile) {
  console.error("usage: node fake-tsa.mjs <tsa directory> <port file>");
  process.exit(2);
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const work = mkdtempSync(join(tmpdir(), "fake-tsa-"));
    try {
      if (req.method !== "POST") throw new Error("POST only");
      writeFileSync(join(work, "q.tsq"), Buffer.concat(chunks));
      execFileSync("openssl", ["ts", "-reply", "-config", "tsa.conf", "-section", "tsa_config1", "-queryfile", join(work, "q.tsq"), "-out", join(work, "r.tsr")], {
        cwd: dir,
        stdio: "pipe",
      });
      res.writeHead(200, { "Content-Type": "application/timestamp-reply" });
      res.end(readFileSync(join(work, "r.tsr")));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(String(e));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

server.listen(0, "127.0.0.1", () => writeFileSync(portFile, String(server.address().port)));
