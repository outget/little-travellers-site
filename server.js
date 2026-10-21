import express from "express";
import { DatabaseSync } from "node:sqlite"; // SQLite is built into Node, nothing to install
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

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
      "SELECT id, name, text, created_at, poster_id FROM messages ORDER BY id DESC LIMIT 50",
    )
    .all();

// Who is posting: their IP, hashed so the database never holds real IPs.
// IPv6 users usually get a whole block of addresses (a /64) and could hop between
// them, so for IPv6 only the block counts.
function visitorId(req, kind = "") {
  let ip = req.ip.replace(/^::ffff:/, ""); // IPv4 written in IPv6 form
  if (ip.includes(":")) {
    const [head, tail = ""] = ip.split("::");
    const left = head ? head.split(":") : [];
    const right = tail ? tail.split(":") : [];
    const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
    ip = groups.slice(0, 4).join(":") + "::/64";
  }
  // salted with the admin password; kind keeps the board and comment limits apart
  return createHash("sha256").update(PASSWORD + kind + ip).digest("hex");
}

// Whose once-a-day limit this is: a logged-in diary writer's account (so they don't
// use up the limit of everyone else on their network), otherwise the visitor's IP.
function limitKey(req, kind = "") {
  const poster = currentPoster(req);
  if (!poster) return visitorId(req, kind);
  return createHash("sha256").update(PASSWORD + kind + "poster:" + poster.id).digest("hex");
}

// When this visitor may post again (0 = now). kind "comment:<post id>" is the
// comment limit for one diary post.
function nextPostAt(req, kind = "") {
  const row = db
    .prepare("SELECT last_post_at FROM last_posts WHERE who = ?")
    .get(limitKey(req, kind));
  return row && row.last_post_at + POST_EVERY > Date.now()
    ? row.last_post_at + POST_EVERY
    : 0;
}

function recordPost(req, kind, now) {
  db.prepare(
    `INSERT INTO last_posts (who, last_post_at) VALUES (?, ?)
       ON CONFLICT (who) DO UPDATE SET last_post_at = excluded.last_post_at`,
  ).run(limitKey(req, kind), now);
}

// The name a message or comment is posted under: a logged-in diary writer always
// posts as themselves; visitors type a name, but can't take a diary writer's name.
function authorOf(req, typedName) {
  const poster = currentPoster(req);
  if (poster) return { name: poster.username, posterId: poster.id };
  const name = String(typedName ?? "").trim().slice(0, MAX_NAME);
  const taken = db
    .prepare("SELECT 1 FROM posters WHERE lower(username) = lower(?)")
    .get(name);
  if (taken) return { error: "That name belongs to one of the diary writers" };
  return { name, posterId: null };
}

// ---------- diaries ----------
// Three people (the "posters") each have a diary page at /diary/<username>.
// Anyone can read and comment; only the owner can post, after logging in.
// Passwords are stored as scrypt hashes; a login gives a random session token.
db.exec(`
  CREATE TABLE IF NOT EXISTS posters (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL   -- "salt:hash", see hashPassword
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    poster_id  INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS posts (
    id         INTEGER PRIMARY KEY,
    poster_id  INTEGER NOT NULL,
    text       TEXT,              -- empty for an image-only post
    image      TEXT,              -- file name in UPLOADS, empty for a text-only post
    image_size INTEGER,           -- bytes, for the disk-usage figure on the admin page
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY,
    post_id    INTEGER NOT NULL,
    name       TEXT NOT NULL,
    text       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

// Images live in an "uploads" folder next to the database, so they're kept in the
// same place (and the same Docker volume) as the database itself.
const UPLOADS = path.join(path.dirname(process.env.DB_FILE || "countup.db"), "uploads");
fs.mkdirSync(UPLOADS, { recursive: true });

// Messages and comments written by a logged-in diary writer remember who it was
for (const table of ["messages", "comments"])
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN poster_id INTEGER`);
  } catch {} // already there

const SESSION_DAYS = 30;
const MAX_POST = 5000; // characters
const MAX_IMAGE = 3 * 1024 * 1024; // the browser shrinks photos to ~200 KB; this is a safety cap

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + scryptSync(password, salt, 32).toString("hex");
}

function checkPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  return timingSafeEqual(scryptSync(password, salt, 32), Buffer.from(hash, "hex"));
}

// When this diary writer may post in their diary again (0 = now): once a day, counted
// from their newest post, so if the admin deletes a post by mistake they can post again
function nextDiaryPostAt(posterId) {
  const row = db
    .prepare("SELECT MAX(created_at) AS last FROM posts WHERE poster_id = ?")
    .get(posterId);
  return row.last && row.last + POST_EVERY > Date.now() ? row.last + POST_EVERY : 0;
}

// The logged-in poster for this request (from the X-Session header), or undefined
function currentPoster(req) {
  const token = req.get("X-Session");
  if (!token) return;
  return db
    .prepare(
      `SELECT posters.id, posters.username FROM sessions
         JOIN posters ON posters.id = sessions.poster_id
        WHERE sessions.token = ? AND sessions.created_at > ?`,
    )
    .get(token, Date.now() - SESSION_DAYS * 24 * 60 * 60 * 1000);
}

// Everything a diary page shows: the newest 100 posts, each with its comments
function diaryPosts(posterId) {
  const posts = db
    .prepare(
      "SELECT id, text, image, created_at FROM posts WHERE poster_id = ? ORDER BY id DESC LIMIT 100",
    )
    .all(posterId);
  const comments = db.prepare(
    "SELECT id, name, text, created_at, poster_id FROM comments WHERE post_id = ? ORDER BY id",
  );
  for (const post of posts) post.comments = comments.all(post.id);
  return posts;
}

// Only accept real JPEG or WebP files, recognised by their first bytes, not by what
// the browser claims they are
function imageType(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return "webp";
}

function deletePostImage(post) {
  if (post?.image) fs.rmSync(path.join(UPLOADS, post.image), { force: true });
}

// Wrong passwords: at most 5 tries per visitor per 15 minutes, so passwords can't be guessed
const loginFailures = new Map(); // visitor -> { count, since }

const app = express();
// Caddy sits in front of the app, so the visitor's real IP comes from the
// X-Forwarded-For header it adds. Only believe that header from Caddy itself
// (same machine, or a private Docker network address).
app.set("trust proxy", "loopback, uniquelocal");
app.use(express.json()); // read JSON request bodies into req.body
app.use(express.static("public", { extensions: ["html"] })); // serve the pages; /admin -> admin.html
// Uploaded images never change (each gets a new random name), so browsers can keep them for a year
app.use("/uploads", express.static(UPLOADS, { immutable: true, maxAge: "365d" }));
app.get("/diary/:username", (req, res) => res.sendFile(path.resolve("public/diary.html")));

// ---------- public ----------

app.get("/api/timers", (req, res) => {
  res.json(allTimers());
});

// The Bucharest webcam (Piața Obor, the closest live cam to Strada Siriului) restarts its
// YouTube stream every few hours with a new video ID, and its channel runs other cams too,
// so look through the channel's streams for the live one titled "Obor".
// Cached for 10 minutes so we don't ask YouTube on every visit.
const BUCHAREST_CHANNEL = "UCE5jk2omKe23EUKPJtHlzEg";
const BUCHAREST_TITLE = /obor/i;
let bucharestLive = { videoId: null, checkedAt: 0 };

app.get("/api/bucharest-live", async (req, res) => {
  if (Date.now() - bucharestLive.checkedAt > 10 * 60 * 1000) {
    try {
      const page = await fetch(
        `https://www.youtube.com/channel/${BUCHAREST_CHANNEL}/streams`,
        { headers: { "Accept-Language": "en", Cookie: "SOCS=CAI" } }, // SOCS skips the EU cookie-consent page
      );
      const html = await page.text();
      // The page carries its video list as JSON; each video is a "richItemRenderer",
      // and ones streaming right now have the LIVE thumbnail badge
      const data = JSON.parse(html.split("var ytInitialData = ")[1].split(";</script>")[0]);
      const videos = [];
      (function collect(node) {
        if (!node || typeof node !== "object") return;
        if (node.richItemRenderer) return videos.push(JSON.stringify(node.richItemRenderer));
        for (const key in node) collect(node[key]);
      })(data);
      const live = videos.find(
        (v) => v.includes("THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE") && BUCHAREST_TITLE.test(v),
      );
      const videoId = live?.match(/"videoId":"([\w-]{11})"/)?.[1];
      bucharestLive = { videoId: videoId ?? null, checkedAt: Date.now() };
    } catch {
      // YouTube unreachable or the page changed: keep the last known video, try again later
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
  const author = authorOf(req, body.name);
  if (author.error) return res.status(400).json({ error: author.error });
  const text = String(body.text ?? "").trim().slice(0, MAX_TEXT);
  if (!author.name || !text)
    return res.status(400).json({ error: "Write a name and a message" });

  const now = Date.now();
  db.prepare(
    "INSERT INTO messages (name, text, created_at, poster_id) VALUES (?, ?, ?, ?)",
  ).run(author.name, text, now, author.posterId);
  recordPost(req, "", now);
  res.json({ messages: latestMessages(), nextPostAt: now + POST_EVERY });
});

// ---------- diaries: public ----------

app.get("/api/diaries", (req, res) => {
  res.json(db.prepare("SELECT username FROM posters ORDER BY id").all());
});

app.get("/api/diaries/:username", (req, res) => {
  const poster = db
    .prepare("SELECT id, username FROM posters WHERE username = ?")
    .get(req.params.username);
  if (!poster) return res.status(404).json({ error: "No diary with that name" });
  // Each post says when this visitor can next comment on it
  const posts = diaryPosts(poster.id);
  for (const post of posts) post.nextCommentAt = nextPostAt(req, "comment:" + post.id);
  res.json({ username: poster.username, posts });
});

// Comments: a name (or the logged-in diary writer), like the message board.
// Once a day per post, so a visitor can still comment on every post each day.
app.post("/api/posts/:id/comments", (req, res) => {
  const body = req.body ?? {};
  if (body.website) return res.json({ nextCommentAt: 0 }); // honeypot, see the message board

  const post = db.prepare("SELECT id FROM posts WHERE id = ?").get(req.params.id);
  if (!post) return res.status(404).json({ error: "That post is gone" });
  const limit = "comment:" + post.id;
  const waitUntil = nextPostAt(req, limit);
  if (waitUntil)
    return res
      .status(429)
      .json({ error: "You can comment on each post once a day", nextCommentAt: waitUntil });

  const author = authorOf(req, body.name);
  if (author.error) return res.status(400).json({ error: author.error });
  const text = String(body.text ?? "").trim().slice(0, MAX_TEXT);
  if (!author.name || !text)
    return res.status(400).json({ error: "Write a name and a comment" });

  const now = Date.now();
  db.prepare(
    "INSERT INTO comments (post_id, name, text, created_at, poster_id) VALUES (?, ?, ?, ?, ?)",
  ).run(post.id, author.name, text, now, author.posterId);
  recordPost(req, limit, now);
  res.json({ nextCommentAt: now + POST_EVERY });
});

// ---------- diaries: posters ----------

app.post("/api/login", (req, res) => {
  const who = visitorId(req, "login");
  const failures = loginFailures.get(who);
  if (failures && failures.count >= 5 && Date.now() - failures.since < 15 * 60 * 1000)
    return res
      .status(429)
      .json({ error: "Too many wrong passwords, try again in 15 minutes" });

  const username = String(req.body?.username ?? "").trim();
  const password = String(req.body?.password ?? "");
  const poster = db.prepare("SELECT * FROM posters WHERE username = ?").get(username);
  if (!poster || !checkPassword(password, poster.password_hash)) {
    const fresh = !failures || Date.now() - failures.since >= 15 * 60 * 1000;
    loginFailures.set(who, {
      count: fresh ? 1 : failures.count + 1,
      since: fresh ? Date.now() : failures.since,
    });
    return res.status(401).json({ error: "Wrong username or password" });
  }

  loginFailures.delete(who);
  const token = randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO sessions (token, poster_id, created_at) VALUES (?, ?, ?)",
  ).run(token, poster.id, Date.now());
  res.json({ token, username: poster.username });
});

app.post("/api/logout", (req, res) => {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(req.get("X-Session") ?? "");
  res.json({});
});

// Which poster this browser is logged in as (the diary page uses it to show the post form)
app.get("/api/me", (req, res) => {
  const poster = currentPoster(req);
  if (!poster) return res.status(401).json({ error: "Not logged in" });
  res.json({ username: poster.username, nextDiaryPostAt: nextDiaryPostAt(poster.id) });
});

// A new post in the logged-in poster's own diary. Sent as a form with "text" and/or
// "image" (already shrunk by the browser).
app.post("/api/posts", async (req, res) => {
  const poster = currentPoster(req);
  if (!poster) return res.status(401).json({ error: "Log in to post" });
  const waitUntil = nextDiaryPostAt(poster.id);
  if (waitUntil)
    return res
      .status(429)
      .json({ error: "One diary entry a day", nextDiaryPostAt: waitUntil });
  if (Number(req.get("Content-Length")) > MAX_IMAGE + MAX_POST * 4 + 10000)
    return res.status(413).json({ error: "That image is too big" });

  let form;
  try {
    form = await new Request("http://local", {
      method: "POST",
      headers: req.headers,
      body: Readable.toWeb(req),
      duplex: "half",
    }).formData();
  } catch {
    return res.status(400).json({ error: "Couldn't read the post" });
  }

  const text = String(form.get("text") ?? "").trim().slice(0, MAX_POST);
  const file = form.get("image");
  let image = null;
  let bytes = null;
  if (file && typeof file !== "string" && file.size) {
    if (file.size > MAX_IMAGE) return res.status(413).json({ error: "That image is too big" });
    bytes = Buffer.from(await file.arrayBuffer());
    const type = imageType(bytes);
    if (!type) return res.status(400).json({ error: "Only photos (JPEG or WebP) can be posted" });
    image = randomBytes(12).toString("hex") + "." + type;
  }
  if (!text && !image) return res.status(400).json({ error: "Write something or add a photo" });

  if (image) fs.writeFileSync(path.join(UPLOADS, image), bytes);
  db.prepare(
    "INSERT INTO posts (poster_id, text, image, image_size, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(poster.id, text || null, image, bytes?.length ?? null, Date.now());
  res.json({ posts: diaryPosts(poster.id), nextDiaryPostAt: nextDiaryPostAt(poster.id) });
});

// ---------- admin: every route below needs the password ----------

app.use("/api/admin", (req, res, next) => {
  if (req.get("X-Password") !== PASSWORD)
    return res.status(401).json({ error: "Wrong password" });
  next();
});

app.get("/api/admin/posters", (req, res) => {
  const posters = db
    .prepare(
      `SELECT posters.id, posters.username, COUNT(posts.id) AS posts
         FROM posters LEFT JOIN posts ON posts.poster_id = posters.id
        GROUP BY posters.id ORDER BY posters.id`,
    )
    .all();
  // Disk: what the photos take up, and what's left on the server
  const images = db.prepare("SELECT COALESCE(SUM(image_size), 0) AS bytes FROM posts").get();
  const disk = fs.statfsSync(UPLOADS);
  res.json({ posters, imageBytes: images.bytes, freeBytes: disk.bavail * disk.bsize });
});

app.post("/api/admin/posters", (req, res) => {
  const username = String(req.body.username ?? "").trim();
  const password = String(req.body.password ?? "");
  // Usernames end up in the page address (/diary/<username>), so keep them simple
  if (!/^[a-zA-Z0-9_-]{1,20}$/.test(username))
    return res.status(400).json({ error: "Username: up to 20 letters, numbers, - or _" });
  if (password.length < 8)
    return res.status(400).json({ error: "Password: at least 8 characters" });
  try {
    db.prepare("INSERT INTO posters (username, password_hash) VALUES (?, ?)").run(
      username,
      hashPassword(password),
    );
  } catch {
    return res.status(400).json({ error: "That username is taken" });
  }
  res.json({});
});

// New password; also logs them out everywhere
app.post("/api/admin/posters/:id/password", (req, res) => {
  const password = String(req.body.password ?? "");
  if (password.length < 8)
    return res.status(400).json({ error: "Password: at least 8 characters" });
  db.prepare("UPDATE posters SET password_hash = ? WHERE id = ?").run(
    hashPassword(password),
    req.params.id,
  );
  db.prepare("DELETE FROM sessions WHERE poster_id = ?").run(req.params.id);
  res.json({});
});

// Deletes the poster and their whole diary: posts, photos and comments
app.delete("/api/admin/posters/:id", (req, res) => {
  const posts = db.prepare("SELECT id, image FROM posts WHERE poster_id = ?").all(req.params.id);
  for (const post of posts) {
    deletePostImage(post);
    db.prepare("DELETE FROM comments WHERE post_id = ?").run(post.id);
  }
  db.prepare("DELETE FROM posts WHERE poster_id = ?").run(req.params.id);
  db.prepare("DELETE FROM sessions WHERE poster_id = ?").run(req.params.id);
  db.prepare("DELETE FROM posters WHERE id = ?").run(req.params.id);
  res.json({});
});

app.delete("/api/admin/posts/:id", (req, res) => {
  deletePostImage(db.prepare("SELECT image FROM posts WHERE id = ?").get(req.params.id));
  db.prepare("DELETE FROM comments WHERE post_id = ?").run(req.params.id);
  db.prepare("DELETE FROM posts WHERE id = ?").run(req.params.id);
  res.json({});
});

app.delete("/api/admin/comments/:id", (req, res) => {
  db.prepare("DELETE FROM comments WHERE id = ?").run(req.params.id);
  res.json({});
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
