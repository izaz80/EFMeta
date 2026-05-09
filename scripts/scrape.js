import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

const BASE = 'https://www.efootballhub.net/efootball23';
const PUBLIC = path.join(process.cwd(), 'public');

async function scrapePlayers(label, url) {
  console.log(`\nScraping [${label}]: ${url}`);
  const players = [];
  const seen = new Set();

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      }
    });

    const html = await res.text();
    const $ = cheerio.load(html);
    const POSITIONS = 'GK|CB|LB|RB|DMF|CMF|AMF|LWF|RWF|SS|CF|ST';

    $('a[href*="/player/"]').each((_, el) => {
      const raw = $(el).text().trim().replace(/\s+/g, ' ');
      if (!raw || raw.length < 3 || raw.length > 80 || seen.has(raw)) return;

      let name = null, overall = null, position = null;

      // Format A: "89 106 SS B Pelé"  (two nums, pos, condition, name) — Epic/Legend
      let m = raw.match(new RegExp(`^(\\d{2,3})\\s+\\d{2,3}\\s+(${POSITIONS})\\s+[A-E]\\s+(.+)$`));
      if (m) { overall = parseInt(m[1]); position = m[2]; name = m[3].trim(); }

      // Format B: "98 LWF B Vinícius Júnior"  (one num, pos, condition, name) — Featured
      if (!name) {
        m = raw.match(new RegExp(`^(\\d{2,3})\\s+(${POSITIONS})\\s+[A-E]\\s+(.+)$`));
        if (m) { overall = parseInt(m[1]); position = m[2]; name = m[3].trim(); }
      }

      // Format C: "98 LWF Vinícius Júnior"  (no condition letter)
      if (!name) {
        m = raw.match(new RegExp(`^(\\d{2,3})\\s+(${POSITIONS})\\s+(.+)$`));
        if (m) { overall = parseInt(m[1]); position = m[2]; name = m[3].trim(); }
      }

      // Fallback: grab first number as overall, first position token, rest as name
      if (!name) {
        const numMatch = raw.match(/(\d{2,3})/);
        const posMatch = raw.match(new RegExp(`\\b(${POSITIONS})\\b`));
        if (numMatch && posMatch) {
          overall = parseInt(numMatch[1]);
          position = posMatch[1];
          name = raw.replace(numMatch[0], '').replace(posMatch[0], '').replace(/\b[A-E]\b/, '').trim();
        } else if (raw.length > 2) {
          name = raw;
        }
      }

      if (name && name.length > 1 && !seen.has(name)) {
        seen.add(name);
        players.push({ name, overall, position, type: label });
      }
    });

  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
  }

  const withOvr = players.filter(p => p.overall).length;
  console.log(`  → ${players.length} players (${withOvr} with overall)`);
  return players;
}

function generateTierList(players) {
  const withOverall = players.filter(p => p.overall && p.overall >= 80);
  console.log(`\nTier list from ${withOverall.length} rated players`);

  // Score: overall + card type bonus
  const scored = withOverall.map(p => ({
    ...p,
    score: p.overall + (p.type==='epic'?3 : p.type==='legend'?2 : p.type==='featured'?1 : 0)
  }));

  // Dedupe by name, keep highest score
  const byName = {};
  scored.forEach(p => { if (!byName[p.name] || p.score > byName[p.name].score) byName[p.name] = p; });
  const unique = Object.values(byName).sort((a,b) => b.score - a.score);

  // Dynamic thresholds based on actual score distribution
  const scores = unique.map(p => p.score);
  const max = scores[0] || 100;
  const min = scores[scores.length-1] || 80;
  const range = max - min;

  const tiers = { S:[], A:[], B:[], C:[], D:[] };
  unique.forEach(p => {
    const pct = range > 0 ? (p.score - min) / range : 0.5;
    if      (pct >= 0.80) tiers.S.push(p);
    else if (pct >= 0.60) tiers.A.push(p);
    else if (pct >= 0.40) tiers.B.push(p);
    else if (pct >= 0.20) tiers.C.push(p);
    else                  tiers.D.push(p);
  });

  Object.keys(tiers).forEach(t => { tiers[t] = tiers[t].slice(0, 10); });
  console.log(`S=${tiers.S.length} A=${tiers.A.length} B=${tiers.B.length} C=${tiers.C.length} D=${tiers.D.length}`);

  return {
    generated_at: new Date().toISOString(),
    method: 'stat-based',
    note: 'Rankings based on overall rating + card type bonus (Epic +3, Legend +2, Featured +1). Data from efootballhub.net.',
    tiers
  };
}

async function fetchNews() {
  console.log('\nFetching news via Jina...');
  const articles = [];

  try {
    const res = await fetch('https://r.jina.ai/https://www.reddit.com/r/eFootball/new/', {
      headers: { 'User-Agent': 'EFMetaBot/1.0', 'Accept': 'text/plain' }
    });
    const text = await res.text();

    const lines = text.split('\n')
      .map(l => l.trim())
      .filter(l =>
        l.length > 20 && l.length < 250 &&
        !l.startsWith('http') && !l.startsWith('r/') &&
        !l.startsWith('u/') && !l.startsWith('#') &&
        !l.match(/^\d+\s*(point|comment|hour|minute|day|Posted)/) &&
        l.match(/[a-zA-Z]{4,}/)
      ).slice(0, 10);

    lines.forEach(title => {
      articles.push({
        title,
        url: 'https://www.reddit.com/r/eFootball/new/',
        source: 'Reddit r/eFootball',
        time: new Date().toISOString()
      });
    });
    console.log(`  → ${articles.length} news items`);
  } catch (err) {
    console.error(`  News failed: ${err.message}`);
  }

  return { fetched_at: new Date().toISOString(), articles };
}

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
    allPlayers.push(...await scrapePlayers(ep.label, ep.url));
  }

  const byName = {};
  allPlayers.forEach(p => { if (!byName[p.name] || (p.overall||0) > (byName[p.name].overall||0)) byName[p.name] = p; });
  const finalPlayers = Object.values(byName).sort((a,b) => (b.overall||0)-(a.overall||0));

  fs.writeFileSync(path.join(PUBLIC,'players.json'), JSON.stringify({
    scraped_at: new Date().toISOString(), count: finalPlayers.length, players: finalPlayers
  }, null, 2));
  console.log(`\n✓ players.json → ${finalPlayers.length} players`);

  const tier = generateTierList(finalPlayers);
  fs.writeFileSync(path.join(PUBLIC,'tier.json'), JSON.stringify(tier, null, 2));
  console.log(`✓ tier.json saved`);

  const news = await fetchNews();
  fs.writeFileSync(path.join(PUBLIC,'news.json'), JSON.stringify(news, null, 2));
  console.log(`✓ news.json → ${news.articles.length} articles`);

  console.log('\n✅ Done.');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
