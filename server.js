require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTODEV_API_KEY = process.env.AUTODEV_API_KEY;
const AUTODEV_LISTINGS_URL = 'https://auto.dev/api/listings';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/reverse-geocode', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) {
    return res.status(400).json({ error: 'lat and lon are required' });
  }

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=14&addressdetails=1`,
      { headers: { 'User-Agent': 'car-finder-app/1.0' } }
    );
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Reverse geocoding failed' });
    }
    const data = await response.json();
    const zip = data?.address?.postcode || null;
    if (!zip) {
      return res.status(404).json({ error: 'Could not determine ZIP code for this location' });
    }
    res.json({ zip });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

function titleCase(value) {
  return value.trim().replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

// Simple edit distance so typos like "civc" or "civik" still match "Civic".
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// Near-exact match: same text regardless of case/spacing, or at most a
// one-character typo. Deliberately stricter than a loose substring match.
function fuzzyMatches(candidate, query) {
  if (!query) return true;
  const c = candidate.toLowerCase().trim();
  const q = query.toLowerCase().trim();
  if (c === q) return true;
  return levenshtein(c, q) <= 1;
}

function buildSearchUrl(car) {
  const parts = [car.year, car.make, car.model, car.trim, car.dealerName, car.vin].filter(Boolean);
  if (!parts.length) return null;
  return 'https://www.google.com/search?q=' + encodeURIComponent(parts.join(' '));
}

function scoreListings(listings) {
  const byModel = {};
  for (const car of listings) {
    if (car.price == null || car.mileage == null) continue;
    const key = `${car.make}|${car.model}`;
    (byModel[key] = byModel[key] || []).push(car);
  }

  for (const key in byModel) {
    const group = byModel[key];
    const avgPricePerMile = group.reduce((sum, c) => sum + c.price / Math.max(c.mileage, 1), 0) / group.length;
    for (const car of group) {
      const pricePerMile = car.price / Math.max(car.mileage, 1);
      car.valueScore = Math.round((1 - pricePerMile / avgPricePerMile) * 100);
    }
  }
  return listings;
}

app.get('/api/search', async (req, res) => {
  if (!AUTODEV_API_KEY) {
    return res.status(500).json({ error: 'Missing AUTODEV_API_KEY in .env' });
  }

  const { make, model, maxMileage, zip, radius } = req.query;
  if (!make) {
    return res.status(400).json({ error: 'make is required' });
  }

  // auto.dev returns every VIN in the response in a single "x-vins" header
  // (not in the body), and at limit >= ~70 that header alone exceeds Node's
  // HTTP header size limit and fetch throws UND_ERR_HEADERS_OVERFLOW. So we
  // always page through with a safe per-request limit (50) instead of one
  // big request.
  // 30 leaves headroom under Node's ~16KB header limit even for makes/models
  // whose x-vins header runs long (e.g. Ford F-150 hit ~16.3KB at limit=50).
  const PAGE_LIMIT = 30;
  const MAX_PAGES = 6;
  const TARGET_MATCHES = 30;

  async function fetchPages(extraParams) {
    let allRecords = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const params = new URLSearchParams(extraParams);
      params.set('limit', String(PAGE_LIMIT));
      params.set('page', String(page));

      const response = await fetch(`${AUTODEV_LISTINGS_URL}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${AUTODEV_API_KEY}` },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`auto.dev request failed: ${text}`);
      }

      const data = await response.json();
      const records = Array.isArray(data.records) ? data.records : Array.isArray(data) ? data : [];
      allRecords = allRecords.concat(records);

      if (records.length < PAGE_LIMIT) break; // no more pages
      if (allRecords.length >= TARGET_MATCHES) break;
    }
    return allRecords;
  }

  const sharedParams = new URLSearchParams();
  sharedParams.set('make', titleCase(make));
  if (maxMileage) sharedParams.set('mileage_max', maxMileage);
  if (zip) sharedParams.set('zip', zip);
  if (radius) sharedParams.set('radius', radius);

  try {
    let filtered;

    if (model) {
      // First try the upstream API's own model filter — it's indexed, so it
      // reliably finds even rare models that a random sample would miss.
      const exactParams = new URLSearchParams(sharedParams);
      exactParams.set('model', titleCase(model));
      filtered = await fetchPages(exactParams);

      // Fall back to a broad make-only scan + our own fuzzy match, which
      // catches typos/casing the upstream filter wouldn't match.
      if (filtered.length === 0) {
        const broadRecords = await fetchPages(sharedParams);
        filtered = broadRecords.filter((car) => car.model && fuzzyMatches(car.model, model));
      }
    } else {
      filtered = await fetchPages(sharedParams);
    }

    const normalized = filtered.map((car) => ({
      make: car.make,
      model: car.model,
      trim: car.trim,
      year: car.year,
      price: car.priceUnformatted ?? null,
      mileage: car.mileageUnformatted ?? null,
      location: [car.city, car.state].filter(Boolean).join(', '),
      dealerName: car.dealerName || null,
      photoUrl: car.thumbnailUrlLarge || car.primaryPhotoUrl || null,
      // Prefer the dealer's own site (clickoffUrl) so "View" lands on the actual
      // listing. auto.dev's vdpUrl paths are widget-only fragments that 404 as
      // standalone links, so fall back to a search for the exact VIN when no
      // direct dealer link is available.
      url: car.clickoffUrl || buildSearchUrl(car),
      isDirectDealerLink: Boolean(car.clickoffUrl),
    }));

    res.json({ listings: scoreListings(normalized) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Car finder running at http://localhost:${PORT}`);
});
