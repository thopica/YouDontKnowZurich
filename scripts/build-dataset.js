#!/usr/bin/env node
/**
 * build-dataset.js
 *
 * Fetches Zurich fountain data from water-fountains.org (which aggregates
 * Wikidata + OpenStreetMap + Wikimedia Commons images), then resolves full
 * Wikimedia thumbnail URLs in batches and writes src/data/fountains.json.
 *
 * Run: node scripts/build-dataset.js
 */

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "../src/data/fountains.json");

// Bounding box covering the Zurich city area
const ZURICH_SW = "47.3229261255644,8.45960259979614";
const ZURICH_NE = "47.431119712250506,8.61940272745742";

// ─── 1. Fetch fountains from water-fountains.org ──────────────────────────────

async function fetchWaterFountains() {
  const url =
    `https://api.water-fountains.org/api/v1/fountains` +
    `?sw=${ZURICH_SW}&ne=${ZURICH_NE}`;

  console.log("Fetching fountains from water-fountains.org API…");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API fetch failed: ${res.status}`);
  const data = await res.json();
  console.log(`  → ${data.features.length} fountain features`);
  return data.features;
}

// ─── 2. Batch-fetch Wikimedia thumbnail URLs ──────────────────────────────────

async function fetchWikimediaThumbUrls(filenames) {
  const BATCH = 50;
  const map = {};
  const unique = [...new Set(filenames)];

  console.log(`Fetching Wikimedia metadata for ${unique.length} images…`);

  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    const titles = batch.map((f) => `File:${f}`).join("|");

    const params = new URLSearchParams({
      action: "query",
      titles,
      prop: "imageinfo",
      iiprop: "url|size|extmetadata",
      iiurlwidth: "800",
      format: "json",
      origin: "*",
    });

    const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`);
    if (!res.ok) throw new Error(`Wikimedia fetch failed: ${res.status}`);
    const data = await res.json();

    for (const page of Object.values(data.query?.pages ?? {})) {
      const info = page.imageinfo?.[0];
      if (!info) continue;
      if (info.size < 50000) continue; // skip icons/thumbnails

      const filename = page.title.replace("File:", "");
      const meta = info.extmetadata ?? {};
      // Strip HTML tags from artist field
      const artist = (meta.Artist?.value ?? "").replace(/<[^>]*>/g, "").trim();

      map[filename] = {
        thumbUrl: info.thumburl || info.url,
        pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
        artist: artist || filename,
      };
    }

    if (i + BATCH < unique.length) {
      await new Promise((r) => setTimeout(r, 300)); // be polite to Wikimedia
    }
  }

  console.log(`  → ${Object.keys(map).length} images resolved`);
  return map;
}

// ─── 3. Build dataset entries ─────────────────────────────────────────────────

/** The essential API response stores the image filename in props.ph.pt */
function getImageFilename(props) {
  return props.featured_image_name || props.ph?.pt || null;
}

function buildEntry(feature, id, imageMap) {
  const p = feature.properties;
  const [lng, lat] = feature.geometry.coordinates;
  const filename = getImageFilename(p);
  const img = filename ? imageMap[filename] : null;

  return {
    id: String(id),
    name: p.name_de || p.name || "Brunnen",
    location: "",
    district: "",
    stadtkreis: null,
    year: p.construction_date ?? null,
    architect: p.artist_name || null,
    material: null,
    waterType: p.water_type || null,
    fountainType: p.potable === "yes" ? "Trinkwasserbrunnen" : null,
    lat,
    lng,
    imageUrl: img?.thumbUrl ?? null,
    imageCredit: img?.artist ?? filename ?? null,
    imagePage: img?.pageUrl ?? null,
  };
}

// ─── 4. Main ─────────────────────────────────────────────────────────────────

async function main() {
  const features = await fetchWaterFountains();

  // Collect all image filenames for batch Wikimedia lookup
  const filenames = features
    .map((f) => getImageFilename(f.properties))
    .filter(Boolean);

  const imageMap = await fetchWikimediaThumbUrls(filenames);

  console.log("Building dataset…");
  const output = features
    .map((f, i) => buildEntry(f, i + 1, imageMap))
    .filter((e) => e.name && e.imageUrl); // only keep entries with an image

  console.log(`  → ${output.length} fountains with images`);

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${output.length} fountains to ${OUT_PATH}`);

  console.log("\nSample entries:");
  output.slice(0, 3).forEach((f) => {
    console.log(`  [${f.id}] ${f.name} — ${f.lat.toFixed(4)}, ${f.lng.toFixed(4)}`);
    console.log(`        image: ${f.imageUrl?.slice(0, 80)}…`);
  });
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
