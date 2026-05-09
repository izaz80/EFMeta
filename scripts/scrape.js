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
        'Accept-Language': 'en-US,en;q=0.5',
      }
    });

    console.log(`  Status: ${res.status}`);
    const html = await res.text();
    console.log(`  HTML: ${html.length} chars`);

    const $ = cheerio.load(html);

    // Print first few raw link texts to diagnose format
    const allPlayerLinks = $('a[href*="/player/"]');
    console.log(`  Raw player links: ${allPlayerLinks.length}`);
    allPlayerLinks.slice(0, 3).each((_, el) => {
      console.log(`  SAMPLE: "${$(el).text().trim().replace(/\s+/g,' ')}"`);
    });

    allPlayerLinks.each((_, el) => {
      const raw = $(el).text().trim().replace(/\s+/g, ' ');
      if (!raw || raw.length < 2 || raw.length > 80) return;
      if (seen.has(raw)) return;

      let name = null, overall = null, position = null;

      // Try every possible pattern
      // Pattern A: "96 CF A Kylian Mbappé"
      let m = raw.match(/^(\d{2,3})\s+([A-Z]{1,4})\s+[A-E]\s+(.+)$/);
      if (m) { overall = parseInt(m[1]); position = m[2]; name = m[3].trim(); }

      // Pattern B: "96CF A Kylian Mbappé"
      if (!name) { m = raw.match(/^(\d{2,3})([A-Z]{1,4})\s+[A-E]\s+(.+)$/); if(m){overall=parseInt(m[1]);position=m[2];name=m[3].trim();} }

      // Pattern C: "96 CF Kylian Mbappé"
      if (!name) { m = raw.match(/^(\d{2,3})\s+([A-Z]{1,4})\s+(.+)$/); if(m){overall=parseInt(m[1]);position=m[2];name=m[3].trim();} }

      // Pattern D: "Kylian Mbappé 96 CF"
      if (!name) { m = raw.match(/^(.+?)\s+(\d{2,3})\s+([A-Z]{1,4})$/); if(m){name=m[1].trim();overall=parseInt(m[2]);position=m[3];} }

      // Pattern E: just extract any number 80-99 as overall
      if (!name) {
        const numMatch = raw.match(/\b(\d{2})\b/);
        const posMatch = raw.match(/\b(GK|CB|LB|RB|DMF|CMF|AMF|LWF|RWF|SS|CF|ST|CAM|CDM|CM|LM|RM)\b/i);
        // Remove the number and position to get the name
        let nameCandidate = raw.replace(/\b\d{2,3}\b/, '').replace(/\b[A-E]\b/, '').replace(/\b(GK|CB|LB|RB|DMF|CMF|AMF|LWF|RWF|SS|CF|ST|CAM|CDM|CM|LM|RM)\b/i, '').trim();
        if (nameCandidate.length > 2) {
          name = nameCandidate;
          if (numMatch) overall = parseInt(numMatch[1]);
          if (posMatch) position = posMatch[1].toUpperCase();
        }
      }

      // Fallback: whole text as name
      if (!name && raw.length > 2) name = raw;

      if (name && !seen.has(name)) {
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
  console.log(`\nTier list: ${withOverall.length} players with ratings`);

  const scored = withOverall.map(p => ({
    ...p,
    score: p.overall + (p.type==='epic'?3 : p.type==='legend'?2 : p.type==='featured'?1 : 0)
  }));

  const byName = {};
  scored.forEach(p => { if (!byName[p.name] || p.score > byName[p.name].score) byName[p.name] = p; });
  const unique = Object.values(byName).sort((a,b) => b.score - a.score);

  const tiers = { S:[], A:[], B:[], C:[], D:[] };
  unique.forEach(p => {
    const s = p.score;
    if      (s >= 97) tiers.S.push(p);
    else if (s >= 94) tiers.A.push(p);
    else if (s >= 91) tiers.B.push(p);
    else if (s >= 88) tiers.C.push(p);
    else              tiers.D.push(p);
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
    // Use Jina to fetch Reddit as readable text
    const res = await fetch('https://r.jina.ai/https://www.reddit.com/r/eFootball/new/', {
      headers: { 'User-Agent': 'EFMetaBot/1.0', 'Accept': 'text/plain' }
    });
    const text = await res.text();
    console.log(`  Jina response: ${text.length} chars`);

    // Extract post titles — they appear as markdown links or lines starting with titles
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 15 && l.length < 250);
    
    // Look for lines that look like Reddit titles (not metadata)
    const titleLines = lines.filter(l =>
      !l.startsWith('http') &&
      !l.startsWith('r/') &&
      !l.startsWith('u/') &&
      !l.match(/^\d+ (point|comment|hour|minute|day)/) &&
      l.match(/[a-zA-Z]{3,}/)
    ).slice(0, 10);

    titleLines.forEach((title, i) => {
      articles.push({
        title,
        url: 'https://www.reddit.com/r/eFootball/new/',
        source: 'Reddit r/eFootball',
        time: new Date().toISOString(),
        score: null
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
  const finalPlayers = Object.values(byName).sort((a,b) => (b.overall||0) - (a.overall||0));

  fs.writeFileSync(path.join(PUBLIC,'players.json'), JSON.stringify({ scraped_at: new Date().toISOString(), count: finalPlayers.length, players: finalPlayers }, null, 2));
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
