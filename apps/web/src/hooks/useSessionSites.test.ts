import { describe, expect, it } from "vitest";
import { sessionSitesFrom } from "./useSessionSites";

const DEFAULTS = ["tiktok.com", "youtube.com", "netflix.com", "instagram.com"];

describe("the sites a session blocks (the union Web Guard applies)", () => {
  it("is the defaults, less the removed ones, plus custom and permanent blocks", () => {
    expect(sessionSitesFrom(DEFAULTS, ["reddit.com"], ["netflix.com"], ["x.com"]).sort()).toEqual(
      ["instagram.com", "reddit.com", "tiktok.com", "x.com", "youtube.com"],
    );
  });

  it("keeps a removed default that was added back as a custom block (the owner's v22 list)", () => {
    // Every default removed, tiktok.com re-added as a custom block, youtube.com blocked permanently.
    const sites = sessionSitesFrom(DEFAULTS, ["tiktok.com"], [...DEFAULTS], ["youtube.com"]);
    expect(sites.sort()).toEqual(["tiktok.com", "youtube.com"]);
    // So the session counts as blocking sites, and locks down.
    expect(sites.length).toBeGreaterThan(0);
  });

  it("counts permanent blocks: a list of only permanent sites still blocks sites in a session", () => {
    expect(sessionSitesFrom([], [], [], ["youtube.com"])).toEqual(["youtube.com"]);
  });

  it("is empty only when there is really nothing to block", () => {
    expect(sessionSitesFrom(DEFAULTS, [], DEFAULTS, [])).toEqual([]);
    expect(sessionSitesFrom([], [], [], [])).toEqual([]);
  });

  it("cleans what it reads and drops what isn't a site", () => {
    expect(sessionSitesFrom([], ["https://www.TikTok.com/@x", "spotify.exe", 42, "nodot"], [], [])).toEqual(["tiktok.com"]);
  });
});
