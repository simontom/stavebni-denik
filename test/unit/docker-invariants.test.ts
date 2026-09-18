import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Docker and dependency invariants", () => {
  it("enforces Playwright version parity between package.json and Dockerfile", () => {
    const rootDir = path.resolve(__dirname, "../../");
    const packageJsonPath = path.join(rootDir, "package.json");
    const dockerfilePath = path.join(rootDir, "Dockerfile");

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const dockerfile = fs.readFileSync(dockerfilePath, "utf-8");

    const playwrightPkgVersion = (
      packageJson.dependencies?.playwright ??
      packageJson.devDependencies?.playwright ??
      ""
    ).replace(/^[\^~]/, "");

    const playwrightTestPkgVersion = (
      packageJson.devDependencies?.["@playwright/test"] ?? ""
    ).replace(/^[\^~]/, "");

    expect(playwrightPkgVersion).toBeTruthy();
    expect(playwrightTestPkgVersion).toBe(playwrightPkgVersion);

    const dockerMatch = dockerfile.match(
      /playwright@([0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?)\s+install/,
    );
    expect(
      dockerMatch,
      "Dockerfile must contain 'playwright@<version> install chromium'",
    ).not.toBeNull();

    const dockerPlaywrightVersion = dockerMatch![1];

    expect(
      dockerPlaywrightVersion,
      `Playwright version in Dockerfile (${dockerPlaywrightVersion}) does not match package.json (${playwrightPkgVersion}). ` +
        `Update line in Dockerfile: 'npx -y playwright@${playwrightPkgVersion} install chromium'`,
    ).toBe(playwrightPkgVersion);
  });
});
