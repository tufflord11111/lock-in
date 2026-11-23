import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// 1.3.1 step 20: a --silently launch shows the window without focus, so
// main.tsx sets html[data-unfocused] and tokens.css pauses every animation.
// The loader's finish was a CSS fade whose animationend removed it: paused,
// the fade never ended and the loader covered the dashboard until a click.
const loader = readFileSync(new URL("../public/loader.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const tokens = readFileSync(new URL("./theme/tokens.css", import.meta.url), "utf8");

function boot() {
  const classes = new Set(["li-dark"]);
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const el = {
    removed: false,
    classList: {
      contains: (c: string) => classes.has(c),
      add: (c: string) => classes.add(c),
      replace: (a: string, b: string) => classes.delete(a) && classes.add(b),
    },
    addEventListener: () => {}, // animationend never arrives: the fade is paused
    remove() {
      this.removed = true;
    },
  };
  const window: Record<string, unknown> = { addEventListener: () => {} };
  runInNewContext(loader, {
    window,
    document: { getElementById: (id: string) => (id === "li-loader" && !el.removed ? el : null) },
    localStorage: { getItem: () => null },
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
  });
  return { el, timers, finish: window.lockInLoaderFinish as () => void };
}

describe("the [•] loader in an unfocused window", () => {
  it("goes away without animationend, shortly after the 0.8 s fade is due", () => {
    const { el, timers, finish } = boot();
    expect(timers).toHaveLength(0);
    finish();
    expect(el.removed).toBe(false);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBeGreaterThanOrEqual(800);
    expect(timers[0].ms).toBeLessThanOrEqual(1500);
    timers[0].fn();
    expect(el.removed).toBe(true);
  });

  it("finishes once, however many times it is called", () => {
    const { timers, finish } = boot();
    finish();
    finish();
    expect(timers).toHaveLength(1);
  });

  it("keeps its finish animation running where tokens.css pauses the rest", () => {
    expect(tokens).toMatch(/html\[data-unfocused\] \*[\s\S]*?animation-play-state: paused !important/);
    expect(html).toContain("#li-loader.li-done,#li-loader.li-done *{animation-play-state:running!important}");
  });
});
