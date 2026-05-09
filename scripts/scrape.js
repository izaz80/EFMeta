// scripts/scrape.js
// Pulls latest Epic, Featured, and top-rated players from efootballhub.net
// Saves to public/players.json for the frontend to consume

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';

const BASE = 'https://www.efootballhub.net/efootball23';

const ENDPOINTS = [
  { label: 'epic',     url: `${BASE}/search/players?epic=true&GridView=true` },
  { label: 'featured', url: `${BASE}/search/players?agentSearch=true&GridView=true` },
  { label: 'legend',   url: `${BASE}/search/players?legend=true&GridView=true` },
  { label: 'new',      url: `${BASE}/search/players?newPlayers=true&GridView=true` },
];

async function scrapePage(label, url) {
  console.log(`Scraping ${label}: ${url}`);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; EFMetaBot/1.0)',
        'Accept': 'text/html'
      }
    });
    const html = await res.text();
    const $ = cheerio.load(html);

    const players = [];

    // efootballhub player links have the pattern /efootball23/player/ID
    $('a[href*="/efootball23/player/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim();

      if (!text || text.length < 3) return;

      // Parse the text format: e.g. "8699CF AEnzo Fernández" or "96CMF APedri"
      // Format: [overall][position] [condition][name]
      const match = text.match(/^(\d{2,3})([A-Z/]+)\s+([A-E])\s*(.+)$/);

      if (match) {
        players.push({
          overall: parseInt(match[1]),
          position: match[2],
          condition: match[3],
          name: match[4].trim(),
          type: label,
          url: href.startsWith('http') ? href : `https://www.efootballhub.net${href}`
        });
      } else if (text.length > 2 && text.length < 60) {
        // Fallback: just grab the name
        players.push({
          overall: null,
          position: null,
          condition: null,
          name: text,
          type: label,
          url: href.startsWith('http') ? href : `https://www.efootballhub.net${href}`
        });
      }
    });

    // Dedupe by name
    const seen = new Set();
    return players.filter(p => {
      if (seen.has(p.name)) return false;
      seen.add(p.name);
      return true;
    });

  } catch (err) {
    console.error(`Failed to scrape ${label}:`, err.message);
    return [];
  }
}

async function main() {
  const allPlayers = [];

  for (const endpoint of ENDPOINTS) {
    const players = await scrapePage(endpoint.label, endpoint.url);
    console.log(`  → ${players.length} players found`);
    allPlayers.push(...players);
  }

  // Global dedupe by name, keep highest overall
  const byName = {};
  allPlayers.forEach(p => {
    if (!byName[p.name] || (p.overall > (byName[p.name].overall || 0))) {
      byName[p.name] = p;
    }
  });

  const final = Object.values(byName).sort((a, b) => (b.overall || 0) - (a.overall || 0));

  const output = {
    scraped_at: new Date().toISOString(),
    count: final.length,
    players: final
  };

  const outPath = path.join(process.cwd(), 'public', 'players.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`\n✓ Saved ${final.length} players to public/players.json`);
}

main();
