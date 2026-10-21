// Message board: shows the latest messages, lets a visitor post once a day,
// and shows a countdown until they can post again. Uses esc() from shared.js.

(() => {
    const form = document.getElementById("board-form");
    const wait = document.getElementById("board-wait");
    const error = document.getElementById("board-error");
    let nextPostAt = 0; // from the server: when this visitor can post again (0 = now)
    const session = localStorage.getItem("session"); // set when a diary writer logs in
    const sessionHeader = session ? { "X-Session": session } : {};

    // Draw what the server sent back (every board route answers in this shape)
    function show(data) {
        if (data.nextPostAt !== undefined) nextPostAt = data.nextPostAt;
        document.getElementById("board-list").innerHTML = data.messages.length
            ? data.messages
                  .map(
                      (m) => `
                <div class="board-msg">
                  <div class="board-meta">${authorHtml(m)} · ${ago(m.created_at)}</div>
                  <div class="board-text">${esc(m.text)}</div>
                </div>`,
                  )
                  .join("")
            : `<div class="empty"><span class="doge" aria-hidden="true"></span>wow, such empty</div>`;
        countdown();
    }

    // Diary writers' names link to their diary
    function authorHtml(m) {
        return m.poster_id
            ? `<a class="author" href="/diary/${encodeURIComponent(m.name)}"><b>${esc(m.name)}</b></a>`
            : `<b>${esc(m.name)}</b>`;
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
        const res = await fetch("/api/messages", { headers: sessionHeader });
        show(await res.json());
    }

    form.onsubmit = async (e) => {
        e.preventDefault(); // stop the browser reloading the page
        error.textContent = "";
        // remembered for next time (diary comments use the same name)
        if (!document.getElementById("board-name").hidden)
            localStorage.setItem("name", document.getElementById("board-name").value);
        const res = await fetch("/api/messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...sessionHeader },
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

    // A logged-in diary writer posts as themselves: no name field
    async function checkLogin() {
        const nameField = document.getElementById("board-name");
        nameField.value = localStorage.getItem("name") || "";
        if (!session) return;
        const res = await fetch("/api/me", { headers: sessionHeader });
        if (!res.ok) return;
        nameField.hidden = true;
        nameField.required = false;
        document.getElementById("board-as").hidden = false;
        document.getElementById("board-as-name").textContent = (await res.json()).username;
    }

    checkLogin();
    load();
    setInterval(load, 15000); // pick up other people's messages
    setInterval(countdown, 1000);
})();
