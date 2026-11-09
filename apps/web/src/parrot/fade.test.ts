import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * The proximity fade as it renders: parrot.css's own rules, applied to the
 * classes bird.ts puts on each element, faded and not. A tiny cascade: the
 * sheet's top-level rules (not @media), selectors of ids and classes only,
 * equal specificity going by order, the opacity they leave.
 */
const css = readFileSync(new URL("../theme/parrot.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const bird = readFileSync(new URL("./bird.ts", import.meta.url), "utf8");

type Rule = { selectors: string[]; opacity: number | null };

/** Top-level rules only: an @media block's body is skipped whole. */
function rules(sheet: string): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  while (i < sheet.length) {
    const open = sheet.indexOf("{", i);
    if (open < 0) break;
    const head = sheet.slice(i, open).trim();
    if (head.startsWith("@")) {
      // Skip to the brace that closes the @ block.
      let depth = 1;
      let j = open + 1;
      for (; j < sheet.length && depth > 0; j++) {
        if (sheet[j] === "{") depth++;
        else if (sheet[j] === "}") depth--;
      }
      i = j;
      continue;
    }
    const close = sheet.indexOf("}", open);
    const body = sheet.slice(open + 1, close);
    const m = /(?:^|;)\s*opacity:\s*([\d.]+)/.exec(body);
    out.push({ selectors: head.split(",").map((s) => s.trim()), opacity: m ? Number(m[1]) : null });
    i = close + 1;
  }
  return out;
}

/** Whether a selector of ids and classes (like #bird.parrot-faded or .a.b) matches this element. */
function matches(selector: string, id: string, classes: string[]): boolean {
  const parts = selector.match(/[#.][\w-]+/g);
  if (!parts || parts.join("") !== selector) return false;
  return parts.every((p) => (p[0] === "#" ? p.slice(1) === id : classes.includes(p.slice(1))));
}

/** The opacity the sheet leaves on an element: the last matching rule that sets one, else 1. */
function opacityOf(id: string, classes: string[]): number {
  let opacity = 1;
  for (const r of rules(css)) if (r.opacity !== null && r.selectors.some((s) => matches(s, id, classes))) opacity = r.opacity;
  return opacity;
}

/** The classes bird.ts gives each element, perched with its feet on the branch, faded or not. */
function perched(faded: boolean) {
  const shown = true;
  const feet = true;
  // bird.ts showProps: the same toggles, checked against its source below.
  return {
    branch: ["parrot-branch", ...(shown ? ["parrot-shown"] : []), ...(faded && shown ? ["parrot-faded"] : [])],
    shadow: ["parrot-branch-shadow", ...(feet ? ["parrot-shown"] : []), ...(faded && feet ? ["parrot-faded"] : [])],
    grip: ["parrot-sprite", "parrot-grip", ...(faded && feet ? ["parrot-faded"] : [])],
    bird: [] as string[],
  };
}

describe("the proximity fade, as the sheet renders it", () => {
  it("bird.ts gives the elements those classes, and never fades the bird", () => {
    expect(bird).toMatch(/branch\.classList\.toggle\("parrot-shown", shown\)/);
    expect(bird).toMatch(/shadow\.classList\.toggle\("parrot-shown", feet\)/);
    expect(bird).toMatch(/branch\.classList\.toggle\("parrot-faded", faded && shown\)/);
    expect(bird).toMatch(/shadow\.classList\.toggle\("parrot-faded", faded && feet\)/);
    expect(bird).toMatch(/grip\.classList\.toggle\("parrot-faded", faded && feet\)/);
    expect(bird).toMatch(/grip\.className = "parrot-sprite parrot-grip"/);
    expect(bird).not.toMatch(/el\.classList\.(toggle|add)\("parrot-faded"/);
  });

  it("faded: the grip goes to 0 (no lighter patch over the faded branch), the branch and shadow to 20%, the bird stays at 1", () => {
    const c = perched(true);
    expect(opacityOf("", c.grip)).toBe(0);
    expect(opacityOf("", c.branch)).toBe(0.2);
    expect(opacityOf("", c.shadow)).toBe(0.2);
    expect(opacityOf("bird", c.bird)).toBe(1);
  });

  it("unfaded: the branch, shadow, grip and bird are all fully there", () => {
    const c = perched(false);
    expect(opacityOf("", c.grip)).toBe(1);
    expect(opacityOf("", c.branch)).toBe(1);
    expect(opacityOf("", c.shadow)).toBe(1);
    expect(opacityOf("bird", c.bird)).toBe(1);
  });

  it("the grip fades out and back on the branch's 150 ms timing, at once under reduced motion", () => {
    const flat = css.replace(/\s+/g, " ");
    expect(flat).toMatch(/\.parrot-grip\.parrot-faded \{ opacity: 0; transition: opacity 150ms ease; \}/);
    expect(flat).toMatch(/\.parrot-shown\.parrot-faded \{ opacity: 0\.2; transition: opacity 150ms ease; \}/);
    expect(flat).toMatch(/\.parrot-grip \{ transition: opacity 150ms ease; \}/);
    expect(flat).toMatch(/prefers-reduced-motion: reduce\) \{[^}]*\.parrot-grip\.parrot-faded \{ transition: none; \}/);
  });
});
