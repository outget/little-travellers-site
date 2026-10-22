// One card per place, like YoshiTracker's "Environment at Valve HQ": weather, air,
// birds, local time and the moon. The server gathers the data (/api/areas);
// this draws it. Uses esc() from shared.js.

(() => {
    const el = document.getElementById("areas");
    let areas = [];

    // Open-Meteo weather codes -> words and an icon (day / night)
    function weather(code, isDay) {
        if (code === 0) return ["Clear", isDay ? "☀️" : "🌙"];
        if (code === 1) return ["Mostly clear", isDay ? "🌤️" : "🌙"];
        if (code === 2) return ["Partly cloudy", isDay ? "⛅" : "☁️"];
        if (code === 3) return ["Overcast", "☁️"];
        if (code <= 48) return ["Fog", "🌫️"];
        if (code <= 57) return ["Drizzle", "🌦️"];
        if (code <= 67) return ["Rain", "🌧️"];
        if (code <= 77) return ["Snow", "🌨️"];
        if (code <= 82) return ["Showers", "🌦️"];
        if (code <= 86) return ["Snow showers", "🌨️"];
        return ["Thunderstorm", "⛈️"];
    }

    // European air quality index bands, with a colour for the dot
    function airQuality(aqi) {
        if (aqi <= 20) return ["Good", "var(--green)"];
        if (aqi <= 40) return ["Fair", "#8ec07c"];
        if (aqi <= 60) return ["Moderate", "var(--yellow)"];
        if (aqi <= 80) return ["Poor", "#fe8019"];
        if (aqi <= 100) return ["Very poor", "var(--red)"];
        return ["Extremely poor", "#d3869b"];
    }

    const humidityWord = (h) => (h < 30 ? "Dry" : h < 60 ? "Comfortable" : h < 80 ? "Humid" : "Very humid");
    const windWord = (w) =>
        w < 6 ? "Calm" : w < 20 ? "Light breeze" : w < 39 ? "Breezy" : w < 62 ? "Windy" : "Stormy";
    const cloudWord = (c) =>
        c < 20 ? "Clear skies" : c < 50 ? "Some clouds" : c < 85 ? "Mostly cloudy" : "Overcast";

    // The moon is the same everywhere: work out its phase from a known new moon
    function moon() {
        const SYNODIC = 29.530588853; // days from one new moon to the next
        const knownNew = Date.UTC(2000, 0, 6, 18, 14);
        const age = ((((Date.now() - knownNew) / 864e5) % SYNODIC) + SYNODIC) % SYNODIC;
        const lit = Math.round(((1 - Math.cos((2 * Math.PI * age) / SYNODIC)) / 2) * 100);
        const phases = [
            ["New moon", "🌑"],
            ["Waxing crescent", "🌒"],
            ["First quarter", "🌓"],
            ["Waxing gibbous", "🌔"],
            ["Full moon", "🌕"],
            ["Waning gibbous", "🌖"],
            ["Last quarter", "🌗"],
            ["Waning crescent", "🌘"],
        ];
        const [name, icon] = phases[Math.round((age / SYNODIC) * 8) % 8];
        return { lit, name, icon };
    }

    // One line: icon, big number, small unit, then a word or two
    const row = (icon, value, unit, label, sub = "") => `
        <div class="env-row">
          <span class="env-icon">${icon}</span>
          <span><b class="env-v">${value}</b><span class="u">${unit}</span></span>
          <span class="env-label">${label}${sub ? `<div class="env-sub">${sub}</div>` : ""}</span>
        </div>`;

    function cardHtml(a) {
        const parts = [];
        if (a.temp != null) {
            const [word, icon] = weather(a.code, a.isDay);
            parts.push(row(icon, Math.round(a.temp), "°C", word));
            const [airWord, airColour] = airQuality(a.aqi);
            parts.push(`<div class="env-pair">
              ${a.aqi != null ? row(`<span class="aqi-dot" style="background:${airColour}"></span>`, Math.round(a.aqi), "AQI", airWord) : ""}
              ${row("💧", Math.round(a.humidity), "%RH", humidityWord(a.humidity))}
            </div>`);
            parts.push(`<div class="env-pair">
              ${row("🍃", Math.round(a.wind), "km/h", windWord(a.wind))}
              ${row("🌡️", Math.round(a.pressure), "hPa", a.pressureTrend)}
            </div>`);
            parts.push(
                row("☁️", Math.round(a.cloud), "% cloud", `${cloudWord(a.cloud)} · ${Math.round(a.visibility / 1000)} km`),
            );
        } else {
            parts.push(`<p class="board-empty">weather unavailable right now</p>`);
        }
        if (a.birds) {
            const last = a.birds.last;
            parts.push(
                row(
                    "🐦",
                    a.birds.count,
                    "/wk",
                    "bird sightings",
                    last ? `last seen: ${esc(last.species)}${last.place ? ` · ${esc(last.place)}` : ""}` : "",
                ),
            );
        }
        if (a.timezone) {
            const time = (t) =>
                new Date(t).toLocaleTimeString("en-GB", { timeZone: a.timezone, hour: "2-digit", minute: "2-digit" });
            const day = new Date().toLocaleDateString("en-GB", { timeZone: a.timezone, weekday: "short" });
            const sun = a.sun ? ` · ${a.sun.type} since ${time(a.sun.at)}` : "";
            parts.push(`
              <div class="env-row">
                <span class="env-icon">${a.sun?.type === "dark" ? "🌙" : "☀️"}</span>
                <b class="env-v">${time(Date.now())}</b>
                <span class="env-label">${day}${sun}</span>
              </div>`);
        }
        const m = moon();
        parts.push(row(m.icon, m.lit, "%", m.name));

        return `
          <div class="card env">
            <h2>${esc(a.name)} <span class="env-where">${esc(a.where)}</span></h2>
            ${parts.join("")}
          </div>`;
    }

    function draw() {
        el.innerHTML = areas.map(cardHtml).join("");
    }

    async function load() {
        const res = await fetch("/api/areas");
        if (!res.ok) return;
        areas = await res.json();
        draw();
    }

    load();
    setInterval(load, 10 * 60 * 1000); // the server refreshes its data every 10 minutes
    setInterval(draw, 30 * 1000); // keep the local times current
})();
