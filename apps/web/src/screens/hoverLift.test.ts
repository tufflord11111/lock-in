import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("anything that lifts on hover keeps its hover (no flicker at its bottom edge)", () => {
  it("every hover-lifting element on the blocks screen carries hover-lift", () => {
    const classes = [...src("./BlockRegistry.tsx").matchAll(/className="([^"]*)"/g)].map((m) => m[1]);
    const lifting = classes.filter((c) => /hover:-translate-y-1\b/.test(c));
    expect(lifting.length).toBeGreaterThanOrEqual(4);
    for (const c of lifting) expect(c.split(/\s+/), c).toContain("hover-lift");
  });

  it("hover-lift keeps a strip under it exactly as tall as the lift (translate-y-1 = 0.25rem)", () => {
    const css = src("../../../../packages/ui/src/global.css").replace(/\s+/g, " ");
    expect(css).toMatch(/\.hover-lift \{ position: relative; \}/);
    expect(css).toMatch(/\.hover-lift::after \{ content: ""; position: absolute; left: 0; right: 0; top: 100%; height: 0\.25rem; \}/);
  });
});
