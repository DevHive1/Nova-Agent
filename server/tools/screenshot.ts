// ============================================================
//  server/tools/screenshot.ts    Web/Page Screenshot Tool (TypeScript)
// ============================================================

import path from "path";
import fs from "fs";
import { exec } from "child_process";

const SCREENSHOT_DIR = path.join(process.cwd(), ".screenshots");
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

/**
 * Resolve path to absolute
 */
function resolvePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(process.cwd(), filePath);
}

/**
 * Capture a screenshot of a URL or local file path.
 */
async function toolScreenshot(urlOrFile: string, options: any = {}): Promise<string> {
  let targetUrl = urlOrFile;
  if (!targetUrl) return "ERROR: no URL or file path provided";

  // local file -> file:// URL
  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://") && !targetUrl.startsWith("file://")) {
    const abs = resolvePath(targetUrl);
    if (!fs.existsSync(abs)) return `ERROR: file not found: ${abs}`;
    targetUrl = `file://${abs}`;
  }

  const outFile = path.join(SCREENSHOT_DIR, `shot_${Date.now()}.png`);

  // Try puppeteer first
  try {
    const puppeteer = require("puppeteer");
    const browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: options.width || 1280, height: options.height || 800 });
    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 30000 });
    if (options.wait) {
      await new Promise(resolve => setTimeout(resolve, options.wait));
    }
    await page.screenshot({ path: outFile, fullPage: options.fullPage || false });
    await browser.close();
    return `\ud83d\udcf7 Screenshot saved to: <code>/screenshots/${path.basename(outFile)}</code>`;
  } catch {
    // Fallback to CLI tools
  }

  // Try wkhtmltoimage
  try {
    const cmd = `wkhtmltoimage --quality 100 --width ${options.width || 1280} ${targetUrl} ${outFile}`;
    await new Promise<void>((resolve, reject) => {
      exec(cmd, { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
          if (stderr.includes("cannot connect to X server")) {
            reject(new Error("X server not available"));
          } else {
            reject(error);
          }
        } else {
          resolve();
        }
      });
    });
    return `\ud83d\udcf7 Screenshot saved to: <code>/screenshots/${path.basename(outFile)}</code>`;
  } catch {
    // Fallback to error
  }

  return `\u274c Could not capture screenshot: no supported tool available (install puppeteer or wkhtmltoimage)`;
}

export { toolScreenshot, SCREENSHOT_DIR };
