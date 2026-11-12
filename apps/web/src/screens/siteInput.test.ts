import { describe, expect, it } from "vitest";
import { normalizeSite } from "./siteInput";

const site = (raw: string) => {
  const r = normalizeSite(raw);
  return r.ok ? r.domain : `!${r.reason}`;
};

describe("turning what people type into a site to block", () => {
  it("reads every way of writing YouTube as youtube.com", () => {
    for (const raw of ["youtube", "YouTube", "YouTube.com", "youtube.com", "https://www.youtube.com/watch?v=x", "www.youtube.com/", "  http://YOUTUBE.COM  ", "youtube.com.", "https://youtube.com:443/feed"]) {
      expect(site(raw), raw).toBe("youtube.com");
    }
  });

  it("gives a bare word .com", () => {
    expect(site("tiktok")).toBe("tiktok.com");
    expect(site("reddit")).toBe("reddit.com");
  });

  it("keeps subdomains and other endings", () => {
    expect(site("m.youtube.com")).toBe("m.youtube.com");
    expect(site("twitch.tv")).toBe("twitch.tv");
    expect(site("bbc.co.uk")).toBe("bbc.co.uk");
    expect(site("https://old.reddit.com/r/x")).toBe("old.reddit.com");
    expect(site("www2.example.org")).toBe("example.org");
  });

  it("says when it's an app, not a site", () => {
    expect(site("spotify.exe")).toBe("!app");
    expect(site("C:\\Games\\game.exe")).toBe("!app");
  });

  it("refuses only real garbage", () => {
    for (const raw of ["!!!", "you tube", "youtube.c", "-youtube.com", "youtube..com", "http://", "@#$.com", "a_b.com"]) {
      expect(site(raw), raw).toMatch(/^!/);
    }
    expect(site("   ")).toBe("!empty");
  });
});
