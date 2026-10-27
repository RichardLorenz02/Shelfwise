import test from "node:test";
import assert from "node:assert/strict";
import { route, SLOTS, STOPS } from "../src/utils/library.js";

test("same-aisle movement goes straight to the destination", () => {
  assert.deepEqual(route([435, 303], [765, 303]), [[765, 303]]);
  assert.deepEqual(route([435, 303], [100, 303]), [[100, 303]]);
  assert.deepEqual(route([600, 525], [600, 525]), []);
});
test("does not overshoot a destination to visit a nearest corridor", () => {
  assert.deepEqual(route([435, 303], [240, 160]), [
    [240, 303],
    [240, 160],
  ]);
});
const stops = [...SLOTS.map((s) => s.front), ...Object.values(STOPS)];
function check(from, to, scale) {
  const path = route(from, to, scale);
  if (from[0] === to[0] && from[1] === to[1]) return;
  assert.deepEqual(path.at(-1), to);
  let a = from;
  for (const b of path) {
    assert.ok(
      a[0] === b[0] || a[1] === b[1],
      "Only horizontal or vertical travel",
    );
    for (const { x, y, w, h } of SLOTS) {
      const crosses =
        a[1] === b[1]
          ? a[1] > y - 12 &&
            a[1] < y + h + 12 &&
            Math.max(a[0], b[0]) > x - 12 &&
            Math.min(a[0], b[0]) < x + w + 12
          : a[0] > x - 12 &&
            a[0] < x + w + 12 &&
            Math.max(a[1], b[1]) > y - 12 &&
            Math.min(a[1], b[1]) < y + h + 12;
      assert.equal(
        crosses,
        false,
        "Route must avoid bookcases and their clearance",
      );
    }
    a = b;
  }
}
test("all shelf, stair and elevator pairs remain collision-free at three scene shapes", () => {
  for (const scale of [
    [1, 1],
    [0.3, 0.8],
    [1.5, 0.5],
  ])
    for (const from of stops) for (const to of stops) check(from, to, scale);
});
test("rerouting halfway through any segment starts from the current position", () => {
  for (const from of stops)
    for (const to of stops) {
      let a = from;
      for (const b of route(from, to)) {
        const middle = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        for (const target of stops) check(middle, target, [0.6, 0.8]);
        a = b;
      }
    }
});
