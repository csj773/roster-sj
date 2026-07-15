import { execFileSync } from "node:child_process";

if (process.env.RENDER !== "true") {
  console.log("Skipping Chrome install outside Render.");
  process.exit(0);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
execFileSync(npx, ["puppeteer", "install", "chrome"], { stdio: "inherit" });
