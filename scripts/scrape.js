import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const PUBLIC = path.join(process.cwd(), 'public');
const BASE   = 'https://efhub.com/api/public/players';

// Featured (playerType=2) returns 403 — removed. New players endpoint also unreliable — removed.
const ENDPOINTS = [
  { label: 'epic',     playerType: 5 },
  { label: 'bigtime',  playerType: 7 },
  { label: 'showtime', playerType: 8 },
];

const TYPE_BONUS = { epic: 4, bigtime: 3, showtime: 3 };

// ─── FETCH ONE CATEGORY ───────────────────────────────────────────────────────
async function fetchCategory({ label, playerType }) {
  const url = `${BASE}?playerType=${playerType}`;
  console.log(`\nFetching [${label}]: ${url}`);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept':     'application/json',
      'Referer':    'https://efhub.com/',
    },
    timeout: 20000,
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} for playerType=${playerType}`);

  const json = await res.json();
  const raw  = Array.isArray(json) ? json : (json.players ?? []);

  const players = raw.map(p => ({
    id:       p.id       ?? null,           // used to build efhub.com/players/{id}
    name:     p.name     || p.nameJa || '—',
    overall:  p.overallRating ?? null,
    position: p.position  ?? null,
    team:     p.team      ?? null,
    style:    p.playingStyle ?? null,
    imageUrl: p.imageUrl  ?? null,
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

  // Dedupe by name — keep highest score
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
  }

  if (allPlayers.length === 0) {
    console.error('\n❌ No players scraped. Check the API URL or network access.');
    process.exit(1);
  }

  // Dedupe by name — keep highest overall
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
