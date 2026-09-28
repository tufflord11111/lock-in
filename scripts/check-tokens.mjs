#!/usr/bin/env node
/**
 * Fails if a colour is named directly anywhere in apps/web/src outside
 * theme/. Components must name a role (bg-surface, text-ink) so that a theme
 * is nothing but a block of variables; a stray #002855 or bg-red-500 would be
 * invisible to every theme but Operator.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = "apps/web/src";
const EXEMPT_DIR = "theme";

const PALETTE = [
  "slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber",
  "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue",
  "indigo", "violet", "purple", "fuchsia", "pink", "rose",
];
const UTILITY =
  "bg|text|border|border-[trblxy]|placeholder|ring|from|via|to|divide|outline|fill|stroke|decoration|caret|accent|shadow";

const RULES = [
  { name: "hex colour", re: /#[0-9a-fA-F]{3,8}\b/g },
  { name: "rgb()/rgba() literal", re: /\brgba?\(\s*\d/g },
  { name: "hsl() literal", re: /\bhsla?\(\s*\d/g },
  {
    name: "raw Tailwind palette class",
    re: new RegExp(`\\b(?:${UTILITY})-(?:${PALETTE.join("|")})-[0-9]{2,3}\\b`, "g"),
  },
  { name: "bare white/black utility", re: new RegExp(`\\b(?:${UTILITY})-(?:white|black)(?:\\/\\d+)?\\b`, "g") },
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === EXEMPT_DIR) continue;
      walk(full, out);
    } else if (/\.(tsx?|css)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const findings = [];
for (const file of walk(ROOT)) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) return;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        findings.push(`${relative(process.cwd(), file).split(sep).join("/")}:${i + 1}  ${rule.name}: ${m[0]}`);
      }
    }
  });
}

if (findings.length > 0) {
  console.error(`check:tokens FAILED — ${findings.length} colour(s) named outside ${ROOT}/${EXEMPT_DIR}:\n`);
  for (const f of findings) console.error("  " + f);
  console.error("\nUse a role token instead (see apps/web/src/theme/tokens.css).");
  process.exit(1);
}
console.log(`check:tokens OK — no colour literals or palette classes outside ${ROOT}/${EXEMPT_DIR}`);
