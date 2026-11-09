/**
 * Debug only, outside the app: the overlay's bird in a plain browser page,
 * taken through the tour, with the frame check's lines kept on the page
 * (window.__parrotDebug). Served by the dev server; not in any build.
 */
import "../theme/parrot.css";
import { createBird } from "./bird";
import { startTour } from "./tour";

const el = document.getElementById("bird");
if (!el) throw new Error("No #bird element");
const bird = createBird(el, { sessionActive: false, onClick: () => {}, extraRects: () => [] });
startTour(bird);
// For a test harness to drive the bird directly.
(window as unknown as { __bird?: typeof bird }).__bird = bird;
