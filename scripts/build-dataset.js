#!/usr/bin/env node
/**
 * build-dataset.js
 *
 * Fetches Zurich fountain data from two sources:
 *   1. Stadt Zürich WFS API  — authoritative coords + metadata
 *   2. Wikimedia Commons API — public images for each fountain
 *
 * Matches them by proximity (≤ 80 m) or by name,
 * then writes src/data/fountains.json with the best entries.
 *
 * Run: node scripts/build-dataset.js
 */

import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "../src/data/fountains.json");

// ─── 1. Fetch all fountains from WFS ─────────────────────────────────────────

async function fetchWFS() {
  const url =
    "https://www.ogd.stadt-zuerich.ch/wfs/geoportal/Brunnen" +
    "?SERVICE=WFS&REQUEST=GetFeature&VERSION=1.1.0" +
    "&TYPENAME=wvz_brunnen&OUTPUTFORMAT=application/json" +
    "&MAXFEATURES=2000";

  console.log("Fetching WFS fountain data…");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`WFS fetch failed: ${res.status}`);
  const geojson = await res.json();
  console.log(`  → ${geojson.features.length} features`);
  return geojson.features;
}

// ─── 2. Fetch Wikimedia Commons images ───────────────────────────────────────

async function fetchWikimediaImages() {
  const baseUrl = "https://commons.wikimedia.org/w/api.php";
  const images = [];
  let continueToken = null;

  console.log("Fetching Wikimedia Commons images…");

  do {
    const params = new URLSearchParams({
      action: "query",
      generator: "categorymembers",
      gcmtitle: "Category:Fountains in Zürich",
      gcmtype: "file",
      gcmlimit: "500",
      prop: "coordinates|imageinfo|categories",
      iiprop: "url|size",
      iiurlwidth: "800",
      coprop: "type",
      coprimary: "all",
      format: "json",
      origin: "*",
    });

    if (continueToken) {
      Object.entries(continueToken).forEach(([k, v]) => params.set(k, v));
    }

    const res = await fetch(`${baseUrl}?${params}`);
    if (!res.ok) throw new Error(`Wikimedia fetch failed: ${res.status}`);
    const data = await res.json();

    if (data.query?.pages) {
      for (const page of Object.values(data.query.pages)) {
        const imageinfo = page.imageinfo?.[0];
        if (!imageinfo) continue;

        // Skip very small images (thumbnails / icons)
        if (imageinfo.width < 400 || imageinfo.height < 300) continue;

        const coords = page.coordinates?.find((c) => c.primary) ?? page.coordinates?.[0];

        images.push({
          title: page.title.replace("File:", ""),
          url: imageinfo.thumburl || imageinfo.url,
          fullUrl: imageinfo.url,
          pageUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
          lat: coords?.lat ?? null,
          lng: coords?.lon ?? null,
        });
      }
    }

    continueToken = data.continue ?? null;
    if (continueToken) {
      // Small delay to be polite to Wikimedia API
      await new Promise((r) => setTimeout(r, 300));
    }
  } while (continueToken);

  const withCoords = images.filter((i) => i.lat !== null);
  console.log(`  → ${images.length} images total, ${withCoords.length} with coordinates`);
  return images;
}

// ─── 3. Match fountains to images ────────────────────────────────────────────

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

/** Normalise a string for fuzzy name matching */
function normalise(s) {
  return (s || "")
    .toLowerCase()
    .replace(/brunnen|fontäne|fontaine|fountain/gi, "")
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchFountainsToImages(wfsFeatures, wikiImages) {
  const geocodedImages = wikiImages.filter((i) => i.lat !== null);
  const matched = [];
  const usedImages = new Set();

  for (const feature of wfsFeatures) {
    const p = feature.properties;

    // Skip deactivated fountains
    if (p.abgestellt === "ja") continue;

    const [lng, lat] = feature.geometry.coordinates;

    // Try proximity match first (≤ 80 m)
    let bestImage = null;
    let bestDist = Infinity;

    for (const img of geocodedImages) {
      if (usedImages.has(img.title)) continue;
      const dist = haversineMeters(lat, lng, img.lat, img.lng);
      if (dist < bestDist) {
        bestDist = dist;
        bestImage = img;
      }
    }

    if (bestImage && bestDist <= 80) {
      usedImages.add(bestImage.title);
      matched.push(buildEntry(feature, lat, lng, bestImage, bestDist));
      continue;
    }

    // Fallback: name-based match against image title
    const fountainName = normalise(p.ortsbezeichnung || p.standort);
    if (!fountainName) continue;

    for (const img of wikiImages) {
      if (usedImages.has(img.title)) continue;
      const imgName = normalise(img.title);
      if (imgName.includes(fountainName) || fountainName.includes(imgName.split(" ")[0])) {
        usedImages.add(img.title);
        matched.push(buildEntry(feature, lat, lng, img, null));
        break;
      }
    }
  }

  return matched;
}

function buildEntry(feature, lat, lng, image, matchDistM) {
  const p = feature.properties;
  return {
    id: String(p.objectid),
    name: p.ortsbezeichnung || p.standort || "Brunnen",
    location: p.standort || "",
    district: p.quartier || "",
    stadtkreis: p.stadtkreis ?? null,
    year: p.baujahr ?? p.historisches_baujahr ?? null,
    architect: p.architekt_bildhauer || null,
    material: [p.material_trog, p.material_saeule, p.material_figur]
      .filter(Boolean)
      .join(", ") || null,
    waterType: p.wasserart || null,
    fountainType: p.brunnenart || null,
    lat,
    lng,
    imageUrl: image.url,
    imageCredit: image.title,
    imagePage: image.pageUrl,
    _matchDist: matchDistM ? Math.round(matchDistM) : null,
  };
}

// ─── 4. Main ─────────────────────────────────────────────────────────────────

async function main() {
  const [wfsFeatures, wikiImages] = await Promise.all([fetchWFS(), fetchWikimediaImages()]);

  console.log("Matching fountains to images…");
  let matched = matchFountainsToImages(wfsFeatures, wikiImages);

  // Sort: proximity matches first (lower _matchDist), then name matches
  matched.sort((a, b) => {
    if (a._matchDist !== null && b._matchDist !== null) return a._matchDist - b._matchDist;
    if (a._matchDist !== null) return -1;
    if (b._matchDist !== null) return 1;
    return 0;
  });

  console.log(`  → ${matched.length} matched entries`);

  // Remove internal match distance field
  const output = matched.map(({ _matchDist, ...entry }) => entry);

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${output.length} fountains to ${OUT_PATH}`);

  // Print sample
  console.log("\nSample entries:");
  output.slice(0, 3).forEach((f) => {
    console.log(`  [${f.id}] ${f.name} (${f.district}) — ${f.lat.toFixed(4)}, ${f.lng.toFixed(4)}`);
    console.log(`        image: ${f.imageUrl.slice(0, 80)}…`);
  });
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
