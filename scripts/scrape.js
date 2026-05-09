// scripts/scrape.js
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

const BASE = 'https://www.efootballhub.net/efootball23';
const PUBLIC = path.join(process.cwd(), 'public');

// ─── SCRAPE PLAYERS ──────────────────────────────────────────────────────────
async function scrapePlayers(label, url) {
  console.log(`\nScraping [${label}]: ${url}`);
  const players = [];
  const seen = new Set();

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      timeout: 15000
    });

    console.log(`  Status: ${res.status}`);
    const html = await res.text();
    console.log(`  HTML length: ${html.length} chars`);

    const $ = cheerio.load(html);

    // Log a snippet of what we got to debug structure
    const bodyText = $('body').text().substring(0, 300).replace(/\s+/g, ' ');
    console.log(`  Body preview: ${bodyText}`);

    // Strategy 1: look for player links
    const playerLinks = $('a[href*="/player/"]');
    console.log(`  Player links found: ${playerLinks.length}`);

    playerLinks.each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (!text || text.length < 3 || text.length > 60) return;
      if (seen.has(text)) return;

      // Pattern: "96 CF A Kylian Mbappe" or "96CF AMbappe"
      const m1 = text.match(/^(\d{2,3})\s*([A-Z]{1,4})\s+[A-E]\s+(.+)$/);
      const m2 = text.match(/^(\d{2,3})([A-Z]{2,4})[A-E](.+)$/);

      if (m1) {
        seen.add(m1[3].trim());
        players.push({ name: m1[3].trim(), overall: parseInt(m1[1]), position: m1[2], type: label });
      } else if (m2) {
        seen.add(m2[3].trim());
        players.push({ name: m2[3].trim(), overall: parseInt(m2[1]), position: m2[2], type: label });
      } else {
        seen.add(text);
        players.push({ name: text, overall: null, position: null, type: label });
      }
    });

    // Strategy 2: any element with class containing 'player'
    if (players.length === 0) {
      $('[class*="player"]').each((_, el) => {
        const text = $(el).text().trim().replace(/\s+/g, ' ');
        if (text.length > 3 && text.length < 50 && !seen.has(text)) {
          seen.add(text);
          players.push({ name: text, overall: null, position: null, type: label });
        }
      });
      console.log(`  Strategy 2 found: ${players.length}`);
    }

  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
  }

  console.log(`  → ${players.length} players extracted`);
  return players;
}

// ─── TIER LIST FROM STATS ─────────────────────────────────────────────────────
function generateTierList(players) {
  const withOverall = players.filter(p => p.overall && p.overall > 0);
  console.log(`\nGenerating tier list from ${withOverall.length} players with overall ratings...`);

  const scored = withOverall.map(p => ({
    ...p,
    score: p.overall + (p.type === 'epic' ? 3 : p.type === 'legend' ? 2 : p.type === 'featured' ? 1 : 0)
  }));

  // Dedupe by name
  const byName = {};
  scored.forEach(p => {
    if (!byName[p.name] || p.score > byName[p.name].score) byName[p.name] = p;
  });
  const unique = Object.values(byName).sort((a, b) => b.score - a.score);

  const tiers = { S: [], A: [], B: [], C: [], D: [] };
  unique.forEach(p => {
    const s = p.score;
    if      (s >= 97) tiers.S.push(p);
    else if (s >= 94) tiers.A.push(p);
    else if (s >= 91) tiers.B.push(p);
    else if (s >= 88) tiers.C.push(p);
    else              tiers.D.push(p);
  });

  // Cap at 8 per tier
  Object.keys(tiers).forEach(t => { tiers[t] = tiers[t].slice(0, 8); });

  console.log(`Tiers: S=${tiers.S.length} A=${tiers.A.length} B=${tiers.B.length} C=${tiers.C.length} D=${tiers.D.length}`);

  return {
    generated_at: new Date().toISOString(),
    method: 'stat-based',
    note: 'Rankings based on player overall rating + card type bonus (Epic +3, Legend +2, Featured +1).',
    tiers
  };
}

// ─── FETCH NEWS VIA JINA ──────────────────────────────────────────────────────
async function fetchNews() {
  console.log('\nFetching news...');
  const articles = [];

  // Reddit via direct JSON API (no Jina needed)
  try {
    const res = await fetch('https://www.reddit.com/r/eFootball/new.json?limit=10', {
      headers: { 'User-Agent': 'EFMetaBot/1.0' }
    });
    const json = await res.json();
    const posts = json?.data?.children || [];
    posts.forEach(p => {
      const d = p.data;
      articles.push({
        title: d.title,
        url: `https://reddit.com${d.permalink}`,
        source: 'Reddit r/eFootball',
        time: new Date(d.created_utc * 1000).toISOString(),
        score: d.score
      });
    });
    console.log(`  → ${posts.length} Reddit posts`);
  } catch (err) {
    console.error(`  Reddit failed: ${err.message}`);
  }

  return { fetched_at: new Date().toISOString(), articles };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(PUBLIC, { recursive: true });

  const endpoints = [
    { label: 'epic',     url: `${BASE}/search/players?epic=true&GridView=true` },
    { label: 'featured', url: `${BASE}/search/players?agentSearch=true&GridView=true` },
    { label: 'legend',   url: `${BASE}/search/players?legend=true&GridView=true` },
    { label: 'new',      url: `${BASE}/search/players?newPlayers=true&GridView=true` },
  ];

  const allPlayers = [];
  for (const ep of endpoints) {
    const p = await scrapePlayers(ep.label, ep.url);
    allPlayers.push(...p);
  }

  // Global dedupe
  const byName = {};
  allPlayers.forEach(p => {
    if (!byName[p.name] || (p.overall || 0) > (byName[p.name].overall || 0)) byName[p.name] = p;
  });
  const finalPlayers = Object.values(byName).sort((a, b) => (b.overall || 0) - (a.overall || 0));

  fs.writeFileSync(path.join(PUBLIC, 'players.json'), JSON.stringify({
    scraped_at: new Date().toISOString(),
    count: finalPlayers.length,
    players: finalPlayers
  }, null, 2));
  console.log(`\n✓ players.json → ${finalPlayers.length} players`);

  const tier = generateTierList(finalPlayers);
  fs.writeFileSync(path.join(PUBLIC, 'tier.json'), JSON.stringify(tier, null, 2));
  console.log(`✓ tier.json saved`);

  const news = await fetchNews();
  fs.writeFileSync(path.join(PUBLIC, 'news.json'), JSON.stringify(news, null, 2));
  console.log(`✓ news.json → ${news.articles.length} articles`);

  console.log('\n✅ Done.');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
