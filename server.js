import express from "express";
import { DatabaseSync } from "node:sqlite"; // SQLite is built into Node, nothing to install

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
    message    TEXT               -- shown while paused
  )
`);

const allTimers = () => db.prepare("SELECT * FROM timers ORDER BY id").all();

const app = express();
app.use(express.json());                                 // read JSON request bodies into req.body
app.use(express.static("public", { extensions: ["html"] })); // serve the pages; /admin -> admin.html

// ---------- public ----------

app.get("/api/timers", (req, res) => {
  res.json(allTimers());
});

// ---------- admin: every route below needs the password ----------

app.use("/api/admin", (req, res, next) => {
  if (req.get("X-Password") !== PASSWORD) return res.status(401).json({ error: "Wrong password" });
  next();
});

app.get("/api/admin/timers", (req, res) => {
  res.json(allTimers());
});

// Add: starts from the date given, or from now if none was picked
app.post("/api/admin/timers", (req, res) => {
  db.prepare("INSERT INTO timers (name, started_at) VALUES (?, ?)")
    .run(req.body.name, req.body.started_at ?? Date.now());
  res.json(allTimers());
});

// Set date: count up from a specific moment
app.post("/api/admin/timers/:id/start", (req, res) => {
  db.prepare("UPDATE timers SET started_at = ? WHERE id = ?").run(req.body.started_at, req.params.id);
  res.json(allTimers());
});

app.patch("/api/admin/timers/:id", (req, res) => {
  db.prepare("UPDATE timers SET name = ? WHERE id = ?").run(req.body.name, req.params.id);
  res.json(allTimers());
});

// Reset: start counting from now again (and un-pause)
app.post("/api/admin/timers/:id/reset", (req, res) => {
  db.prepare("UPDATE timers SET started_at = ?, paused_at = NULL, message = NULL WHERE id = ?")
    .run(Date.now(), req.params.id);
  res.json(allTimers());
});

app.post("/api/admin/timers/:id/pause", (req, res) => {
  db.prepare("UPDATE timers SET paused_at = ?, message = ? WHERE id = ? AND paused_at IS NULL")
    .run(Date.now(), req.body.message, req.params.id);
  res.json(allTimers());
});

// Resume: move the start forward by however long it was paused, so it carries on where it stopped
app.post("/api/admin/timers/:id/resume", (req, res) => {
  db.prepare(`UPDATE timers SET started_at = started_at + (? - paused_at), paused_at = NULL, message = NULL
              WHERE id = ? AND paused_at IS NOT NULL`)
    .run(Date.now(), req.params.id);
  res.json(allTimers());
});

app.delete("/api/admin/timers/:id", (req, res) => {
  db.prepare("DELETE FROM timers WHERE id = ?").run(req.params.id);
  res.json(allTimers());
});

app.listen(3000, () => console.log("Running on http://localhost:3000"));
