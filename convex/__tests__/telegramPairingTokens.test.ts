import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

afterEach(() => vi.useRealTimers());

test("cleanup drains expired tokens in bounded transactions and preserves live tokens", async () => {
  vi.useFakeTimers();
  const now = Date.parse("2026-09-14T00:00:00Z");
  vi.setSystemTime(now);
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (let index = 0; index < 205; index += 1) {
      await ctx.db.insert("telegramPairingTokens", {
        userId: "fixture-owner",
        token: `expired-${index}`,
        expiresAt: now - 1,
        used: index % 2 === 0,
      });
    }
    for (const [token, expiresAt, used] of [
      ["boundary", now, false],
      ["live", now + 60_000, false],
      ["live-used", now + 60_000, true],
    ] as const) {
      await ctx.db.insert("telegramPairingTokens", { userId: "fixture-owner", token, expiresAt, used });
    }
  });
  expect(await t.mutation(internal.telegramPairingTokens.cleanupExpired, {})).toEqual({ deleted: 100 });
  expect(await t.run(async (ctx) => (await ctx.db.query("telegramPairingTokens").collect()).length)).toBe(108);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const remaining = await t.run(async (ctx) => (await ctx.db.query("telegramPairingTokens").collect()).map((row) => row.token).sort());
  expect(remaining).toEqual(["boundary", "live", "live-used"]);
  expect(await t.mutation(internal.telegramPairingTokens.cleanupExpired, {})).toEqual({ deleted: 0 });
});
