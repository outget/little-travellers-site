// Message board: shows the latest messages, lets a visitor post once a day,
// and shows a countdown until they can post again. Uses esc() from shared.js.

(() => {
    const form = document.getElementById("board-form");
    const wait = document.getElementById("board-wait");
    const error = document.getElementById("board-error");
    let nextPostAt = 0; // from the server: when this visitor can post again (0 = now)

    // Draw what the server sent back (every board route answers in this shape)
    function show(data) {
        if (data.nextPostAt !== undefined) nextPostAt = data.nextPostAt;
        document.getElementById("board-list").innerHTML = data.messages.length
            ? data.messages
                  .map(
                      (m) => `
                <div class="board-msg">
                  <div class="board-meta"><b>${esc(m.name)}</b> · ${ago(m.created_at)}</div>
                  <div class="board-text">${esc(m.text)}</div>
                </div>`,
                  )
                  .join("")
            : `<p class="board-empty">no messages yet, be the first</p>`;
        countdown();
    }

    // "just now", "5m ago", "3h ago", "2d ago"
    function ago(time) {
        const s = (Date.now() - time) / 1000;
        if (s < 60) return "just now";
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
        return `${Math.floor(s / 86400)}d ago`;
    }

    // Show the form, or "you can post again in 13h 04m 22s" while they have to wait
    function countdown() {
        const left = Math.max(0, Math.ceil((nextPostAt - Date.now()) / 1000));
        form.hidden = left > 0;
        wait.hidden = left === 0;
        if (!left) return;
        const pad = (n) => String(n).padStart(2, "0");
        const h = Math.floor(left / 3600);
        const m = Math.floor((left % 3600) / 60);
        wait.textContent = `thanks for posting! you can post again in ${h}h ${pad(m)}m ${pad(left % 60)}s`;
    }

    async function load() {
        const res = await fetch("/api/messages");
        show(await res.json());
    }

    form.onsubmit = async (e) => {
        e.preventDefault(); // stop the browser reloading the page
        error.textContent = "";
        const res = await fetch("/api/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: document.getElementById("board-name").value,
                text: document.getElementById("board-text").value,
                website: document.getElementById("board-website").value,
            }),
        });
        const data = await res.json();
        if (res.status === 400) return (error.textContent = data.error);
        // 429 = already posted today: the reply carries the countdown time
        if (res.ok) document.getElementById("board-text").value = "";
        show(data);
    };

    load();
    setInterval(load, 15000); // pick up other people's messages
    setInterval(countdown, 1000);
})();
