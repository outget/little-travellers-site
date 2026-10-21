// A small 2048: slide tiles with the arrow keys (after clicking the board) or by swiping.
// The game runs in the browser; the best score is kept in localStorage and sent to the
// server for the leaderboard. Uses esc() from shared.js.

(() => {
    const SIZE = 4;
    const board = document.getElementById("g2048-board");
    const scoreEl = document.getElementById("g2048-score");
    const bestEl = document.getElementById("g2048-best");
    const statusEl = document.getElementById("g2048-status");

    let cells; // SIZE*SIZE numbers, 0 = empty, read row by row
    let score;
    let won; // already told them they reached 2048, so let them keep going quietly
    let best = Number(localStorage.getItem("g2048-best")) || 0;
    let fresh = -1; // index of the newest tile, so it can pop in

    function newGame() {
        cells = Array(SIZE * SIZE).fill(0);
        score = 0;
        won = false;
        addTile();
        addTile();
        render("");
    }

    // Put a 2 (or sometimes a 4) in a random empty cell
    function addTile() {
        const empty = cells.flatMap((v, i) => (v ? [] : [i]));
        fresh = empty[Math.floor(Math.random() * empty.length)];
        cells[fresh] = Math.random() < 0.9 ? 2 : 4;
    }

    // The cell indexes of each row/column, ordered so the first one is the
    // side the tiles slide towards
    function lines(dir) {
        const out = [];
        for (let a = 0; a < SIZE; a++) {
            const line = [];
            for (let b = 0; b < SIZE; b++) {
                if (dir === "left") line.push(a * SIZE + b);
                if (dir === "right") line.push(a * SIZE + (SIZE - 1 - b));
                if (dir === "up") line.push(b * SIZE + a);
                if (dir === "down") line.push((SIZE - 1 - b) * SIZE + a);
            }
            out.push(line);
        }
        return out;
    }

    // Slide every line towards dir, merging equal neighbours once each.
    // Returns whether anything moved.
    function move(dir) {
        let moved = false;
        for (const line of lines(dir)) {
            const values = line.map((i) => cells[i]).filter(Boolean);
            const merged = [];
            for (let k = 0; k < values.length; k++) {
                if (values[k] === values[k + 1]) {
                    merged.push(values[k] * 2);
                    score += values[k] * 2;
                    k++; // the partner tile is used up
                } else merged.push(values[k]);
            }
            line.forEach((i, k) => {
                const v = merged[k] || 0;
                if (cells[i] !== v) moved = true;
                cells[i] = v;
            });
        }
        return moved;
    }

    function canMove() {
        for (let i = 0; i < cells.length; i++) {
            if (!cells[i]) return true;
            const right = i % SIZE < SIZE - 1 && cells[i] === cells[i + 1];
            const below = i + SIZE < cells.length && cells[i] === cells[i + SIZE];
            if (right || below) return true;
        }
        return false;
    }

    function play(dir) {
        if (!canMove() || !move(dir)) return;
        addTile();
        if (score > best) {
            best = score;
            localStorage.setItem("g2048-best", best);
            sendBestSoon();
        }
        let status = "";
        if (!won && cells.includes(2048)) {
            won = true;
            status = "2048! keep going if you like";
        }
        if (!canMove()) {
            status = "no moves left";
            sendBest(); // don't wait: they may leave now
        }
        render(status);
    }

    function render(status) {
        board.innerHTML = cells
            .map(
                (v, i) =>
                    `<div class="tile${i === fresh ? " new" : ""}" data-v="${Math.min(v, 4096)}">${v || ""}</div>`,
            )
            .join("");
        scoreEl.textContent = score;
        bestEl.textContent = best;
        if (status) statusEl.textContent = status;
        else if (!won) statusEl.textContent = "";
    }

    // Arrow keys / WASD, only while the board has focus so the page can still scroll
    const KEYS = {
        ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
        a: "left", d: "right", w: "up", s: "down",
    };
    board.addEventListener("keydown", (e) => {
        const dir = KEYS[e.key];
        if (!dir) return;
        e.preventDefault(); // don't scroll the page
        play(dir);
    });

    // Swipes on phones. Copy the start position into plain numbers: Safari keeps
    // updating the same Touch object as the finger moves, so saving the object itself
    // would make the start and end positions identical.
    let touchStart = null;
    board.addEventListener("touchstart", (e) => {
        touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: true });
    // Stop the page scrolling or bouncing while swiping on the board
    board.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
    board.addEventListener("touchend", (e) => {
        if (!touchStart) return;
        const dx = e.changedTouches[0].clientX - touchStart.x;
        const dy = e.changedTouches[0].clientY - touchStart.y;
        touchStart = null;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 30) return; // a tap, not a swipe
        if (Math.abs(dx) > Math.abs(dy)) play(dx > 0 ? "right" : "left");
        else play(dy > 0 ? "down" : "up");
    });

    document.getElementById("g2048-new").addEventListener("click", () => {
        newGame();
        board.focus();
    });

    // ---------- leaderboard ----------

    const leaderboardEl = document.getElementById("g2048-leaderboard");
    let sendTimer = null;

    function drawLeaderboard(rows) {
        leaderboardEl.innerHTML =
            rows
                .map(
                    (r) => `
              <li>
                <span class="lb-name">${
                    r.poster_id
                        ? `<a class="author" href="/diary/${encodeURIComponent(r.name)}">${esc(r.name)}</a>`
                        : esc(r.name)
                }</span>
                <span class="lb-score">${r.score.toLocaleString()}</span>
              </li>`,
                )
                .join("") || `<li class="board-empty">no scores yet</li>`;
    }

    async function loadLeaderboard() {
        drawLeaderboard(await (await fetch("/api/2048/leaderboard")).json());
    }

    // Send the best score; the server keeps whichever is higher. The name is the one
    // remembered from the message board, or the diary writer's own when logged in.
    async function sendBest() {
        clearTimeout(sendTimer);
        if (!best) return;
        const session = localStorage.getItem("session");
        const res = await fetch("/api/2048/score", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(session ? { "X-Session": session } : {}),
            },
            body: JSON.stringify({ score: best, name: localStorage.getItem("name") || "" }),
        });
        if (res.ok) drawLeaderboard(await res.json());
    }

    // While a new best keeps climbing, send it once things settle for a few seconds
    function sendBestSoon() {
        clearTimeout(sendTimer);
        sendTimer = setTimeout(sendBest, 3000);
    }

    newGame();
    if (best) sendBest(); // a best from before the leaderboard existed
    else loadLeaderboard();
    setInterval(loadLeaderboard, 60000);
})();
