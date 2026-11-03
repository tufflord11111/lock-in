import test from "node:test";
import assert from "node:assert/strict";
import { creditedMinutes } from "./sessionCredit.ts";

test("an awake session earns all of it", () => {
  assert.equal(creditedMinutes(25 * 60, 0), 25);
});

test("time asleep is not credited", () => {
  assert.equal(creditedMinutes(25 * 60, 15 * 60_000), 10);
});

test("a session slept through earns nothing", () => {
  assert.equal(creditedMinutes(25 * 60, 25 * 60_000), 0);
});

test("more sleep than session can't go negative", () => {
  assert.equal(creditedMinutes(25 * 60, 120 * 60_000), 0);
});

test("a partial awake minute still rounds up", () => {
  assert.equal(creditedMinutes(90, 60_000), 1);
});
