// Perc Cruncher (@perc.cruncher, giftok-bot) shares the Zernio workspace with Eagle Eyes: posts are split by
// TikTok account, so neither bot's numbers, queue or alarms pick up the other's posts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSchedule } from "../src/schedule.js";
import { postingGaps } from "../src/rules.js";
import { parseZernioPosts } from "../src/watch/zernio.js";
import { BOTS, BOT_IDS } from "../src/bots.js";
import { makeEnv } from "./helpers.js";
import { getState } from "../src/settings.js";

const okFetch = async () => new Response(null, { status: 201 });
const ctx = { waitUntil() {} };
const env = extra => makeEnv({ PUSH_FETCH: okFetch, ...extra });
const NOW = new Date("2026-11-06T19:02:00Z");
const ago = h => new Date(NOW.getTime() - h * 3600e3).toISOString();
const ahead = h => new Date(NOW.getTime() + h * 3600e3).toISOString();
const events = async (e, where) => (await e.DB.prepare(`SELECT * FROM events WHERE ${where}`).all()).results;

function zernio({ posts = [], analytics = [] } = {}) {
  return async url => {
    if (url.includes("zernio.com/api/v1/posts")) return Response.json({ posts });
    if (url.includes("zernio.com/api/v1/analytics")) return Response.json({ posts: analytics, pagination: { pages: 1 } });
    return new Response(null, { status: 201 });
  };
}
const acct = username => ({ platforms: [{ platform: "tiktok", accountId: { _id: username, username } }] });
const post = (id, status, scheduledFor, username, extra = {}) =>
  ({ _id: id, status, scheduledFor, content: `${id}\n#giftok`, ...acct(username), ...extra });

test("Perc Cruncher is a bot in the app", () => {
  assert.ok(BOT_IDS.includes("perc"));
  assert.equal(BOTS.perc.name, "Perc Cruncher");
  assert.equal(BOTS.perc.repo, "giftok-bot");
});

test("Zernio posts are split by TikTok account; unknown accounts are ignored", () => {
  const parsed = parseZernioPosts({ posts: [
    post("a", "published", ago(1), "perc.cruncher"),
    post("b", "published", ago(1), "eagle.eyez.levelz"),
    post("c", "published", ago(1), "someone.else"),
    { _id: "d", status: "published", scheduledFor: ago(1), platforms: [{ platform: "tiktok" }] },
  ] });
  assert.deepEqual(parsed.map(p => [p.id, p.bot]), [["a", "perc"], ["b", "eagle"], ["d", "eagle"]]);
});

test("hourly poll files each account's posts, queue and views under the right bot", async () => {
  const e = await env({ ZERNIO_API_KEY: "k" });
  const fetchFn = zernio({
    posts: [
      post("g1", "published", ago(1.5), "perc.cruncher", { platforms: [{ platform: "tiktok", platformPostUrl: "https://t/g1",
        accountId: { _id: "x", username: "perc.cruncher" } }] }),
      post("g2", "scheduled", ahead(20), "perc.cruncher"),
      post("q1", "published", ago(2), "eagle.eyez.levelz"),
      post("q2", "scheduled", ahead(1), "eagle.eyez.levelz"),
    ],
    analytics: [{ latePostId: "g1", analytics: { views: 310 } }, { latePostId: "q1", analytics: { views: 40 } }],
  });
  await runSchedule({}, e, ctx, fetchFn, NOW);
  const bots = (await e.DB.prepare("SELECT id, bot, url FROM posts ORDER BY id").all()).results;
  assert.deepEqual(bots.map(r => [r.id, r.bot]), [["eagle:q1", "eagle"], ["perc:g1", "perc"]]);
  assert.equal(bots[1].url, "https://t/g1");
  assert.equal(await getState(e.DB, "perc_next_due"), ahead(20));
  assert.equal(await getState(e.DB, "eagle_next_due"), ahead(1));
  assert.equal(await getState(e.DB, "perc_polled_at"), NOW.toISOString());
  const snap = await e.DB.prepare("SELECT views FROM snapshots WHERE post_id = 'perc:g1'").first("views");
  assert.equal(snap, 310);
  const posted = await events(e, "kind = 'posted'");
  assert.deepEqual(posted.map(r => r.bot).sort(), ["eagle", "perc"]);
});

test("a failed Perc Cruncher post alerts under Perc Cruncher", async () => {
  const e = await env({ ZERNIO_API_KEY: "k" });
  await runSchedule({}, e, ctx, zernio({ posts: [post("f1", "failed", ago(3), "perc.cruncher", {
    platforms: [{ platform: "tiktok", errorMessage: "audio removed", accountId: { username: "perc.cruncher" } }] })] }), NOW);
  const [ev] = await events(e, "kind = 'post_failed'");
  assert.equal(ev.bot, "perc");
  assert.equal(ev.title, "Perc Cruncher: a post failed to publish");
  assert.match(ev.body, /audio removed/);
});

test("Perc Cruncher gap alarm allows its 2 a day rhythm", () => {
  const keys = ctx2 => postingGaps({ perc: ago(27) }, null, NOW, ctx2).map(e => e.dedupe_key);
  assert.deepEqual(keys({ percFeedAt: ago(1) }), ["no_posts:perc"]);
  assert.deepEqual(keys({ percFeedAt: ago(1), percNextDue: ahead(2) }), []);
  assert.deepEqual(postingGaps({ perc: ago(23) }, null, NOW, { percFeedAt: ago(1) }), []);
  const [gap] = postingGaps({ perc: ago(40) }, null, NOW, { percFeedAt: ago(1) });
  assert.match(gap.body, /Normally 2 a day/);
});
