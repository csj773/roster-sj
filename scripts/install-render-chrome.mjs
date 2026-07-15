import { execFileSync } from "node:child_process";
import path from "node:path";

const isRender =
  process.env.RENDER === "true" ||
  Boolean(process.env.RENDER_SERVICE_ID) ||
  Boolean(process.env.RENDER_EXTERNAL_URL) ||
  String(process.env.HOME || "").startsWith("/opt/render");

if (!isRender) {
  console.log("Skipping Chrome install outside Render.");
  process.exit(0);
}

console.log("Installing Puppeteer Chrome for Render...");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const cacheDir = process.env.PUPPETEER_CACHE_DIR || path.join(process.cwd(), ".cache", "puppeteer");
execFileSync(npx, ["puppeteer", "browsers", "install", "chrome"], {
  stdio: "inherit",
  env: {
    ...process.env,
    PUPPETEER_CACHE_DIR: cacheDir,
  },
});
