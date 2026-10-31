// Same cases as the budget tests in src-tauri/src/leave.rs.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_DAILY,
  DEFAULT_MONTHLY,
  FREE_ROUTES_PER_MONTH,
  MAX_DAILY,
  MAX_MONTHLY,
  charge,
  clampLimits,
  emptyUsage,
  pacificDate,
  type Usage,
} from "../src/routes-budget.ts";

const limits = { daily: 2, monthly: 10 };

test("pacific midnight is the quota boundary", () => {
  assert.equal(pacificDate(new Date("2026-12-01T07:30:00Z")), "2026-11-30");
  assert.equal(pacificDate(new Date("2026-12-01T08:30:00Z")), "2026-12-01");
  assert.equal(pacificDate(new Date("2026-07-01T06:30:00Z")), "2026-06-30");
  assert.equal(pacificDate(new Date("2026-07-01T07:30:00Z")), "2026-07-01");
});

test("every attempt counts and the next one stops", () => {
  const today = "2026-06-15";
  let usage = emptyUsage(new Date("2026-06-15T18:00:00Z"));
  const first = charge(usage, today, limits);
  assert.equal(first.kind, "allowed");
  if (first.kind !== "allowed") return;
  assert.deepEqual([first.usage.dayCount, first.usage.monthCount], [1, 1]);
  const second = charge(first.usage, today, limits);
  assert.equal(second.kind, "allowed");
  if (second.kind !== "allowed") return;
  assert.equal(second.usage.dayCount, 2);
  const third = charge(second.usage, today, limits);
  assert.equal(third.kind, "daily");
  assert.equal(third.usage.dayCount, 2);
});

test("a new day resets the day and a new month resets both", () => {
  const usage: Usage = { day: "2026-06-15", dayCount: 2, month: "2026-06", monthCount: 5 };
  const next = charge(usage, "2026-06-16", limits);
  assert.equal(next.kind, "allowed");
  if (next.kind !== "allowed") return;
  assert.deepEqual([next.usage.dayCount, next.usage.monthCount], [1, 6]);
  const july = charge(next.usage, "2026-07-01", limits);
  assert.equal(july.kind, "allowed");
  if (july.kind !== "allowed") return;
  assert.deepEqual([july.usage.dayCount, july.usage.monthCount], [1, 1]);
  assert.equal(july.usage.month, "2026-07");
});

test("the monthly cap stops a fresh day and zero is not unlimited", () => {
  const usage: Usage = { day: "2026-06-15", dayCount: 0, month: "2026-06", monthCount: 4 };
  const stopped = charge(usage, "2026-06-15", { daily: 80, monthly: 4 });
  assert.equal(stopped.kind, "monthly");
  assert.equal(stopped.usage.monthCount, 4);
  const none = charge(emptyUsage(new Date("2026-06-15T18:00:00Z")), "2026-06-15", { daily: 0, monthly: 10 });
  assert.equal(none.kind, "daily");
  assert.equal(none.usage.dayCount, 0);
});

test("a limit above the free tier is pulled back", () => {
  assert.deepEqual(clampLimits(10_000, 10_000), { daily: MAX_DAILY, monthly: MAX_MONTHLY });
  assert.deepEqual(clampLimits(0, 2_500), { daily: 0, monthly: DEFAULT_MONTHLY });
  assert.ok(MAX_DAILY * 31 <= FREE_ROUTES_PER_MONTH);
  assert.ok(DEFAULT_DAILY * 31 < FREE_ROUTES_PER_MONTH / 2);
  assert.ok(MAX_MONTHLY < FREE_ROUTES_PER_MONTH);
  assert.equal(DEFAULT_MONTHLY * 2, FREE_ROUTES_PER_MONTH);
});
