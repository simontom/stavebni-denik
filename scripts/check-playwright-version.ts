import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const packageJsonPath = path.join(rootDir, "package.json");
const dockerfilePath = path.join(rootDir, "Dockerfile");

if (!fs.existsSync(packageJsonPath)) {
  console.error("❌ package.json not found!");
  process.exit(1);
}

if (!fs.existsSync(dockerfilePath)) {
  console.error("❌ Dockerfile not found!");
  process.exit(1);
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
const dockerfile = fs.readFileSync(dockerfilePath, "utf-8");

const pkgPlaywright = (
  packageJson.dependencies?.playwright ??
  packageJson.devDependencies?.playwright ??
  ""
).replace(/^[\^~]/, "");

const pkgPlaywrightTest = (packageJson.devDependencies?.["@playwright/test"] ?? "").replace(
  /^[\^~]/,
  "",
);

if (!pkgPlaywright) {
  console.error("❌ 'playwright' dependency not found in package.json!");
  process.exit(1);
}

if (pkgPlaywrightTest && pkgPlaywrightTest !== pkgPlaywright) {
  console.error(
    `❌ In package.json, playwright (${pkgPlaywright}) and @playwright/test (${pkgPlaywrightTest}) versions do not match!`,
  );
  process.exit(1);
}

const dockerMatch = dockerfile.match(
  /playwright@([0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?)\s+install/,
);

if (!dockerMatch) {
  console.error(
    "❌ Could not find Playwright chromium installer pattern in Dockerfile! Expected 'playwright@<version> install'.",
  );
  process.exit(1);
}

const dockerPlaywright = dockerMatch[1];

if (dockerPlaywright !== pkgPlaywright) {
  console.error(
    `❌ Playwright version mismatch detected!\n` +
      `   package.json: ${pkgPlaywright}\n` +
      `   Dockerfile:   ${dockerPlaywright}\n\n` +
      `Playwright requires exact version parity between npm and the Chromium browser binary.\n` +
      `Please update the following line in Dockerfile:\n` +
      `   && npx -y playwright@${pkgPlaywright} install chromium\n`,
  );
  process.exit(1);
}

console.log(`✅ Playwright versions match (${pkgPlaywright}) across package.json and Dockerfile.`);
