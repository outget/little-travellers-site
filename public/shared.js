// Used by both pages.

// Shown on paused items that don't have their own message.
const PAUSED_MESSAGE = "paused";

// How long a timer has been going, as "2mo 5d 03h 14m 09s".
// A paused timer is measured up to the moment it was paused, so it stays frozen.
function elapsed(timer) {
  const start = new Date(timer.started_at);
  const end = new Date(timer.paused_at ?? Date.now());

  // Months have different lengths, so count whole months on the calendar first...
  let months = 0;
  while (addMonths(start, months + 1) <= end) months++;

  // ...then split what's left into days, hours, minutes, seconds.
  // (Math.max: a start date in the future shows zeros until it arrives.)
  let seconds = Math.max(
    0,
    Math.floor((end - addMonths(start, months)) / 1000),
  );
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;

  const pad = (n) => String(n).padStart(2, "0");
  return `${months}mo ${days}d ${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}

function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

// The message line under a name:
//   paused   -> "⏸ " + its message, or the standard one if it has none
//   running  -> its message, or nothing
function messageHtml(timer) {
  let text = timer.message || "";
  if (timer.paused_at)
    text = "⏸ " + PAUSED_MESSAGE + (timer.message ? " · " + timer.message : "");
  return text ? `<div class="message">${esc(text)}</div>` : "";
}

// Makes text safe to put inside HTML (so a name like "<b>" shows as text, not markup).
function esc(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

// Every second, update each time cell (cells have id="time-<timer id>").
function tick(timers) {
  for (const t of timers) {
    const cell = document.getElementById("time-" + t.id);
    if (cell) cell.textContent = elapsed(t);
  }
}
