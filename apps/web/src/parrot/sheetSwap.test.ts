import { describe, expect, it, vi } from "vitest";
import type { FrameSource } from "./animator";
import { createSheetSwap } from "./sheetSwap";

const frame = (file: string, x = 0): FrameSource => ({ file, size: { width: 800, height: 152 }, position: { x, y: 0 } });

function fakeDecoder() {
  const pending = new Map<string, () => void>();
  const decode = vi.fn(
    (file: string) =>
      new Promise<void>((resolve) => {
        pending.set(file, resolve);
      }),
  );
  return { decode, resolve: (file: string) => pending.get(file)?.(), pending };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the sheet swap", () => {
  it("applies the first image only once it is decoded, and then is ready", async () => {
    const d = fakeDecoder();
    const apply = vi.fn();
    const swapped = vi.fn();
    const swap = createSheetSwap(d.decode, apply, swapped);
    let ready = false;
    void swap.ready.then(() => (ready = true));

    swap.show(frame("idle.png"));
    expect(apply).not.toHaveBeenCalled();
    expect(swap.shown()).toBe("");
    d.resolve("idle.png");
    await flush();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(frame("idle.png"));
    expect(swapped).toHaveBeenCalledTimes(1);
    expect(swap.shown()).toBe("idle.png");
    expect(ready).toBe(true);
  });

  it("marks the row shown when its decode completes, so the redraw it asks for does not request it again", async () => {
    // The bug this guards: the decode callback redrew without applying, the
    // redraw saw the row as not shown, requested the same decode, and so on
    // forever, with the element never getting an image.
    const d = fakeDecoder();
    const apply = vi.fn();
    let swap: ReturnType<typeof createSheetSwap>;
    const redraw = vi.fn(() => swap.show(frame("idle.png")));
    swap = createSheetSwap(d.decode, apply, redraw);
    swap.show(frame("idle.png"));
    d.resolve("idle.png");
    await flush();
    await flush();
    expect(swap.shown()).toBe("idle.png");
    expect(redraw).toHaveBeenCalledTimes(1);
    expect(d.decode).toHaveBeenCalledTimes(1);
    // Once from the swap itself, once from the redraw, both for the shown row.
    expect(apply.mock.calls.map((c) => c[0].file)).toEqual(["idle.png", "idle.png"]);
    await expect(swap.ready).resolves.toBeUndefined();
  });

  it("moves the frame at once while the image is up, and decodes each file once", async () => {
    const d = fakeDecoder();
    const apply = vi.fn();
    const swap = createSheetSwap(d.decode, apply);
    swap.show(frame("idle.png"));
    d.resolve("idle.png");
    await flush();
    swap.show(frame("idle.png", -168));
    swap.show(frame("idle.png", -336));
    expect(apply).toHaveBeenCalledTimes(3);
    expect(apply).toHaveBeenLastCalledWith(frame("idle.png", -336));
    expect(d.decode).toHaveBeenCalledTimes(1);
  });

  it("holds the old row until the new one is decoded, and does not loop on it", async () => {
    const d = fakeDecoder();
    const apply = vi.fn();
    const swap = createSheetSwap(d.decode, apply, () => swap.show(frame("walk.png", -168)));
    swap.show(frame("idle.png"));
    d.resolve("idle.png");
    await flush();
    swap.show(frame("walk.png"));
    swap.show(frame("walk.png", -168));
    // Still idle on the element, one decode in flight.
    expect(apply).toHaveBeenCalledTimes(1);
    expect(d.decode).toHaveBeenCalledTimes(2);
    d.resolve("walk.png");
    await flush();
    await flush();
    // Applied once by the swap, once by the redraw the swap asked for. No more decodes.
    expect(apply.mock.calls.slice(1).map((c) => c[0].file)).toEqual(["walk.png", "walk.png"]);
    expect(d.decode).toHaveBeenCalledTimes(2);
    expect(swap.shown()).toBe("walk.png");
  });

  it("drops a row that was superseded before its decode finished", async () => {
    const d = fakeDecoder();
    const apply = vi.fn();
    const swap = createSheetSwap(d.decode, apply);
    swap.show(frame("idle.png"));
    d.resolve("idle.png");
    await flush();
    swap.show(frame("peck.png"));
    swap.show(frame("walk.png"));
    d.resolve("peck.png");
    await flush();
    expect(swap.shown()).toBe("idle.png");
    d.resolve("walk.png");
    await flush();
    expect(swap.shown()).toBe("walk.png");
    expect(apply.mock.calls.map((c) => c[0].file)).toEqual(["idle.png", "walk.png"]);
  });

  it("still swaps when a decode fails, so a broken image shows instead of nothing", async () => {
    const apply = vi.fn();
    const swap = createSheetSwap(() => Promise.reject(new Error("404")), apply);
    swap.show(frame("missing.png"));
    await flush();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(swap.shown()).toBe("missing.png");
  });
});
