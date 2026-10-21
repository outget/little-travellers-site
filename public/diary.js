// A diary page, /diary/<username>. Anyone can read and comment (a name, once a day);
// the diary's owner logs in to post text and/or a photo; the admin gets delete buttons.
// Uses esc() from shared.js.

(() => {
    const owner = decodeURIComponent(location.pathname.split("/")[2] || "");
    let session = localStorage.getItem("session"); // poster login token
    const adminPassword = localStorage.getItem("password"); // set by the admin page
    let me = null; // username of the logged-in poster, if any
    let posts = [];
    let nextDiaryPostAt = 0; // the owner's next diary entry (one a day)
    let openComment = null; // id of the post whose comment form is open
    let photo = null; // the shrunk photo waiting to be posted

    const $ = (id) => document.getElementById(id);
    // Sent with requests so a logged-in diary writer comments as themselves
    const sessionHeader = () => (session ? { "X-Session": session } : {});

    // ---------- loading and drawing ----------

    async function load() {
        const res = await fetch("/api/diaries/" + encodeURIComponent(owner), {
            headers: sessionHeader(),
        });
        if (res.status === 404) {
            $("diary-title").textContent = "no diary here";
            return;
        }
        const data = await res.json();
        $("diary-title").textContent = `${data.username}'s diary`;
        document.title = `${data.username}'s diary`;
        posts = data.posts;
        draw();
    }

    function draw() {
        $("no-posts").hidden = posts.length > 0;
        $("posts").innerHTML = posts.map(postHtml).join("");
        const nameField = openComment && $("comment-name-" + openComment);
        if (nameField) {
            // set here, not in the HTML: esc() doesn't escape quotes inside attributes
            nameField.value = localStorage.getItem("name") || "";
        }
        if (openComment)
            (nameField && !nameField.value ? nameField : $("comment-text-" + openComment))?.focus();
        countdown();
    }

    function postHtml(p) {
        return `
          <div class="card post">
            <div class="board-meta">${dateText(p.created_at)}</div>
            ${p.image ? `<img class="post-image" src="/uploads/${p.image}" alt="" loading="lazy" />` : ""}
            ${p.text ? `<div class="board-text">${esc(p.text)}</div>` : ""}
            ${adminPassword ? `<button class="danger" onclick="diary.deletePost(${p.id})">delete post</button>` : ""}
            <div class="comments">
              ${p.comments.map(commentHtml).join("")}
              ${commentFormHtml(p)}
            </div>
          </div>`;
    }

    function commentHtml(c) {
        return `
          <div class="comment">
            <span class="board-meta">${authorHtml(c)} · ${dateText(c.created_at)}</span>
            ${adminPassword ? `<button class="link-button danger" onclick="diary.deleteComment(${c.id})">delete</button>` : ""}
            <div class="board-text">${esc(c.text)}</div>
          </div>`;
    }

    // Diary writers' names link to their diary
    function authorHtml(c) {
        return c.poster_id
            ? `<a class="author" href="/diary/${encodeURIComponent(c.name)}"><b>${esc(c.name)}</b></a>`
            : `<b>${esc(c.name)}</b>`;
    }

    // Once a day per post: while waiting, that post shows a countdown instead of the form
    function commentFormHtml(p) {
        const id = p.id;
        if (p.nextCommentAt > Date.now())
            return `<p class="board-wait comment-wait" data-until="${p.nextCommentAt}"></p>`;
        if (openComment !== id)
            return `<button class="link-button" onclick="diary.openComments(${id})">comment</button>`;
        return `
          <form class="comment-form" onsubmit="diary.comment(event, ${id})">
            ${
                me
                    ? `<p class="posting-as">commenting as <b>${esc(me)}</b></p>`
                    : `<input id="comment-name-${id}" placeholder="name" maxlength="30" required />`
            }
            <textarea id="comment-text-${id}" placeholder="comment (one a day per post)" maxlength="500" rows="2" required></textarea>
            <input id="comment-website-${id}" class="honeypot" tabindex="-1" autocomplete="off" aria-hidden="true" />
            <button>send</button>
            <p class="board-error" id="comment-error-${id}"></p>
          </form>`;
    }

    // e.g. "21 Oct 2026, 14:05"
    function dateText(time) {
        return new Date(time).toLocaleString(undefined, {
            day: "numeric",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    }

    // "13h 04m 22s" until the given time
    function timeLeft(until) {
        const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
        const pad = (n) => String(n).padStart(2, "0");
        return `${Math.floor(left / 3600)}h ${pad(Math.floor((left % 3600) / 60))}m ${pad(left % 60)}s`;
    }

    // Ticks every second: each post's comment countdown, and the owner's post form vs.
    // its countdown. Redraws when a comment wait is over, so that "comment" button comes back.
    function countdown() {
        const waits = [...document.querySelectorAll(".comment-wait")];
        if (waits.some((w) => Number(w.dataset.until) <= Date.now())) return draw();
        for (const w of waits)
            w.textContent = `you can comment here again in ${timeLeft(Number(w.dataset.until))}`;

        const isOwner = me === owner;
        const waiting = nextDiaryPostAt > Date.now();
        $("compose").hidden = !isOwner || waiting;
        $("post-wait").hidden = !isOwner || !waiting;
        if (isOwner && waiting)
            $("post-wait").textContent = `next diary entry in ${timeLeft(nextDiaryPostAt)}`;
    }

    // ---------- comments ----------

    function openComments(id) {
        openComment = id;
        draw();
    }

    async function comment(e, id) {
        e.preventDefault();
        const name = $("comment-name-" + id)?.value; // no field when logged in as a diary writer
        if (name) localStorage.setItem("name", name); // remembered for next time (also used by the message board)
        const res = await fetch(`/api/posts/${id}/comments`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...sessionHeader() },
            body: JSON.stringify({
                name,
                text: $("comment-text-" + id).value,
                website: $("comment-website-" + id).value,
            }),
        });
        const data = await res.json();
        if (res.status === 400 || res.status === 404)
            return ($("comment-error-" + id).textContent = data.error);
        openComment = null;
        load(); // also after a 429: the reloaded diary brings the countdown time
    }

    // ---------- admin ----------

    async function adminDelete(path, question) {
        if (!confirm(question)) return;
        const res = await fetch("/api/admin/" + path, {
            method: "DELETE",
            headers: { "X-Password": adminPassword },
        });
        if (res.status === 401) return alert("Log in on the admin page first");
        load();
    }

    // ---------- posting (the diary's owner) ----------

    // Phone photos are several MB; shrink to at most 1600px and re-save as WebP
    // (JPEG where the browser can't make WebP, e.g. older Safari), usually ~200 KB.
    async function shrink(file) {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const save = (type, quality) =>
            new Promise((done) => canvas.toBlob(done, type, quality));
        const webp = await save("image/webp", 0.8);
        return webp?.type === "image/webp" ? webp : save("image/jpeg", 0.85);
    }

    $("post-image").onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        $("post-status").textContent = "shrinking photo…";
        try {
            photo = await shrink(file);
        } catch {
            photo = null;
            $("post-status").textContent = "couldn't read that photo";
            return;
        }
        $("post-preview").src = URL.createObjectURL(photo);
        $("post-preview").hidden = false;
        $("post-image-remove").hidden = false;
        $("post-status").textContent = `${Math.round(photo.size / 1024)} KB`;
    };

    function clearPhoto() {
        photo = null;
        $("post-image").value = "";
        $("post-preview").hidden = true;
        $("post-image-remove").hidden = true;
        $("post-status").textContent = "";
    }
    $("post-image-remove").onclick = clearPhoto;

    $("compose").onsubmit = async (e) => {
        e.preventDefault();
        const form = new FormData();
        form.append("text", $("post-text").value);
        if (photo) form.append("image", photo, photo.type === "image/webp" ? "photo.webp" : "photo.jpg");
        $("post-send").disabled = true;
        $("post-status").textContent = "posting…";
        const res = await fetch("/api/posts", {
            method: "POST",
            headers: { "X-Session": session },
            body: form,
        });
        $("post-send").disabled = false;
        const data = await res.json();
        if (data.nextDiaryPostAt) nextDiaryPostAt = data.nextDiaryPostAt; // also on a 429
        if (!res.ok) return ($("post-status").textContent = data.error);
        $("post-text").value = "";
        clearPhoto();
        posts = data.posts;
        draw();
    };

    // ---------- poster login ----------

    async function checkLogin() {
        me = null;
        nextDiaryPostAt = 0;
        if (session) {
            const res = await fetch("/api/me", { headers: sessionHeader() });
            if (res.ok) ({ username: me, nextDiaryPostAt } = await res.json());
            else {
                localStorage.removeItem("session"); // expired or logged out elsewhere
                session = null;
            }
        }
        $("logged-in").hidden = !me;
        $("logged-in-name").textContent = me;
        $("show-login").hidden = !!me;
        $("login").hidden = true;
        load(); // the comment limit is counted per writer when logged in, per visitor otherwise
    }

    $("show-login").onclick = () => {
        $("login").hidden = false;
        $("show-login").hidden = true;
        $("login-username").focus();
    };

    $("login").onsubmit = async (e) => {
        e.preventDefault();
        const res = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: $("login-username").value,
                password: $("login-password").value,
            }),
        });
        const data = await res.json();
        if (!res.ok) return ($("login-error").textContent = data.error);
        session = data.token;
        localStorage.setItem("session", session);
        $("login-password").value = "";
        $("login-error").textContent = "";
        // Logged in on someone else's diary: go to your own
        if (data.username !== owner) return (location.href = "/diary/" + data.username);
        checkLogin();
    };

    $("logout").onclick = async () => {
        await fetch("/api/logout", { method: "POST", headers: { "X-Session": session } });
        localStorage.removeItem("session");
        session = null;
        checkLogin();
    };

    // The buttons drawn inside posts call these
    window.diary = {
        openComments,
        comment,
        deletePost: (id) => adminDelete("posts/" + id, "Delete this post and its comments?"),
        deleteComment: (id) => adminDelete("comments/" + id, "Delete this comment?"),
    };

    checkLogin(); // also loads the diary
    setInterval(() => openComment || load(), 30000); // new comments, but not while someone is typing one
    setInterval(countdown, 1000);
})();
