import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const PUBLIC = path.join(process.cwd(), 'public');
const BASE   = 'https://efhub.com/api/public/players';

const ENDPOINTS = [
  { label: 'epic',     playerType: 5 },
  { label: 'bigtime',  playerType: 7 },
  { label: 'showtime', playerType: 8 },
];

const TYPE_BONUS = { epic: 4, bigtime: 3, showtime: 3 };

// Full browser-like headers — mimics a real Chrome request to efhub.com
const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer':         'https://efhub.com/',
  'Origin':          'https://efhub.com',
  'Connection':      'keep-alive',
  'Sec-Fetch-Dest':  'empty',
  'Sec-Fetch-Mode':  'cors',
  'Sec-Fetch-Site':  'same-origin',
  'Sec-Ch-Ua':       '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile':'?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── FETCH WITH RETRY ─────────────────────────────────────────────────────────
async function fetchWithRetry(url, retries = 3, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    if (i > 0) {
      console.log(`  Retry ${i}/${retries - 1} after ${delayMs}ms…`);
      await sleep(delayMs);
    }
    try {
      const res = await fetch(url, { headers: HEADERS, timeout: 25000 });
      if (res.ok) return res;
      console.log(`  HTTP ${res.status} (attempt ${i + 1})`);
      if (res.status === 401 || res.status === 403) {
        // No point retrying auth errors unless we add cookies
        return res;
      }
    } catch (err) {
      console.log(`  Network error (attempt ${i + 1}): ${err.message}`);
    }
  }
  throw new Error(`All ${retries} attempts failed for ${url}`);
}

// ─── FETCH ONE CATEGORY ───────────────────────────────────────────────────────
async function fetchCategory({ label, playerType }) {
  const url = `${BASE}?playerType=${playerType}`;
  console.log(`\nFetching [${label}]: ${url}`);

  const res = await fetchWithRetry(url);

  if (!res.ok) {
    // If still 403, log the response body for debugging
    const body = await res.text().catch(() => '');
    console.error(`  HTTP ${res.status} — response: ${body.slice(0, 200)}`);
    throw new Error(`HTTP ${res.status} for playerType=${playerType}`);
  }

  const json = await res.json();
  const raw  = Array.isArray(json) ? json : (json.players ?? []);

  const players = raw.map(p => ({
    id:       p.id            ?? null,
    name:     p.name          || p.nameJa || '—',
    overall:  p.overallRating ?? null,
    position: p.position      ?? null,
    team:     p.team          ?? null,
    style:    p.playingStyle  ?? null,
    imageUrl: p.imageUrl      ?? null,
    type:     label,
  })).filter(p => p.name !== '—');

  console.log(`  → ${players.length} players`);
  return players;
}

// ─── TIER LIST ────────────────────────────────────────────────────────────────
function generateTierList(players) {
  const rated = players.filter(p => p.overall && p.overall >= 80);
  console.log(`\nBuilding tier list from ${rated.length} rated players`);

  const scored = rated.map(p => ({
    ...p,
    score: p.overall + (TYPE_BONUS[p.type] ?? 0),
  }));

  const byName = {};
  scored.forEach(p => {
    if (!byName[p.name] || p.score > byName[p.name].score) byName[p.name] = p;
  });
  const unique = Object.values(byName).sort((a, b) => b.score - a.score);

  const scores = unique.map(p => p.score);
  const max    = scores[0]  || 100;
  const min    = scores[scores.length - 1] || 80;
  const range  = max - min || 1;

  const tiers = { S: [], A: [], B: [], C: [], D: [] };
  unique.forEach(p => {
    const pct = (p.score - min) / range;
    if      (pct >= 0.80) tiers.S.push(p);
    else if (pct >= 0.60) tiers.A.push(p);
    else if (pct >= 0.40) tiers.B.push(p);
    else if (pct >= 0.20) tiers.C.push(p);
    else                  tiers.D.push(p);
  });

  Object.keys(tiers).forEach(t => { tiers[t] = tiers[t].slice(0, 15); });
  console.log(`S=${tiers.S.length} A=${tiers.A.length} B=${tiers.B.length} C=${tiers.C.length} D=${tiers.D.length}`);

  return {
    generated_at: new Date().toISOString(),
    method:       'stat-based',
    note:         'Rankings use max overall + card type bonus (Epic +4, BigTime/ShowTime +3). Data from efhub.com.',
    tiers,
  };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(PUBLIC, { recursive: true });

  const allPlayers = [];

  for (const ep of ENDPOINTS) {
    try {
      allPlayers.push(...await fetchCategory(ep));
    } catch (err) {
      console.error(`  ERROR [${ep.label}]: ${err.message}`);
    }
    // Small delay between requests to avoid rate limiting
    await sleep(1000);
  }

  if (allPlayers.length === 0) {
    console.error('\n❌ No players scraped.');
    console.error('   The API may require authentication cookies.');
    console.error('   Open DevTools on efhub.com → Network → find the players API request → copy the Cookie header and set it as EFHUB_COOKIE in GitHub Secrets.');
    process.exit(1);
  }

  const byName = {};
  allPlayers.forEach(p => {
    if (!byName[p.name] || (p.overall ?? 0) > (byName[p.name].overall ?? 0)) {
      byName[p.name] = p;
    }
  });
  const final = Object.values(byName).sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0));

  fs.writeFileSync(
    path.join(PUBLIC, 'players.json'),
    JSON.stringify({ scraped_at: new Date().toISOString(), count: final.length, players: final }, null, 2)
  );
  console.log(`\n✓ players.json → ${final.length} players`);

  const tier = generateTierList(final);
  fs.writeFileSync(path.join(PUBLIC, 'tier.json'), JSON.stringify(tier, null, 2));
  console.log('✓ tier.json saved');

  console.log('\n✅ Done.');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
