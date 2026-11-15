/**
 * The decoded sprite rows, held as bitmaps the page owns, so a row the bird
 * has shown before can never come back undecoded. Rows are decoded ahead of
 * time: the row it shows and the rows its state can reach next. What isn't
 * needed goes, least recently used first, to keep decoded memory under a
 * budget. No DOM here: decoding and freeing are passed in, so the sequencing
 * and the budget are testable.
 */

/** Decoded memory the sprite rows may hold at once. */
export const SPRITE_BUDGET_BYTES = 30 * 1024 * 1024;

export type Resident = { file: string; bytes: number; usedAt: number };

/**
 * Which files to free so the rest fit the budget: never one in `keep`, the
 * least recently used first, and none at all while everything fits.
 */
export function planEvictions(resident: Resident[], keep: readonly string[], budget: number): string[] {
  let total = resident.reduce((n, r) => n + r.bytes, 0);
  const out: string[] = [];
  for (const r of [...resident].filter((r) => !keep.includes(r.file)).sort((a, b) => a.usedAt - b.usedAt)) {
    if (total <= budget) break;
    out.push(r.file);
    total -= r.bytes;
  }
  return out;
}

export type SpriteCache<B> = {
  /** The bitmap for this file, if it is decoded; marks it used. */
  get: (file: string) => B | undefined;
  /**
   * The files needed now and next, most needed first: decodes those missing,
   * as far as the budget allows, and frees what nothing needs. The first
   * `required` (default 1) are the frame on screen's and load regardless.
   */
  want: (files: readonly string[], required?: number) => void;
  /** Decoded bytes held right now. */
  bytes: () => number;
  /** The files held right now. */
  files: () => string[];
};

export function createSpriteCache<B>(opts: {
  decode: (file: string) => Promise<B>;
  free: (bitmap: B) => void;
  bytesOf: (file: string) => number;
  /** Called once a file's bitmap is ready, so the caller can draw the frame it was waiting for. */
  onReady: (file: string) => void;
  now?: () => number;
  budget?: number;
}): SpriteCache<B> {
  const budget = opts.budget ?? SPRITE_BUDGET_BYTES;
  const now = opts.now ?? (() => Date.now());
  const held = new Map<string, { bitmap: B; bytes: number; usedAt: number }>();
  const pending = new Set<string>();
  let wanted: readonly string[] = [];

  const total = () => [...held.values()].reduce((n, h) => n + h.bytes, 0) + [...pending].reduce((n, f) => n + opts.bytesOf(f), 0);

  /** Frees what nothing wants, least recently used first, until the held rows fit with `room` to spare. */
  const evict = (room = 0) => {
    const resident = [...held.entries()].map(([file, h]) => ({ file, bytes: h.bytes, usedAt: h.usedAt }));
    for (const file of planEvictions(resident, wanted, Math.max(0, budget - room - [...pending].reduce((n, f) => n + opts.bytesOf(f), 0)))) {
      const h = held.get(file);
      if (!h) continue;
      held.delete(file);
      opts.free(h.bitmap);
    }
  };

  const load = (file: string) => {
    pending.add(file);
    opts
      .decode(file)
      .then((bitmap) => {
        pending.delete(file);
        held.set(file, { bitmap, bytes: opts.bytesOf(file), usedAt: now() });
        evict();
        opts.onReady(file);
      })
      .catch(() => {
        // A file that won't decode is a bug to see; the previous frame stays meanwhile.
        pending.delete(file);
      });
  };

  return {
    get(file) {
      const h = held.get(file);
      if (h) h.usedAt = now();
      return h?.bitmap;
    },
    want(files, required = 1) {
      wanted = files;
      evict();
      files.forEach((file, i) => {
        if (held.has(file) || pending.has(file)) return;
        // What the frame on screen needs always loads; what it might show next only if it fits,
        // once rows nothing wants any more have made room. Never refused while they hold it:
        // a frame waiting for a layer that never comes stays on the frame before, for good.
        if (i >= required && total() + opts.bytesOf(file) > budget) {
          evict(opts.bytesOf(file));
          if (total() + opts.bytesOf(file) > budget) return;
        }
        load(file);
      });
    },
    bytes: () => [...held.values()].reduce((n, h) => n + h.bytes, 0),
    files: () => [...held.keys()],
  };
}
