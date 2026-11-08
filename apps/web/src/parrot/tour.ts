/**
 * Debug builds only (VITE_PARROT_TOUR=1): takes the bird through every
 * transition on a timer, with made-up events that stay on the page. A made-up
 * session is only the bird's: nothing starts or stops a real one. The bird's own
 * rhythm supplies the walks, turns, fidgets, blinks and rests on the branch;
 * this adds sessions (fly up, sleep, wake, happy, fly down), talk, and drags
 * dropped by the branch and in the open.
 */
import type { Bird } from "./bird";
import { branchBox } from "./perch";

export const TOUR = import.meta.env.VITE_PARROT_TOUR === "1";

export function startTour(bird: Bird, every = { sessionMs: 75_000, talkMs: 40_000, dragMs: 55_000 }) {
  const note = (t: string) => bird.debugNote(`tour ${t}`);
  let drops = 0;

  window.setInterval(() => {
    note("session start");
    bird.dispatch({ type: "session", active: true });
    window.setTimeout(() => {
      note("session end");
      bird.dispatch({ type: "stoodDown", finished: true });
    }, 25_000);
  }, every.sessionMs);

  window.setInterval(() => {
    if (bird.state().sessionActive) return;
    note("talk");
    bird.dispatch({ type: "talkStart" });
    window.setTimeout(() => bird.dispatch({ type: "talkEnd" }), 2_500);
  }, every.talkMs);

  window.setInterval(() => {
    const s = bird.state();
    if (s.mode === "flight" || s.mode === "drag") return;
    const nearBranch = drops++ % 2 === 0;
    const branch = branchBox(window.innerWidth, window.innerHeight);
    const to = nearBranch
      ? { x: branch.x - 30 - s.cell.width, lift: window.innerHeight - branch.y - s.cell.height }
      : { x: window.innerWidth * 0.4, lift: 250 };
    note(`drag to ${nearBranch ? "the branch" : "the open"}`);
    bird.dispatch({ type: "dragStart" });
    const from = { x: s.x, lift: s.lift };
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
      window.setTimeout(() => {
        const u = i / steps;
        bird.dispatch({
          type: "dragMove",
          x: from.x + (to.x - from.x) * u,
          lift: from.lift + (to.lift - from.lift) * u,
          maxLift: window.innerHeight - s.cell.height,
        });
        if (i === steps) bird.dispatch({ type: "dragEnd" });
      }, i * 40);
    }
  }, every.dragMs);
}
