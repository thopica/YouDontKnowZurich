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
  if (!$("result-banner").classList.contains("hidden")) return; // result showing
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

  initMap();
  showScreen("game");
  loadRound();
}

function loadRound() {
  const fountain = state.fountains[state.round];

  // Reset UI
  clearMapOverlays();
  $("btn-confirm").disabled = true;
  $("result-banner").classList.add("hidden");
  $("fountain-name-overlay").classList.add("hidden");

  // Reset map view
  state.map.setView(ZURICH_CENTER, ZURICH_ZOOM);

  // Update header
  $("round-current").textContent = state.round + 1;

  // Load image
  const img = $("fountain-img");
  img.style.opacity = "0";
  img.src = fountain.imageUrl;
  img.onload = () => { img.style.opacity = "1"; };
  // Two-stage fallback: Special:FilePath redirect → placeholder SVG
  let fallbackTried = false;
  img.onerror = () => {
    if (!fallbackTried && fountain.imageCredit) {
      fallbackTried = true;
      img.src = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(fountain.imageCredit)}?width=800`;
      return;
    }
    // Show inline SVG placeholder so the panel isn't blank
    img.src =
      "data:image/svg+xml," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">` +
        `<rect width="800" height="600" fill="#1e293b"/>` +
        `<text x="400" y="270" font-family="sans-serif" font-size="64" fill="#334155" text-anchor="middle">🪣</text>` +
        `<text x="400" y="340" font-family="sans-serif" font-size="18" fill="#64748b" text-anchor="middle">Photo not available</text>` +
        `<text x="400" y="370" font-family="sans-serif" font-size="14" fill="#475569" text-anchor="middle">${fountain.name}</text>` +
        `</svg>`
      );
    img.style.opacity = "1";
  };

  // Photo credit
  $("photo-credit").innerHTML =
    `Photo: <a href="${fountain.imagePage}" target="_blank" rel="noopener">${fountain.imageCredit}</a> · Wikimedia Commons`;
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

  // Show fountain name overlay
  $("fountain-name-overlay").textContent = fountain.name;
  $("fountain-name-overlay").classList.remove("hidden");

  // Populate result banner
  $("result-distance").textContent = `📍 ${formatDist(distM)} away`;
  $("result-score").textContent = `+${score.toLocaleString()} pts`;

  const details = [
    fountain.district && `District: ${fountain.district}`,
    fountain.year && `Built: ${fountain.year}`,
    fountain.architect && `By: ${fountain.architect}`,
    fountain.waterType && `Water: ${fountain.waterType}`,
  ].filter(Boolean);
  $("result-details").innerHTML = details.join(" · ") || "";

  const isLast = state.round === ROUNDS - 1;
  $("btn-next-label").textContent = isLast ? "See results →" : "Next fountain →";

  $("result-banner").classList.remove("hidden");
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
