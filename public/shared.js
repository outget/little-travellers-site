// Used by both pages.

// Shown on paused items that don't have their own message.
const PAUSED_MESSAGE = "paused";

// How long a timer has been going, as HTML like "20d 03h 14m 09s", with each unit
// letter in a small <span class="u"> (days are the biggest unit, so no months).
// A paused timer is measured up to the moment it was paused, so it stays frozen.
function elapsed(timer) {
  const end = timer.paused_at ?? Date.now();
  // (Math.max: a start date in the future shows zeros until it arrives.)
  let seconds = Math.max(0, Math.floor((end - timer.started_at) / 1000));
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;

  const pad = (n) => String(n).padStart(2, "0");
  const part = (n, unit) => `${n}<span class="u">${unit}</span>`;
  return [
    part(days, "d"),
    part(pad(hours), "h"),
    part(pad(minutes), "m"),
    part(pad(seconds), "s"),
  ].join(" ");
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
    if (cell) cell.innerHTML = elapsed(t);
  }
}
