import L from "leaflet";
import "leaflet/dist/leaflet.css";
import fountainsData from "./data/fountains.json";

// ─── Constants ────────────────────────────────────────────────────────────────

const ROUNDS = 5;
const MAX_SCORE_PER_ROUND = 5000;
const SCORE_DECAY = 2; // points lost per meter of distance

// Zürich bounding box for map initial view
const ZURICH_CENTER = [47.378, 8.538];
const ZURICH_ZOOM = 13;

// ─── Game State ───────────────────────────────────────────────────────────────

let state = {
  fountains: [],      // shuffled subset for this game
  round: 0,           // 0-indexed current round
  scores: [],         // score per round
  guessMarker: null,
  actualMarker: null,
  resultLine: null,
  map: null,
  guessLatLng: null,  // latest click position
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const screens = {
  start: $("screen-start"),
  game:  $("screen-game"),
  end:   $("screen-end"),
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calcScore(meters) {
  return Math.max(0, Math.round(MAX_SCORE_PER_ROUND - meters * SCORE_DECAY));
}

function formatDist(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

/** Fisher-Yates shuffle */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function rank(total) {
  if (total >= 22000) return "🏆 Zürich Expert";
  if (total >= 16000) return "🥇 Fountain Connoisseur";
  if (total >= 10000) return "🥈 Local Explorer";
  if (total >= 5000)  return "🥉 Tourist";
  return "🗺️ Completely Lost";
}

// ─── Screen management ────────────────────────────────────────────────────────

function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => {
    el.classList.toggle("active", k === name);
  });
}

// ─── Map setup ────────────────────────────────────────────────────────────────

function initMap() {
  if (state.map) return;

  state.map = L.map("map", {
    center: ZURICH_CENTER,
    zoom: ZURICH_ZOOM,
    zoomControl: true,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(state.map);

  state.map.on("click", onMapClick);
}

function divIcon(className) {
  return L.divIcon({ className, iconSize: [20, 20], iconAnchor: [10, 10] });
}

function clearMapOverlays() {
  state.guessMarker?.remove();
  state.actualMarker?.remove();
  state.resultLine?.remove();
  state.guessMarker = null;
  state.actualMarker = null;
  state.resultLine = null;
  state.guessLatLng = null;
}

// ─── Map interaction ──────────────────────────────────────────────────────────

function onMapClick(e) {
  if (!$("result-view").classList.contains("hidden")) return; // result showing
  if (state.round >= ROUNDS) return;

  state.guessLatLng = e.latlng;

  if (state.guessMarker) {
    state.guessMarker.setLatLng(e.latlng);
  } else {
    state.guessMarker = L.marker(e.latlng, { icon: divIcon("guess-marker-icon") }).addTo(state.map);
  }

  $("btn-confirm").disabled = false;
}

// ─── Round flow ───────────────────────────────────────────────────────────────

function startGame() {
  state.fountains = shuffle(fountainsData).slice(0, ROUNDS);
  state.round = 0;
  state.scores = [];
  $("score-running").textContent = "0";
  $("round-total").textContent = ROUNDS;

  showScreen("game");
  initMap();
  // Leaflet needs the container to be visible before it can measure dimensions
  state.map.invalidateSize();
  loadRound();
}

// ─── Image helpers ────────────────────────────────────────────────────────────

/**
 * Returns true if the image at the given URL appears to be a colour photo.
 * Loads the image into a small canvas and checks whether the average HSV
 * saturation across sampled pixels exceeds a low threshold.  B&W / sepia
 * images have saturation near 0; colour photos are typically well above 5 %.
 * Falls back to true (assume colour) on any CORS / load error.
 */
function isColorImage(imageUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const SIZE = 50;
        const canvas = document.createElement("canvas");
        canvas.width = SIZE;
        canvas.height = SIZE;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, SIZE, SIZE);
        const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
        let totalSat = 0;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i] / 255;
          const g = data[i + 1] / 255;
          const b = data[i + 2] / 255;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          totalSat += max === 0 ? 0 : (max - min) / max;
          n++;
        }
        resolve(n > 0 && (totalSat / n) > 0.05);
      } catch (_) {
        resolve(true); // canvas blocked by CORS — assume colour
      }
    };
    img.onerror = () => resolve(true); // can't load to check — assume colour, let display handle it
    img.src = imageUrl;
  });
}

/**
 * Geosearch fallback: asks Wikimedia Commons for files tagged within 100 m
 * of the fountain's coordinates, then returns the first colour result.
 */
async function fetchByGeosearch(lat, lng) {
  const geoParams = new URLSearchParams({
    action: "query",
    list: "geosearch",
    gscoord: `${lat}|${lng}`,
    gsradius: "100",
    gsnamespace: "6",
    gslimit: "10",
    format: "json",
    origin: "*",
  });

  const geoRes = await fetch(`https://commons.wikimedia.org/w/api.php?${geoParams}`);
  if (!geoRes.ok) return null;
  const geoData = await geoRes.json();
  const titles = (geoData.query?.geosearch ?? []).map((r) => r.title);
  if (!titles.length) return null;

  const infoParams = new URLSearchParams({
    action: "query",
    titles: titles.join("|"),
    prop: "imageinfo",
    iiprop: "url|mime|size",
    iiurlwidth: "800",
    format: "json",
    origin: "*",
  });

  const infoRes = await fetch(`https://commons.wikimedia.org/w/api.php?${infoParams}`);
  if (!infoRes.ok) return null;
  const infoData = await infoRes.json();

  const fountainKeywords = /brunnen|fountain/i;
  for (const page of Object.values(infoData.query?.pages ?? {})) {
    if (!fountainKeywords.test(page.title)) continue; // skip non-fountain photos
    const info = page.imageinfo?.[0];
    if (!info?.mime?.startsWith("image/")) continue;
    if (info.size < 50000) continue;
    const thumbUrl = info.thumburl || info.url;
    if (!(await isColorImage(thumbUrl))) continue;
    return {
      thumbUrl,
      fileTitle: page.title.replace("File:", ""),
      pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
    };
  }
  return null;
}

/**
 * Option E: use the pre-stored imageUrl from fountains.json directly (fast,
 * no API call needed).  If that URL is missing, fails to load, or turns out
 * to be a B&W / greyscale photo, fall back to a coordinate-based geosearch
 * that only returns colour images.
 *
 * Returns { thumbUrl, fileTitle, pageUrl } or null.
 */
async function getImage(fountain) {
  // Primary: stored URL
  if (fountain.imageUrl) {
    const color = await isColorImage(fountain.imageUrl);
    if (color) {
      return {
        thumbUrl: fountain.imageUrl,
        fileTitle: fountain.imageCredit || fountain.name,
        pageUrl: fountain.imagePage || "https://commons.wikimedia.org/",
      };
    }
  }

  // Fallback: geosearch within 100 m, colour only
  try {
    return await fetchByGeosearch(fountain.lat, fountain.lng);
  } catch (_) {
    return null;
  }
}

function loadRound() {
  const fountain = state.fountains[state.round];

  // Reset UI
  clearMapOverlays();
  $("btn-confirm").disabled = true;
  $("result-view").classList.add("hidden");
  $("photo-view").classList.remove("hidden");

  // Reset map view
  state.map.setView(ZURICH_CENTER, ZURICH_ZOOM);

  // Update header
  $("round-current").textContent = state.round + 1;

  // Load image — query Wikimedia Commons API for a real photo
  const img = $("fountain-img");
  const credit = $("photo-credit");
  img.style.opacity = "0";
  img.src = "";
  credit.textContent = "Loading photo…";

  getImage(fountain).then((result) => {
    if (result) {
      img.onload = () => { img.style.opacity = "1"; };
      img.onerror = () => { img.style.opacity = "1"; }; // show broken icon rather than nothing
      img.src = result.thumbUrl;
      // Store resolved image info back on the fountain for the result view
      fountain._resolvedImage = result;
      credit.innerHTML =
        `Photo: <a href="${result.pageUrl}" target="_blank" rel="noopener">${result.fileTitle}</a> · Wikimedia Commons`;
    } else {
      // Fallback: SVG placeholder
      img.src =
        "data:image/svg+xml," +
        encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">` +
          `<rect width="800" height="600" fill="#1e293b"/>` +
          `<text x="400" y="280" font-family="sans-serif" font-size="56" fill="#334155" text-anchor="middle">🪣</text>` +
          `<text x="400" y="345" font-family="sans-serif" font-size="18" fill="#64748b" text-anchor="middle">No photo found</text>` +
          `</svg>`
        );
      img.style.opacity = "1";
      credit.textContent = "Photo not available";
    }
  });
}

function confirmGuess() {
  if (!state.guessLatLng) return;

  const fountain = state.fountains[state.round];
  const { lat, lng } = state.guessLatLng;
  const distM = haversineMeters(lat, lng, fountain.lat, fountain.lng);
  const score = calcScore(distM);

  state.scores.push(score);

  // Show actual location
  const actualLL = [fountain.lat, fountain.lng];
  state.actualMarker = L.marker(actualLL, { icon: divIcon("actual-marker-icon") })
    .bindPopup(`<strong>${fountain.name}</strong>`)
    .addTo(state.map)
    .openPopup();

  // Draw line
  state.resultLine = L.polyline([state.guessLatLng, actualLL], {
    color: "#94a3b8",
    weight: 2,
    dashArray: "6 4",
  }).addTo(state.map);

  // Fit map to show both points
  state.map.fitBounds(
    L.latLngBounds([state.guessLatLng, actualLL]).pad(0.3),
    { maxZoom: 16 }
  );

  // Update running score
  const totalSoFar = state.scores.reduce((a, b) => a + b, 0);
  $("score-running").textContent = totalSoFar.toLocaleString();

  // Swap photo → result in the left panel (map stays fully visible)
  $("photo-view").classList.add("hidden");

  $("result-distance").textContent = `📍 ${formatDist(distM)} away`;
  $("result-score").textContent = `+${score.toLocaleString()} pts`;
  $("result-name").textContent = fountain.name;

  const details = [
    fountain.district && `District: ${fountain.district}`,
    fountain.year && `Built: ${fountain.year}`,
    fountain.architect && `By: ${fountain.architect}`,
    fountain.waterType && `Water: ${fountain.waterType}`,
  ].filter(Boolean);
  $("result-details").innerHTML = details.join(" · ") || "";

  const isLast = state.round === ROUNDS - 1;
  $("btn-next-label").textContent = isLast ? "See results →" : "Next fountain →";

  $("result-view").classList.remove("hidden");
  $("btn-confirm").disabled = true;
}

function nextRound() {
  state.round++;

  if (state.round >= ROUNDS) {
    showEndScreen();
  } else {
    loadRound();
  }
}

// ─── End screen ───────────────────────────────────────────────────────────────

function showEndScreen() {
  const total = state.scores.reduce((a, b) => a + b, 0);

  $("final-score").textContent = total.toLocaleString();
  $("final-rank").textContent = rank(total);

  const breakdown = $("round-breakdown");
  breakdown.innerHTML = "";
  state.fountains.forEach((f, i) => {
    const row = document.createElement("div");
    row.className = "breakdown-row";
    row.innerHTML = `
      <span class="bd-name">${f.name}</span>
      <span class="bd-score">${(state.scores[i] ?? 0).toLocaleString()} pts</span>
    `;
    breakdown.appendChild(row);
  });

  showScreen("end");
}

// ─── Event listeners ──────────────────────────────────────────────────────────

$("btn-start").addEventListener("click", startGame);
$("btn-confirm").addEventListener("click", confirmGuess);
$("btn-next").addEventListener("click", nextRound);
$("btn-play-again").addEventListener("click", startGame);
