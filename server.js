import express from "express";
import { DatabaseSync } from "node:sqlite"; // SQLite is built into Node, nothing to install
import { createHash } from "node:crypto";

const PASSWORD = process.env.ADMIN_PASSWORD;
if (!PASSWORD) throw new Error("Set the ADMIN_PASSWORD environment variable");

// The whole database is one file. Each timer stores WHEN it started, not a ticking number:
// the browser works out the elapsed time itself.
const db = new DatabaseSync(process.env.DB_FILE || "countup.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS timers (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    started_at INTEGER NOT NULL,  -- milliseconds since 1970 (what Date.now() returns)
    paused_at  INTEGER,           -- empty while running
    message    TEXT,              -- optional note shown under the name
    location   TEXT
  )
`);

// Databases created before "location" existed don't have that column yet, so add it.
// (On newer databases it's already there and this fails harmlessly.)
try {
  db.exec("ALTER TABLE timers ADD COLUMN location TEXT");
} catch {}

const allTimers = () => db.prepare("SELECT * FROM timers ORDER BY id").all();

// Message board. Posting is limited to once a day per visitor, remembered in its own
// table so deleting someone's message doesn't let them post again straight away.
// Visitors are stored as a hash of their IP, never the IP itself.
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL   -- milliseconds, like started_at
  );
  CREATE TABLE IF NOT EXISTS last_posts (
    who          TEXT PRIMARY KEY, -- hashed IP (see visitorId)
    last_post_at INTEGER NOT NULL
  )
`);

const POST_EVERY = 24 * 60 * 60 * 1000; // one post per visitor per 24 hours
const MAX_NAME = 30;
const MAX_TEXT = 500;

const latestMessages = () =>
  db
    .prepare(
      "SELECT id, name, text, created_at FROM messages ORDER BY id DESC LIMIT 50",
    )
    .all();

// Who is posting: their IP, hashed so the database never holds real IPs.
// IPv6 users usually get a whole block of addresses (a /64) and could hop between
// them, so for IPv6 only the block counts.
function visitorId(req) {
  let ip = req.ip.replace(/^::ffff:/, ""); // IPv4 written in IPv6 form
  if (ip.includes(":")) {
    const [head, tail = ""] = ip.split("::");
    const left = head ? head.split(":") : [];
    const right = tail ? tail.split(":") : [];
    const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
    ip = groups.slice(0, 4).join(":") + "::/64";
  }
  return createHash("sha256").update(PASSWORD + ip).digest("hex"); // salted with the admin password
}

// When this visitor may post again (0 = now)
function nextPostAt(req) {
  const row = db
    .prepare("SELECT last_post_at FROM last_posts WHERE who = ?")
    .get(visitorId(req));
  return row && row.last_post_at + POST_EVERY > Date.now()
    ? row.last_post_at + POST_EVERY
    : 0;
}

const app = express();
// Caddy sits in front of the app, so the visitor's real IP comes from the
// X-Forwarded-For header it adds. Only believe that header from Caddy itself
// (same machine, or a private Docker network address).
app.set("trust proxy", "loopback, uniquelocal");
app.use(express.json()); // read JSON request bodies into req.body
app.use(express.static("public", { extensions: ["html"] })); // serve the pages; /admin -> admin.html

// ---------- public ----------

app.get("/api/timers", (req, res) => {
  res.json(allTimers());
});

// The Bucharest webcam restarts its YouTube stream every few hours with a new video ID,
// and YouTube's "channel live stream" embed shows "video unavailable", so look up the
// current video ourselves. Cached for 10 minutes so we don't ask YouTube on every visit.
const BUCHAREST_CHANNEL = "UCE5jk2omKe23EUKPJtHlzEg";
let bucharestLive = { videoId: null, checkedAt: 0 };

app.get("/api/bucharest-live", async (req, res) => {
  if (Date.now() - bucharestLive.checkedAt > 10 * 60 * 1000) {
    try {
      const page = await fetch(
        `https://www.youtube.com/channel/${BUCHAREST_CHANNEL}/live`,
        { headers: { "Accept-Language": "en", Cookie: "SOCS=CAI" } }, // SOCS skips the EU cookie-consent page
      );
      const html = await page.text();
      // While live, the page's canonical link points at the current stream's video
      const videoId = html.match(
        /<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/,
      )?.[1];
      bucharestLive = { videoId: videoId ?? null, checkedAt: Date.now() };
    } catch {
      // YouTube unreachable: keep the last known video and try again next time
    }
  }
  res.json({ videoId: bucharestLive.videoId });
});

// The board, plus when this visitor can next post (so the page can show a countdown)
app.get("/api/messages", (req, res) => {
  res.json({ messages: latestMessages(), nextPostAt: nextPostAt(req) });
});

app.post("/api/messages", (req, res) => {
  const body = req.body ?? {}; // no JSON sent at all -> treat as empty
  // Hidden "website" field: people never see it, simple bots fill in everything.
  // Pretend it worked so the bot doesn't learn anything.
  if (body.website)
    return res.json({ messages: latestMessages(), nextPostAt: 0 });

  const waitUntil = nextPostAt(req);
  if (waitUntil)
    return res.status(429).json({
      error: "You can only post once a day",
      messages: latestMessages(),
      nextPostAt: waitUntil,
    });

  // Never trust the browser's limits: trim and check again here
  const name = String(body.name ?? "").trim().slice(0, MAX_NAME);
  const text = String(body.text ?? "").trim().slice(0, MAX_TEXT);
  if (!name || !text)
    return res.status(400).json({ error: "Write a name and a message" });

  const now = Date.now();
  db.prepare(
    "INSERT INTO messages (name, text, created_at) VALUES (?, ?, ?)",
  ).run(name, text, now);
  db.prepare(
    `INSERT INTO last_posts (who, last_post_at) VALUES (?, ?)
       ON CONFLICT (who) DO UPDATE SET last_post_at = excluded.last_post_at`,
  ).run(visitorId(req), now);
  res.json({ messages: latestMessages(), nextPostAt: now + POST_EVERY });
});

// ---------- admin: every route below needs the password ----------

app.use("/api/admin", (req, res, next) => {
  if (req.get("X-Password") !== PASSWORD)
    return res.status(401).json({ error: "Wrong password" });
  next();
});

app.delete("/api/admin/messages/:id", (req, res) => {
  db.prepare("DELETE FROM messages WHERE id = ?").run(req.params.id);
  res.json({ messages: latestMessages() });
});

app.get("/api/admin/timers", (req, res) => {
  res.json(allTimers());
});

// Add: starts from the date given, or from now if none was picked
app.post("/api/admin/timers", (req, res) => {
  db.prepare(
    "INSERT INTO timers (name, location, started_at) VALUES (?, ?, ?)",
  ).run(
    req.body.name,
    req.body.location || null,
    req.body.started_at ?? Date.now(),
  );
  res.json(allTimers());
});

app.post("/api/admin/timers/:id/location", (req, res) => {
  db.prepare("UPDATE timers SET location = ? WHERE id = ?").run(
    req.body.location || null,
    req.params.id,
  );
  res.json(allTimers());
});

// Set date: count up from a specific moment
app.post("/api/admin/timers/:id/start", (req, res) => {
  db.prepare("UPDATE timers SET started_at = ? WHERE id = ?").run(
    req.body.started_at,
    req.params.id,
  );
  res.json(allTimers());
});

app.patch("/api/admin/timers/:id", (req, res) => {
  db.prepare("UPDATE timers SET name = ? WHERE id = ?").run(
    req.body.name,
    req.params.id,
  );
  res.json(allTimers());
});

// Reset: start counting from now again.
// If it's paused, it stays paused, at zero (paused_at = started_at means 0 time has passed).
app.post("/api/admin/timers/:id/reset", (req, res) => {
  const now = Date.now();
  db.prepare(
    "UPDATE timers SET started_at = ?, paused_at = IIF(paused_at IS NULL, NULL, ?) WHERE id = ?",
  ).run(now, now, req.params.id);
  res.json(allTimers());
});

app.post("/api/admin/timers/:id/pause", (req, res) => {
  db.prepare(
    "UPDATE timers SET paused_at = ? WHERE id = ? AND paused_at IS NULL",
  ).run(Date.now(), req.params.id);
  res.json(allTimers());
});

// Message shown under the name, paused or not. Empty = no message
// (a paused item with no message shows PAUSED_MESSAGE from shared.js).
app.post("/api/admin/timers/:id/message", (req, res) => {
  db.prepare("UPDATE timers SET message = ? WHERE id = ?").run(
    req.body.message || null,
    req.params.id,
  );
  res.json(allTimers());
});

// Resume: move the start forward by however long it was paused, so it carries on where it stopped
app.post("/api/admin/timers/:id/resume", (req, res) => {
  db.prepare(
    `UPDATE timers SET started_at = started_at + (? - paused_at), paused_at = NULL
              WHERE id = ? AND paused_at IS NOT NULL`,
  ).run(Date.now(), req.params.id);
  res.json(allTimers());
});

app.delete("/api/admin/timers/:id", (req, res) => {
  db.prepare("DELETE FROM timers WHERE id = ?").run(req.params.id);
  res.json(allTimers());
});

app.listen(3000, () => console.log("Running on http://localhost:3000"));
