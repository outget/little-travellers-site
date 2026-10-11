# Count-up

A public page with a list of names, each with a live count-up, and an admin page (`/admin`) to add, rename, reset, pause and delete them.

## The files

| File | What it does |
|---|---|
| `server.js` | The whole backend: creates the database table, serves the pages, and has one route per admin action. |
| `public/index.html` | The public page. Fetches the list, redraws it every 15 s, ticks the clocks every second. |
| `public/admin.html` | The admin page. Same table plus buttons; each button calls one server route. |
| `public/shared.js` | The count-up maths (`elapsed`) and the once-a-second clock update, used by both pages. |
| `public/style.css` | All the styling. |
| `Dockerfile`, `docker-compose.yml` | How to run it on your server. |

## The one idea everything rests on

A timer doesn't store a number that goes up. It stores **when it started** (`started_at`). The elapsed time is just *now − started_at*, which every browser works out by itself each second. So:

- **Reset** = set `started_at` to now.
- **Set date** (or picking a date when adding) = set `started_at` to that date instead.
- **Pause** = remember *when* it was paused (`paused_at`). Elapsed becomes *paused_at − started_at*, which doesn't change, so it looks frozen.
- **Resume** = push `started_at` forward by the length of the pause, and clear `paused_at`.

The server only gets involved when an admin changes something.

## Admin password

Every admin request sends the password in an `X-Password` header, and the server checks it before doing anything (the `app.use("/api/admin", ...)` block in `server.js`). The admin page remembers it in your browser after the first login. Caddy serves everything over HTTPS, so the password isn't sent in the clear.

## Try it on your own computer

Needs Node 22.13 or newer.

```bash
npm install
ADMIN_PASSWORD=test node server.js
```

Open http://localhost:3000 and http://localhost:3000/admin.

## Put it on your server

1. **DNS:** add an `A` record for a new subdomain (e.g. `count.yourdomain.com`) pointing at your server, like your existing one.

2. **Copy the folder** to the server and set your password in `docker-compose.yml`.

3. **Start it:**
   ```bash
   docker compose up -d --build
   ```

4. **Add it to your Caddyfile.** This depends on how your Caddy runs; check with `docker ps`:

   - **Caddy installed directly on the server** (not in `docker ps`):
     ```
     count.yourdomain.com {
         reverse_proxy localhost:3000
     }
     ```
     then `sudo systemctl reload caddy`.

   - **Caddy running in Docker** (shows up in `docker ps`): from inside its container, `localhost` means the Caddy container itself, so it can't see port 3000 on the server. Instead, put both on the same Docker network. Find Caddy's network name with `docker network ls`, then replace the `ports:` lines in `docker-compose.yml` with:
     ```yaml
         networks: [caddy]
     networks:
       caddy:
         external: true
         name: <caddy's network name>
     ```
     and in the Caddyfile use the service name instead of localhost:
     ```
     count.yourdomain.com {
         reverse_proxy countup:3000
     }
     ```
     then `docker compose up -d` here, and reload Caddy (`docker exec <caddy container> caddy reload --config /etc/caddy/Caddyfile`).

## Handy commands

```bash
docker compose logs -f          # see what the server is printing
docker compose up -d --build    # restart with your latest changes
cp data/countup.db backup.db    # back up all timers
```
