import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BbbHttpError, isChallengeHtml, jitter, percentile } from "./browser.js";

const fixtures = new URL("./__fixtures__/", import.meta.url);
const realCategory = readFileSync(new URL("category-kissimmee-roofing-p2.html", fixtures), "utf8");
const realProfile = readFileSync(new URL("profile-greenway-roofing.html", fixtures), "utf8");

/** What Cloudflare served on 2026-09-07 for a burst of navigations (trimmed). */
const challenge = `<!DOCTYPE html>\r\n<html lang="en">\r\n  <head>\r\n    <meta charset="UTF-8" />\r\n    <title>Just a moment... | Better Business Bureau®</title>\r\n  </head>\r\n  <body class="no-js">\r\n    <div class="main-wrapper" role="main"><div id="challenge-error-text">Enable JavaScript and cookies to continue</div></div>\r\n    <script>(function(){window._cf_chl_opt={cvId: '3',cZone: "www.bbb.org",cType: 'managed'};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=a374ac4b48fbe9e5';document.getElementsByTagName('head')[0].appendChild(a);}());</script>\r\n  </body>\r\n</html>`;

describe("isChallengeHtml", () => {
  it("recognises the Cloudflare interstitial", () => {
    expect(isChallengeHtml(challenge, 403)).toBe(true);
    expect(isChallengeHtml(challenge)).toBe(true);
    expect(isChallengeHtml("<html><head><title>Attention Required! | Cloudflare</title></head><body></body></html>", 403)).toBe(true);
  });
  it("never flags real BBB pages, even though they load the challenge-platform beacon", () => {
    expect(realCategory).toContain("cdn-cgi");
    expect(isChallengeHtml(realCategory, 200)).toBe(false);
    expect(isChallengeHtml(realProfile, 200)).toBe(false);
  });
  it("treats a small 403 body as a block and a large 200 body as content", () => {
    expect(isChallengeHtml("<html><body>Forbidden</body></html>", 403)).toBe(true);
    expect(isChallengeHtml("<html><body>hello</body></html>", 200)).toBe(false);
  });
});

describe("BbbHttpError", () => {
  it("classifies 404 as permanent and 429/5xx as transient", () => {
    expect(new BbbHttpError("u", 404).permanent).toBe(true);
    expect(new BbbHttpError("u", 429).permanent).toBe(false);
    expect(new BbbHttpError("u", 503).permanent).toBe(false);
  });
});

describe("percentile / jitter", () => {
  it("computes nearest-rank percentiles", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
  });
  it("jitters within ±20 %", () => {
    for (let i = 0; i < 100; i++) {
      const j = jitter(1000);
      expect(j).toBeGreaterThanOrEqual(800);
      expect(j).toBeLessThanOrEqual(1200);
    }
  });
});
