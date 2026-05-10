import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const PUBLIC = path.join(process.cwd(), 'public');

// Jina renders JS-heavy pages and bypasses 403s
const JINA = 'https://r.jina.ai/';

const POSITIONS = ['GK','CB','LB','RB','LMF','RMF','DMF','CMF','AMF','LWF','RWF','SS','CF','ST'];
const POS_RE = new RegExp(`\\b(${POSITIONS.join('|')})\\b`);

// ─── FETCH VIA JINA ──────────────────────────────────────────────────────────
async function fetchViaJina(url, label) {
  console.log(`\nFetching [${label}]: ${url}`);
  const jinaUrl = `${JINA}${url}`;
  const res = await fetch(jinaUrl, {
    headers: {
      'User-Agent': 'EFMetaBot/2.0',
      'Accept': 'text/plain',
      'X-Return-Format': 'text',
    },
    timeout: 30000,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from Jina for ${url}`);
  return res.text();
}

// ─── PARSE PLAYERS FROM JINA TEXT ────────────────────────────────────────────
// efhub.com text lines look like:
//   "86 · 99 · CMF A · Enzo Fernández"   (baseOvr · maxOvr · POS COND · Name)
//   "96 · CMF A · Pedri"                  (maxOvr · POS COND · Name)
//   "95 · CB A · Nico Schlotterbeck"
function parsePlayers(text, label) {
  const players = [];
  const seen = new Set();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    // Normalise bullet separators
    const raw = line.replace(/·/g, '|').replace(/\s*\|\s*/g, ' | ');

    let name = null, overall = null, position = null;

    // Format A: "86 | 99 | CMF A | Enzo Fernández"  (base | max | pos cond | name)
    let m = raw.match(/^(\d{2,3})\s*\|\s*(\d{2,3})\s*\|\s*([A-Z]{2,3})\s+[A-E]\s*\|\s*(.+)$/);
    if (m) {
      overall  = parseInt(m[2]);   // max overall is what matters
      position = m[3];
      name     = m[4].trim();
    }

    // Format B: "96 | CMF A | Pedri"  (max | pos cond | name)
    if (!name) {
      m = raw.match(/^(\d{2,3})\s*\|\s*([A-Z]{2,3})\s+[A-E]\s*\|\s*(.+)$/);
      if (m) { overall = parseInt(m[1]); position = m[2]; name = m[3].trim(); }
    }

    // Format C: "96 | CMF | Pedri"  (no condition letter)
    if (!name) {
      m = raw.match(/^(\d{2,3})\s*\|\s*([A-Z]{2,3})\s*\|\s*(.+)$/);
      if (m && POSITIONS.includes(m[2])) {
        overall = parseInt(m[1]); position = m[2]; name = m[3].trim();
      }
    }

    // Fallback: grab first number + first known position + rest as name
    if (!name) {
      const numMatch = raw.match(/(\d{2,3})/);
      const posMatch = raw.match(POS_RE);
      if (numMatch && posMatch) {
        overall  = parseInt(numMatch[1]);
        position = posMatch[1];
        // Strip numbers, position, condition letter
        name = raw
          .replace(/\d{2,3}/g, '')
          .replace(POS_RE, '')
          .replace(/\b[A-E]\b/g, '')
          .replace(/\|/g, '')
          .trim()
          .replace(/\s+/g, ' ');
      }
    }

    if (!name || name.length < 2 || name.length > 60) continue;
    if (!position || !POSITIONS.includes(position))    continue;
    if (seen.has(name)) continue;

    seen.add(name);
    players.push({ name, overall, position, type: label });
  }

  const withOvr = players.filter(p => p.overall).length;
  console.log(`  → ${players.length} players (${withOvr} with overall)`);
  return players;
}

// ─── SCRAPE ONE CATEGORY ──────────────────────────────────────────────────────
async function scrapeCategory(label, url) {
  try {
    const text = await fetchViaJina(url, label);
    return parsePlayers(text, label);
  } catch (err) {
    console.error(`  ERROR [${label}]: ${err.message}`);
    return [];
  }
}

// ─── TIER LIST ────────────────────────────────────────────────────────────────
function generateTierList(players) {
  const withOverall = players.filter(p => p.overall && p.overall >= 80);
  console.log(`\nBuilding tier list from ${withOverall.length} rated players`);

  // Card type bonus so Epic > Featured > regular at same overall
  const TYPE_BONUS = { epic: 4, bigtime: 3, showtime: 3, legend: 2, featured: 1, new: 0 };

  const scored = withOverall.map(p => ({
    ...p,
    score: p.overall + (TYPE_BONUS[p.type] ?? 0),
  }));

  // Dedupe by name, keep highest score
  const byName = {};
  scored.forEach(p => {
    if (!byName[p.name] || p.score > byName[p.name].score) byName[p.name] = p;
  });
  const unique = Object.values(byName).sort((a, b) => b.score - a.score);

  // Dynamic thresholds
  const scores = unique.map(p => p.score);
  const max = scores[0]  || 100;
  const min = scores[scores.length - 1] || 80;
  const range = max - min || 1;

  const tiers = { S: [], A: [], B: [], C: [], D: [] };
  unique.forEach(p => {
    const pct = (p.score - min) / range;
    if      (pct >= 0.80) tiers.S.push(p);
    else if (pct >= 0.60) tiers.A.push(p);
    else if (pct >= 0.40) tiers.B.push(p);
    else if (pct >= 0.20) tiers.C.push(p);
    else                  tiers.D.push(p);
  });

  // Cap each tier at 15 players
  Object.keys(tiers).forEach(t => { tiers[t] = tiers[t].slice(0, 15); });
  console.log(`S=${tiers.S.length} A=${tiers.A.length} B=${tiers.B.length} C=${tiers.C.length} D=${tiers.D.length}`);

  return {
    generated_at: new Date().toISOString(),
    method: 'stat-based',
    note: 'Rankings use max overall + card type bonus (Epic/BigTime +4/3, Legend +2, Featured +1). Data from efhub.com.',
    tiers,
  };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(PUBLIC, { recursive: true });

  // efhub.com URL patterns (adjust if the site restructures)
  const endpoints = [
    { label: 'epic',     url: 'https://efhub.com/players?type=epic' },
    { label: 'bigtime',  url: 'https://efhub.com/players?type=bigtime' },
    { label: 'showtime', url: 'https://efhub.com/players?type=showtime' },
    { label: 'featured', url: 'https://efhub.com/players?type=featured' },
    { label: 'new',      url: 'https://efhub.com/players?sort=newest' },
  ];

  const allPlayers = [];
  for (const ep of endpoints) {
    const batch = await scrapeCategory(ep.label, ep.url);
    allPlayers.push(...batch);
  }

  if (allPlayers.length === 0) {
    // If efhub.com query params don't work, fall back to the main players page
    console.log('\nNo players found from filtered URLs — trying main players page…');
    try {
      const text = await fetchViaJina('https://efhub.com/players', 'all');
      allPlayers.push(...parsePlayers(text, 'featured'));
    } catch (err) {
      console.error('  Fallback failed:', err.message);
    }
  }

  // Dedupe across categories — keep highest overall per player name
  const byName = {};
  allPlayers.forEach(p => {
    if (!byName[p.name] || (p.overall || 0) > (byName[p.name].overall || 0)) {
      byName[p.name] = p;
    }
  });
  const finalPlayers = Object.values(byName).sort((a, b) => (b.overall || 0) - (a.overall || 0));

  if (finalPlayers.length === 0) {
    console.error('\n❌ No players scraped. Check Jina access or efhub.com URL structure.');
    process.exit(1);   // Fail loudly so GitHub Actions shows a red X
  }

  // Write players.json
  fs.writeFileSync(
    path.join(PUBLIC, 'players.json'),
    JSON.stringify({ scraped_at: new Date().toISOString(), count: finalPlayers.length, players: finalPlayers }, null, 2)
  );
  console.log(`\n✓ players.json → ${finalPlayers.length} players`);

  // Write tier.json
  const tier = generateTierList(finalPlayers);
  fs.writeFileSync(path.join(PUBLIC, 'tier.json'), JSON.stringify(tier, null, 2));
  console.log('✓ tier.json saved');

  console.log('\n✅ Done.');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
