const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
const Redis   = require('ioredis');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// Redis
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: false });
  redis.on('connect', () => console.log('[Redis] Connected'));
  redis.on('error',   e  => console.error('[Redis]', e.message));
}
async function redisSave(token, entry) {
  if (!redis) return;
  try { await redis.set('lv:token:' + token, JSON.stringify({ createdAt: entry.createdAt, lastUsed: entry.lastUsed, reqCount: entry.reqCount })); }
  catch (e) { console.error('[Redis] Save failed:', e.message); }
}
async function redisLoad(token) {
  if (!redis) return null;
  try { const d = await redis.get('lv:token:' + token); return d ? JSON.parse(d) : null; }
  catch (e) { return null; }
}

// Token store
const TOKEN_CACHE       = new Map();
const IP_CREATES        = new Map();
const MAX_TOKENS_PER_IP = 10;
const RATE_MAX          = 60;
const RATE_WINDOW_MS    = 60000;

function generateToken() { return crypto.randomBytes(14).toString('hex'); }
function getOrCreateIpBucket(ip) {
  const now = Date.now();
  let b = IP_CREATES.get(ip);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 86400000 }; IP_CREATES.set(ip, b); }
  return b;
}
async function getTokenEntry(token) {
  if (TOKEN_CACHE.has(token)) return TOKEN_CACHE.get(token);
  const saved = await redisLoad(token);
  if (!saved) return null;
  const entry = { createdAt: saved.createdAt, lastUsed: saved.lastUsed, reqCount: saved.reqCount, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  return entry;
}
function checkRateLimit(entry) {
  const now = Date.now();
  entry.rateWin = (entry.rateWin || []).filter(t => now - t < RATE_WINDOW_MS);
  if (entry.rateWin.length >= RATE_MAX) return false;
  entry.rateWin.push(now); entry.lastUsed = now; entry.reqCount = (entry.reqCount || 0) + 1;
  return true;
}
async function tokenMiddleware(req, res, next) {
  const entry = await getTokenEntry(req.params.token);
  if (!entry) return res.status(404).json({ error: 'Invalid token.' });
  if (!checkRateLimit(entry)) return res.status(429).json({ error: 'Rate limit exceeded. Try again in a minute.' });
  req.tokenEntry = entry;
  if (entry.reqCount % 20 === 0) redisSave(req.params.token, entry);
  next();
}

function getBaseUrl(req) { return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host'); }
function cleanText(s)    { return String(s || '').replace(/\s+/g, ' ').trim(); }

// Strip leading articles so "The War of the Worlds" also matches "War of the Worlds"
function normalizeQuery(q) {
  return q.replace(/^(the|a|an)\s+/i, '').trim();
}

// Multi-strategy LibriVox search: fires several title variants + author in parallel
async function searchBooks(q) {
  const titleVariants = new Set([q]);
  const norm = normalizeQuery(q);
  if (norm !== q) titleVariants.add(norm);
  const words = q.split(/\s+/);
  if (words.length > 3) titleVariants.add(words.slice(0, 3).join(' '));
  if (words.length > 2) titleVariants.add(words.slice(0, 2).join(' '));
  // Detect "title by author" and search by title part too
  const byMatch = q.match(/^(.+?)\s+by\s+(.+)$/i);
  if (byMatch) titleVariants.add(byMatch[1].trim());

  const [authorData, ...titleResults] = await Promise.all([
    lvGet('/audiobooks', { author: q, limit: 10, extended: 1, coverart: 1 }),
    ...[...titleVariants].map(tq =>
      lvGet('/audiobooks', { title: tq, limit: 12, extended: 1, coverart: 1 })
    )
  ]);
  const seen = new Set();
  const allBooks = [];
  for (const data of [...titleResults, authorData]) {
    for (const book of lvBooks(data)) {
      const bid = String(book.id);
      if (!seen.has(bid)) { seen.add(bid); allBooks.push(book); }
    }
  }
  return allBooks;
}

// Caches
const CHAPTER_CACHE = new Map();
const BOOK_CACHE    = new Map();
function cacheChapter(ch) { if (ch && ch.id) CHAPTER_CACHE.set(String(ch.id), ch); }


const SOURCE_TIMEOUT_MS = 9000;

function dedupeById(items) {
  const seen = new Set();
  return (items || []).filter(x => {
    if (!x || !x.id) return false;
    if (seen.has(x.id)) return false;
    seen.add(x.id);
    return true;
  });
}

function uniqBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of (items || [])) {
    const k = keyFn(item);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

async function fetchWithTimeout(url, opts = {}, timeout = SOURCE_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    return await axios.get(url, { ...opts, signal: controller.signal, timeout });
  } finally {
    clearTimeout(t);
  }
}

function htmlDecode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripTags(s) {
  return cleanText(htmlDecode(String(s || '').replace(/<[^>]+>/g, ' ')));
}

function safeUrl(u) {
  return /^https?:\/\//i.test(String(u || '')) ? String(u) : null;
}

function parseXmlItems(xml, tag) {
  const rx = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out = [];
  let m;
  while ((m = rx.exec(xml))) out.push(m[1]);
  return out;
}

function getXmlValue(block, tag) {
  const m = String(block || '').match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? stripTags(m[1]) : '';
}

function getXmlAttr(block, tag, attr) {
  const m = String(block || '').match(new RegExp(`<${tag}\\b[^>]*${attr}=["']([^"']+)["'][^>]*>`, 'i'));
  return m ? m[1] : '';
}

async function loyalSearch(q) {
  try {
    const url = 'https://www.loyalbooks.com/search';
    const r = await fetchWithTimeout(url, {
      params: { type: 'all', search: q },
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' }
    });
    const html = String(r.data || '');
    const cardRx = /<a[^>]+href="(https:\/\/www\.loyalbooks\.com\/book\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const books = [];
    const seen = new Set();
    let m;
    while ((m = cardRx.exec(html)) && books.length < 12) {
      const pageUrl = m[1];
      if (seen.has(pageUrl)) continue;
      seen.add(pageUrl);
      const chunk = m[2];
      const title = stripTags((chunk.match(/class="book-title"[^>]*>([\s\S]*?)<\//i) || [,''])[1]) || stripTags(chunk).slice(0, 160);
      const author = stripTags((chunk.match(/class="book-author"[^>]*>([\s\S]*?)<\//i) || [,''])[1]) || 'Unknown Author';
      const img = safeUrl((chunk.match(/<img[^>]+src="([^"]+)"/i) || [,''])[1]);
      books.push({
        id: 'lb_book_' + Buffer.from(pageUrl).toString('base64url').slice(0, 48),
        title: cleanText(title),
        artist: cleanText(author),
        artworkURL: img,
        sourcePage: pageUrl,
        source: 'Loyal Books'
      });
    }
    return books;
  } catch (e) {
    console.warn('[LOYAL search]', e.message);
    return [];
  }
}

async function loyalAlbum(id) {
  try {
    const enc = id.replace('lb_book_', '');
    const pageUrl = Buffer.from(enc, 'base64url').toString('utf8');
    const r = await fetchWithTimeout(pageUrl, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' } });
    const html = String(r.data || '');
    const title = cleanText(stripTags((html.match(/<title>([\s\S]*?)<\/title>/i) || [,''])[1]).replace(/\s*\|.*$/, ''));
    const artwork = safeUrl((html.match(/property="og:image" content="([^"]+)"/i) || [,''])[1]) || safeUrl((html.match(/<img[^>]+class="book-cover"[^>]+src="([^"]+)"/i) || [,''])[1]);
    const author = cleanText(stripTags((html.match(/by\s*<a[^>]*>([\s\S]*?)<\/a>/i) || [,''])[1])) || 'Unknown Author';
    const rss = safeUrl((html.match(/href="([^"]+\.xml(?:\?[^"#]*)?)"[^>]*>\s*RSS Feed/i) || [,''])[1]) || safeUrl((html.match(/href="([^"]+)"[^>]*>\s*iTunes Podcast/i) || [,''])[1]);
    if (!rss) return null;

    const xr = await fetchWithTimeout(rss, { headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml,text/xml,application/xml' } });
    const xml = String(xr.data || '');
    const items = parseXmlItems(xml, 'item');
    const tracks = items.map((item, idx) => {
      const t = getXmlValue(item, 'title') || ('Chapter ' + (idx + 1));
      const en = getXmlAttr(item, 'enclosure', 'url') || getXmlValue(item, 'link');
      const dur = parseHMS(getXmlValue(item, 'itunes:duration'));
      return {
        id: 'lb_tr_' + Buffer.from(pageUrl + '::' + idx).toString('base64url').slice(0, 54),
        title: cleanText(t),
        artist: author,
        album: title,
        duration: dur,
        artworkURL: artwork,
        streamURL: safeUrl(en),
        format: 'mp3'
      };
    }).filter(t => t.streamURL);

    tracks.forEach(cacheChapter);
    return { id, title, artist: author, artworkURL: artwork, trackCount: tracks.length, tracks };
  } catch (e) {
    console.warn('[LOYAL album]', e.message);
    return null;
  }
}

async function openCultureSearch(q) {
  try {
    const url = 'https://www.openculture.com/freeaudiobooks';
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' } });
    const html = String(r.data || '');
    const linkRx = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const out = [];
    let m;
    while ((m = linkRx.exec(html)) && out.length < 12) {
      const href = safeUrl(m[1]);
      const text = cleanText(stripTags(m[2]));
      if (!href || !text) continue;
      if (!text.toLowerCase().includes(q.toLowerCase())) continue;
      out.push({
        id: 'oc_book_' + Buffer.from(href).toString('base64url').slice(0, 48),
        title: text,
        artist: 'Open Culture',
        artworkURL: null,
        sourcePage: href,
        source: 'Open Culture'
      });
    }
    return uniqBy(out, x => x.title.toLowerCase());
  } catch (e) {
    console.warn('[OC search]', e.message);
    return [];
  }
}

async function iaSearch(q) {
  try {
    const url = 'https://archive.org/advancedsearch.php';
    const params = {
      q: `mediatype:(audio) AND (${q})`,
      fl: 'identifier,title,creator,description,collection,mediatype',
      sort: 'downloads desc',
      rows: 12,
      page: 1,
      output: 'json'
    };
    const r = await fetchWithTimeout(url, { params, headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    const docs = (((r.data || {}).response || {}).docs || []);
    return docs.map(d => ({
      id: 'ia_book_' + String(d.identifier),
      title: cleanText(d.title || d.identifier),
      artist: cleanText(Array.isArray(d.creator) ? d.creator.join(', ') : (d.creator || 'Internet Archive')),
      artworkURL: 'https://archive.org/services/img/' + String(d.identifier),
      sourcePage: 'https://archive.org/details/' + String(d.identifier),
      identifier: String(d.identifier),
      source: 'Internet Archive'
    }));
  } catch (e) {
    console.warn('[IA search]', e.message);
    return [];
  }
}

async function iaAlbum(id) {
  try {
    const identifier = id.replace('ia_book_', '');
    const url = 'https://archive.org/metadata/' + encodeURIComponent(identifier);
    const r = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    const data = r.data || {};
    const meta = data.metadata || {};
    const files = Array.isArray(data.files) ? data.files : [];
    const title = cleanText(meta.title || identifier);
    const artist = cleanText(Array.isArray(meta.creator) ? meta.creator.join(', ') : (meta.creator || 'Internet Archive'));
    const artwork = 'https://archive.org/services/img/' + identifier;
    const audioFiles = files.filter(f => {
      const name = String(f.name || '').toLowerCase();
      const format = String(f.format || '').toLowerCase();
      return /\.(mp3|m4a|ogg|flac)$/i.test(name) || /(mp3|mpeg|vbr mp3|64kbps mp3|audio|ogg|flac|m4a)/i.test(format);
    }).filter(f => !/\.jpg$|\.png$|_spectrogram\./i.test(String(f.name || '')));

    const tracks = audioFiles.slice(0, 200).map((f, idx) => ({
      id: 'ia_tr_' + identifier + '_' + idx,
      title: cleanText(f.title || f.name || ('Track ' + (idx + 1))),
      artist,
      album: title,
      duration: f.length ? parseHMS(String(f.length)) : null,
      artworkURL: artwork,
      streamURL: 'https://archive.org/download/' + encodeURIComponent(identifier) + '/' + encodeURIComponent(f.name),
      format: (/\.m4a$/i.test(String(f.name || '')) ? 'm4a' : /\.ogg$/i.test(String(f.name || '')) ? 'ogg' : /\.flac$/i.test(String(f.name || '')) ? 'flac' : 'mp3')
    })).filter(t => t.streamURL);

    tracks.forEach(cacheChapter);
    return { id, title, artist, artworkURL: artwork, trackCount: tracks.length, tracks };
  } catch (e) {
    console.warn('[IA album]', e.message);
    return null;
  }
}

async function multiSourceSearch(q) {
  const [lvBooksFound, loyalBooks, iaBooks, ocBooks] = await Promise.all([
    searchBooks(q),
    loyalSearch(q),
    iaSearch(q),
    openCultureSearch(q)
  ]);

  const lvAlbums = lvBooksFound.map(mapBookToAlbum).map(x => ({ ...x, source: 'LibriVox' }));
  const otherAlbums = [
    ...loyalBooks.map(b => ({ id: b.id, title: b.title, artist: b.artist, artworkURL: b.artworkURL, trackCount: null, year: null, source: 'Loyal Books' })),
    ...iaBooks.map(b => ({ id: b.id, title: b.title, artist: b.artist, artworkURL: b.artworkURL, trackCount: null, year: null, source: 'Internet Archive' })),
    ...ocBooks.map(b => ({ id: b.id, title: b.title, artist: b.artist, artworkURL: b.artworkURL, trackCount: null, year: null, source: 'Open Culture' }))
  ];

  const lvTracks = lvBooksFound.slice(0, 8).map(mapBookToTrack);
  const instantTracks = [];
  for (const b of iaBooks.slice(0, 6)) {
    instantTracks.push({
      id: b.id,
      title: b.title,
      artist: b.artist,
      album: b.title,
      duration: null,
      artworkURL: b.artworkURL,
      streamURL: null,
      format: 'mp3'
    });
  }

  const albums = uniqBy([...lvAlbums, ...otherAlbums], x => (x.title + '|' + x.artist).toLowerCase()).slice(0, 30);
  const tracks = uniqBy([...lvTracks, ...instantTracks], x => (x.title + '|' + x.artist).toLowerCase()).slice(0, 16);

  const artistMap = new Map();
  lvBooksFound.forEach(book => {
    if (!Array.isArray(book.authors)) return;
    book.authors.forEach(a => {
      const name = cleanText([a.first_name, a.last_name].filter(Boolean).join(' '));
      const key = name.toLowerCase();
      if (!name || artistMap.has(key)) return;
      artistMap.set(key, {
        id: (a.id && !isNaN(Number(a.id))) ? 'lv_author_' + String(a.id) : 'lv_authorname_' + encodeURIComponent(name),
        name,
        artworkURL: bookArtwork(book),
        genres: (Array.isArray(book.genres) ? book.genres.map(g => g.name) : []).slice(0, 2)
      });
    });
  });

  const playlists = [
    { id: 'src_librivox', title: 'LibriVox Picks', creator: 'LibriVox', artworkURL: null, trackCount: lvAlbums.length },
    { id: 'src_loyal', title: 'Loyal Books Picks', creator: 'Loyal Books', artworkURL: null, trackCount: loyalBooks.length },
    { id: 'src_ia', title: 'Internet Archive Picks', creator: 'Internet Archive', artworkURL: null, trackCount: iaBooks.length },
    { id: 'src_oc', title: 'Open Culture Picks', creator: 'Open Culture', artworkURL: null, trackCount: ocBooks.length }
  ].filter(x => x.trackCount > 0);

  return {
    tracks: dedupeById(tracks),
    albums,
    artists: Array.from(artistMap.values()).slice(0, 10),
    playlists
  };
}

// LibriVox API
const LV_BASE = 'https://librivox.org/api/feed';
const UA      = 'Mozilla/5.0 (compatible; EclipseLibriVoxAddon/1.0)';

async function lvGet(endpoint, params) {
  try {
    const r = await axios.get(LV_BASE + endpoint, {
      params: { ...params, format: 'json' },
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      timeout: 14000
    });
    return r.data;
  } catch (e) { console.warn('[LV]', endpoint, e.message); return null; }
}
function lvBooks(data)    { return (data && Array.isArray(data.books))    ? data.books    : []; }
function lvSections(data) { return (data && Array.isArray(data.sections)) ? data.sections : []; }
function lvAuthors(data)  { return (data && Array.isArray(data.authors))  ? data.authors  : []; }

function bookArtwork(book) {
  if (!book) return null;
  // cover_url - skip generic LibriVox placeholders
  if (book.cover_url && book.cover_url.startsWith('http') &&
      !book.cover_url.includes('librivox_square_logo') &&
      !book.cover_url.includes('no_cover') &&
      !book.cover_url.includes('/img/librivox')) {
    return book.cover_url;
  }
  // Extract archive.org identifier from any URL field
  const candidates = [book.url_zip_file, book.url_iarchive].filter(Boolean);
  for (const u of candidates) {
    const m = String(u).match(/archive\.org\/(?:download|details)\/([^/?#\/]+)/);
    if (m && m[1]) return 'https://archive.org/services/img/' + m[1];
  }
  // Derive identifier from url_librivox slug (slug + _librivox pattern is common)
  if (book.url_librivox) {
    const ms = String(book.url_librivox).match(/librivox\.org\/([a-z0-9-]+)\/?$/i);
    if (ms && ms[1]) {
      const slug = ms[1].replace(/-/g, '');
      return 'https://archive.org/services/img/' + slug + '_librivox';
    }
  }
  // Open Library fallback by title
  if (book.title) {
    const t = encodeURIComponent(cleanText(book.title));
    return 'https://covers.openlibrary.org/b/title/' + t + '-M.jpg';
  }
  return null;
}

function parseHMS(s) {
  if (!s) return null;
  const parts = String(s).trim().split(':').map(Number);
  let secs;
  if (parts.length === 3) secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) secs = parts[0] * 60 + parts[1];
  else if (parts.length === 1 && !isNaN(parts[0])) secs = parts[0];
  else return null;
  return secs > 0 ? secs : null;
}

function getAuthorName(book) {
  const authors = book && book.authors;
  if (!authors || !Array.isArray(authors) || !authors.length) return 'Unknown Author';
  return cleanText(authors.map(a => [a.first_name, a.last_name].filter(Boolean).join(' ')).join(', '));
}

function mapBookToAlbum(book) {
  const art    = bookArtwork(book);
  const author = getAuthorName(book);
  const bookId = String(book.id);
  BOOK_CACHE.set(bookId, { title: cleanText(book.title), artist: author, artworkURL: art });
  return {
    id:         'lv_book_' + bookId,
    title:      cleanText(book.title),
    artist:     author,
    artworkURL: art,
    trackCount: book.num_sections ? parseInt(book.num_sections) : null,
    year:       book.copyright_year ? String(book.copyright_year) : null
  };
}

function mapBookToTrack(book) {
  const art    = bookArtwork(book);
  const author = getAuthorName(book);
  const bookId = String(book.id);
  const obj = {
    id:         'lv_track_' + bookId,
    title:      cleanText(book.title),
    artist:     author,
    album:      cleanText(book.title),
    duration:   (() => { const s = parseInt(book.totaltimesecs) || 0; return s > 0 ? s : null; })(),
    artworkURL: art,
    streamURL:  null,
    format:     'mp3'
  };
  cacheChapter(obj);
  return obj;
}

function mapSectionToTrack(section, bookId) {
  const bookMeta = BOOK_CACHE.get(String(bookId)) || {};
  const secNum   = String(section.section_number || section.play_order || section.id);
  const id       = 'lv_ch_' + String(bookId) + '_' + secNum;
  const obj = {
    id,
    title:      cleanText(section.title) || ('Chapter ' + secNum),
    artist:     bookMeta.artist    || 'LibriVox',
    album:      bookMeta.title     || '',
    duration:   parseHMS(section.duration),
    artworkURL: bookMeta.artworkURL || null,
    streamURL:  section.listen_url  || null,
    format:     'mp3'
  };
  cacheChapter(obj);
  return obj;
}

// Config page
function buildConfigPage(baseUrl) {
  let h = '';
  h += '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">';
  h += '<meta name="viewport" content="width=device-width,initial-scale=1">';
  h += '<title>LibriVox for Eclipse</title>';
  h += '<style>';
  h += '*{box-sizing:border-box;margin:0;padding:0}';
  h += 'body{background:#0c0a08;color:#e8e4de;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}';
  h += '.logo-wrap{display:flex;align-items:center;gap:14px;margin-bottom:28px}';
  h += '.logo-text{font-size:26px;font-weight:800;color:#c8a53a;letter-spacing:-.02em}.logo-sub{font-size:13px;color:#554e3a;margin-top:3px}';
  h += '.card{background:#131109;border:1px solid #2a2310;border-radius:18px;padding:36px;max-width:540px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.6);margin-bottom:20px}';
  h += 'h2{font-size:16px;font-weight:700;margin-bottom:14px;color:#fff}';
  h += 'p.sub{font-size:14px;color:#6a6457;margin-bottom:20px;line-height:1.6}';
  h += '.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px}';
  h += '.stat{background:#110e06;border:1px solid #2a2000;border-radius:10px;padding:14px;text-align:center}';
  h += '.stat-n{font-size:22px;font-weight:800;color:#c8a53a}.stat-l{font-size:11px;color:#554e3a;margin-top:3px}';
  h += '.pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}';
  h += '.pill{border-radius:20px;font-size:11px;font-weight:600;padding:4px 10px;background:#1a1400;color:#c8a53a;border:1px solid #3a2e08}';
  h += '.pill.g{background:#0a1a0a;color:#6db86d;border-color:#2d422a}';
  h += '.lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#554e3a;margin-bottom:8px;margin-top:16px}';
  h += 'input{width:100%;background:#0c0a06;border:1px solid #2a2000;border-radius:10px;color:#e8e4de;font-size:14px;padding:12px 14px;margin-bottom:6px;outline:none;transition:border-color .15s}';
  h += 'input:focus{border-color:#c8a53a}input::placeholder{color:#2a2416}';
  h += '.hint{font-size:12px;color:#484030;margin-bottom:12px;line-height:1.7}.hint code{background:#1a1400;padding:1px 5px;border-radius:4px;color:#6a5a28}';
  h += 'button{cursor:pointer;border:none;border-radius:10px;font-size:15px;font-weight:700;padding:13px;width:100%;margin-top:6px;margin-bottom:12px;transition:background .15s}';
  h += '.bo{background:#c8a53a;color:#0c0a00}.bo:hover{background:#e0bc50}.bo:disabled{background:#252014;color:#444;cursor:not-allowed}';
  h += '.bg{background:#1a2a14;color:#e8e4de;border:1px solid #3a5020}.bg:hover{background:#243a1a}.bg:disabled{background:#1a1a14;color:#444;cursor:not-allowed}';
  h += '.bd{background:#1a1a14;color:#aaa;border:1px solid #2a2a18;font-size:13px;padding:10px}.bd:hover{background:#222218;color:#fff}';
  h += '.box{display:none;background:#0c0a06;border:1px solid #2a2000;border-radius:12px;padding:18px;margin-bottom:14px}';
  h += '.blbl{font-size:10px;color:#554e3a;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}';
  h += '.burl{font-size:12px;color:#c8a53a;word-break:break-all;font-family:"SF Mono",ui-monospace,monospace;margin-bottom:14px;line-height:1.5}';
  h += 'hr{border:none;border-top:1px solid #1a1600;margin:24px 0}';
  h += '.steps{display:flex;flex-direction:column;gap:12px}.step{display:flex;gap:12px;align-items:flex-start}';
  h += '.sn{background:#1a1400;border:1px solid #2a2000;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#6a5a28}';
  h += '.st{font-size:13px;color:#6a6457;line-height:1.6}.st b{color:#aaa}';
  h += '.warn{background:#141008;border:1px solid #2a2000;border-radius:10px;padding:14px;margin-top:20px;font-size:12px;color:#6a5a28;line-height:1.7}';
  h += '.status{font-size:13px;color:#6a5a28;margin:8px 0;min-height:18px}.status.ok{color:#6db86d}.status.err{color:#c0392b}.status.spin{color:#c8a53a}';
  h += '.preview{background:#0c0a06;border:1px solid #1a1600;border-radius:10px;padding:12px;max-height:200px;overflow-y:auto;margin-bottom:12px;display:none}';
  h += '.tr{display:flex;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid #181200;font-size:13px}.tr:last-child{border-bottom:none}';
  h += '.tn{color:#444;font-size:11px;min-width:22px;text-align:right}.ti{flex:1;min-width:0}';
  h += '.tt{color:#e8e4de;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ta{color:#666;font-size:11px}';
  h += 'footer{margin-top:32px;font-size:12px;color:#3a3020;text-align:center;line-height:1.8}footer a{color:#3a3020;text-decoration:none}';
  h += '</style></head><body>';

  h += '<div class="logo-wrap">';
  h += '<svg width="52" height="52" viewBox="0 0 52 52" fill="none"><circle cx="26" cy="26" r="26" fill="#1a1400"/><rect x="10" y="32" width="32" height="4" rx="2" fill="#c8a53a"/><rect x="14" y="26" width="24" height="4" rx="2" fill="#c8a53a" opacity=".7"/><rect x="18" y="20" width="16" height="4" rx="2" fill="#c8a53a" opacity=".45"/><rect x="22" y="14" width="8" height="4" rx="2" fill="#c8a53a" opacity=".25"/></svg>';
  h += '<div><div class="logo-text">LibriVox</div><div class="logo-sub">for Eclipse Music</div></div></div>';

  h += '<div class="card">';
  h += '<div class="stat-grid">';
  h += '<div class="stat"><div class="stat-n">20k+</div><div class="stat-l">Audiobooks</div></div>';
  h += '<div class="stat"><div class="stat-n">100%</div><div class="stat-l">Free Forever</div></div>';
  h += '<div class="stat"><div class="stat-n">30+</div><div class="stat-l">Languages</div></div>';
  h += '</div>';
  h += '<p class="sub">Classic literature, philosophy, poetry & more. All public domain, all free, all streamable inside Eclipse. No account or API key needed \u2014 just click generate.</p>';
  h += '<div class="pills"><span class="pill">Literature</span><span class="pill">Philosophy</span><span class="pill">Poetry</span><span class="pill">Mystery</span><span class="pill">Sci-Fi</span><span class="pill">History</span><span class="pill g">No signup needed</span><span class="pill g">Offline download</span></div>';
  h += '<button class="bo" id="genBtn" onclick="generate()">Generate My Addon URL</button>';
  h += '<div class="box" id="genBox"><div class="blbl">Your addon URL \u2014 paste into Eclipse</div><div class="burl" id="genUrl"></div><button class="bd" id="copyBtn" onclick="copyUrl()">Copy URL</button></div>';
  h += '<div class="status" id="genStatus"></div>';
  h += '<hr>';
  h += '<div class="lbl">Restore an existing URL</div>';
  h += '<input type="text" id="existingUrl" placeholder="Paste your existing addon URL here">';
  h += '<button class="bg" id="refBtn" onclick="doRefresh()">Restore Existing URL</button>';
  h += '<div class="box" id="refBox"><div class="blbl">Restored \u2014 still works in Eclipse</div><div class="burl" id="refUrl"></div><button class="bd" id="copyRefBtn" onclick="copyRef()">Copy URL</button></div>';
  h += '<hr>';
  h += '<div class="steps">';
  h += '<div class="step"><div class="sn">1</div><div class="st">Click <b>Generate My Addon URL</b> above</div></div>';
  h += '<div class="step"><div class="sn">2</div><div class="st">Copy your URL</div></div>';
  h += '<div class="step"><div class="sn">3</div><div class="st">Open <b>Eclipse</b> \u2192 Settings \u2192 Connections \u2192 Add Connection \u2192 Addon</div></div>';
  h += '<div class="step"><div class="sn">4</div><div class="st">Paste your URL and tap <b>Install</b></div></div>';
  h += '</div>';
  h += '<div class="warn">Your token is saved to Redis \u2014 it survives server restarts. Each person should generate their own URL for separate rate limits.</div>';
  h += '</div>';

  h += '<div class="card">';
  h += '<h2>Import a Book to Eclipse Library</h2>';
  h += '<p class="sub">Downloads a CSV for Library \u2192 Import CSV in Eclipse. Each chapter becomes a track.</p>';
  h += '<div class="lbl">Your Addon URL</div>';
  h += '<input type="text" id="impToken" placeholder="Paste your addon URL (auto-fills after generating)">';
  h += '<div class="lbl">Book Title or LibriVox URL</div>';
  h += '<input type="text" id="impQuery" placeholder="Pride and Prejudice  or  https://librivox.org/...">';
  h += '<div class="hint">Examples: <code>Sherlock Holmes</code>, <code>The War of the Worlds</code>, or a full <code>librivox.org</code> URL.</div>';
  h += '<div class="status" id="impStatus"></div>';
  h += '<div class="preview" id="impPreview"></div>';
  h += '<button class="bg" id="impBtn" onclick="doImport()">Fetch &amp; Download CSV</button>';
  h += '</div>';

  h += '<footer>Eclipse LibriVox Addon v1.0.0 &bull; Powered by <a href="https://librivox.org" target="_blank">LibriVox.org</a> &bull; <a href="' + baseUrl + '/health" target="_blank">Health</a></footer>';

  h += '<script>';
  h += 'var _gu="",_ru="";';

  h += 'function generate(){';
  h += 'var btn=document.getElementById("genBtn"),st=document.getElementById("genStatus");';
  h += 'btn.disabled=true;btn.textContent="Generating...";st.className="status spin";st.textContent="Creating your token\u2026";';
  h += 'fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})';
  h += '.then(r=>r.json()).then(d=>{';
  h += 'if(d.error){st.className="status err";st.textContent=d.error;btn.disabled=false;btn.textContent="Generate My Addon URL";return;}';
  h += '_gu=d.manifestUrl;document.getElementById("genUrl").textContent=_gu;document.getElementById("genBox").style.display="block";document.getElementById("impToken").value=_gu;';
  h += 'st.className="status ok";st.textContent="\u2713 Your addon URL is ready";btn.disabled=false;btn.textContent="Regenerate URL";})';
  h += '.catch(e=>{st.className="status err";st.textContent="Error: "+e.message;btn.disabled=false;btn.textContent="Generate My Addon URL";});}';

  h += 'function copyUrl(){if(!_gu)return;navigator.clipboard.writeText(_gu).then(()=>{var b=document.getElementById("copyBtn");b.textContent="Copied!";setTimeout(()=>b.textContent="Copy URL",1500);});}';

  h += 'function doRefresh(){';
  h += 'var btn=document.getElementById("refBtn"),eu=document.getElementById("existingUrl").value.trim();';
  h += 'if(!eu){alert("Paste your existing addon URL first.");return;}';
  h += 'btn.disabled=true;btn.textContent="Checking\u2026";';
  h += 'fetch("/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({existingUrl:eu})})';
  h += '.then(r=>r.json()).then(d=>{';
  h += 'if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Restore Existing URL";return;}';
  h += '_ru=d.manifestUrl;document.getElementById("refUrl").textContent=_ru;document.getElementById("refBox").style.display="block";document.getElementById("impToken").value=_ru;';
  h += 'btn.disabled=false;btn.textContent="Restore Again";})';
  h += '.catch(e=>{alert("Error: "+e.message);btn.disabled=false;btn.textContent="Restore Existing URL";});}';

  h += 'function copyRef(){if(!_ru)return;navigator.clipboard.writeText(_ru).then(()=>{var b=document.getElementById("copyRefBtn");b.textContent="Copied!";setTimeout(()=>b.textContent="Copy URL",1500);});}';

  h += 'function hesc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}';
  h += 'function getTok(s){var m=s.match(/\\/u\\/([a-f0-9]{28})\\//);return m?m[1]:null;}';

  h += 'function doImport(){';
  h += 'var btn=document.getElementById("impBtn"),raw=document.getElementById("impToken").value.trim(),q=document.getElementById("impQuery").value.trim(),st=document.getElementById("impStatus"),pv=document.getElementById("impPreview");';
  h += 'if(!raw){st.className="status err";st.textContent="Paste your addon URL first.";return;}';
  h += 'if(!q){st.className="status err";st.textContent="Enter a book title or LibriVox URL.";return;}';
  h += 'var tok=getTok(raw);if(!tok){st.className="status err";st.textContent="Could not find your token in the URL.";return;}';
  h += 'btn.disabled=true;btn.textContent="Fetching\u2026";st.className="status spin";st.textContent="Fetching chapters\u2026";pv.style.display="none";';
  h += 'fetch("/u/"+tok+"/import?q="+encodeURIComponent(q))';
  h += '.then(r=>{if(!r.ok)return r.json().then(e=>{throw new Error(e.error||"Server error "+r.status);});return r.json();})';
  h += '.then(data=>{';
  h += 'var tracks=data.tracks||[];if(!tracks.length)throw new Error("No chapters found.");';
  h += 'var rows=tracks.slice(0,60).map((t,i)=>\'<div class="tr"><span class="tn">\'+(i+1)+\'</span><div class="ti"><div class="tt">\'+hesc(t.title)+\'</div><div class="ta">\'+hesc(t.artist)+(t.duration?" \u00b7 "+Math.floor(t.duration/60)+"m":"")+\'</div></div></div>\').join("");';
  h += 'if(tracks.length>60)rows+=\'<div class="tr" style="text-align:center;color:#555">+\'+(tracks.length-60)+\' more chapters</div>\';';
  h += 'pv.innerHTML=rows;pv.style.display="block";';
  h += 'st.className="status ok";st.textContent="Found "+tracks.length+" chapters in \\""+data.title+"\\"";';
  h += 'var lines=["Title,Artist,Album,Duration"];';
  h += 'tracks.forEach(t=>{function ce(s){s=String(s||"");if(s.includes(",")|| s.includes("\\""))s=\'"\'+s.replace(/"/g,\'""\')+\'"\';return s;}lines.push(ce(t.title)+","+ce(t.artist)+","+ce(data.title||"")+","+ce(t.duration||""));});';
  h += 'var blob=new Blob([lines.join("\\n")],{type:"text/csv"});var a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=(data.title||"librivox").replace(/[^a-zA-Z0-9 _-]/g,"").trim()+".csv";document.body.appendChild(a);a.click();document.body.removeChild(a);';
  h += 'btn.disabled=false;btn.textContent="Fetch & Download CSV";})';
  h += '.catch(e=>{st.className="status err";st.textContent=e.message;btn.disabled=false;btn.textContent="Fetch & Download CSV";});}';
  h += '<\/script></body></html>';
  return h;
}

// Routes
app.get('/', function(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildConfigPage(getBaseUrl(req)));
});

app.post('/generate', async function(req, res) {
  const ip     = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const bucket = getOrCreateIpBucket(ip);
  if (bucket.count >= MAX_TOKENS_PER_IP) return res.status(429).json({ error: 'Too many tokens today from this IP.' });
  const token = generateToken();
  const entry = { createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  await redisSave(token, entry);
  bucket.count++;
  res.json({ token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json' });
});

app.post('/refresh', async function(req, res) {
  const raw   = String((req.body && req.body.existingUrl) || '').trim();
  const m     = raw.match(/\/u\/([a-f0-9]{28})\//);
  const token = m ? m[1] : (/^[a-f0-9]{28}$/.test(raw) ? raw : null);
  if (!token) return res.status(400).json({ error: 'Paste your full addon URL.' });
  const entry = await getTokenEntry(token);
  if (!entry) return res.status(404).json({ error: 'URL not found. Generate a new one.' });
  res.json({ token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json', refreshed: true });
});

// Manifest
app.get('/u/:token/manifest.json', tokenMiddleware, function(req, res) {
  res.json({
    id:          'com.eclipse.librivox.' + req.params.token.slice(0, 8),
    name:        'LibriVox Audiobooks',
    version:     '1.0.0',
    description: '20,000+ free public domain audiobooks. Classic literature, philosophy, poetry & more.',
    icon:        'https://librivox.org/img/librivox_logo_flat.png',
    resources:   ['search', 'stream', 'catalog'],
    types:       ['track', 'album', 'artist', 'playlist']
  });
});

// Search
app.get('/u/:token/search', tokenMiddleware, async function(req, res) {
  const q = cleanText(req.query.q);
  if (!q) return res.json({ tracks: [], albums: [], artists: [], playlists: [] });
  try {
    const data = await multiSourceSearch(q);
    res.json(data);
  } catch (e) {
    console.error('[search]', e.message);
    res.status(500).json({ error: 'Search failed', tracks: [], albums: [], artists: [], playlists: [] });
  }
});

// Stream
app.get('/u/:token/stream/:id', tokenMiddleware, async function(req, res) {
  const id = req.params.id;
  const cached = CHAPTER_CACHE.get(id);
  if (cached && cached.streamURL) return res.json({ url: cached.streamURL, format: 'mp3' });

  const chMatch = id.match(/^lv_ch_(\d+)_(\S+)$/);
  if (chMatch) {
    const [, bookId, secNum] = chMatch;
    const data     = await lvGet('/audiotracks', { project_id: bookId });
    const sections = lvSections(data);
    const section  = sections.find(s => String(s.section_number) === secNum || String(s.play_order) === secNum);
    if (section && section.listen_url) return res.json({ url: section.listen_url, format: 'mp3' });
  }

  const trMatch = id.match(/^lv_track_(\d+)$/);
  if (trMatch) {
    const bookId   = trMatch[1];
    const data     = await lvGet('/audiotracks', { project_id: bookId });
    const sections = lvSections(data).sort((a, b) => parseInt(a.play_order || a.section_number || 0) - parseInt(b.play_order || b.section_number || 0));
    const first    = sections[0];
    if (first && first.listen_url) return res.json({ url: first.listen_url, format: 'mp3' });
  }

  return res.status(404).json({ error: 'Stream not found: ' + id });
});

// Album = Book with chapters
app.get('/u/:token/album/:id', tokenMiddleware, async function(req, res) {
  const rawId  = req.params.id;
  if (rawId.startsWith('lb_book_')) {
    const data = await loyalAlbum(rawId);
    if (!data) return res.status(404).json({ error: 'Loyal Books album not found.' });
    return res.json(data);
  }
  if (rawId.startsWith('ia_book_')) {
    const data = await iaAlbum(rawId);
    if (!data) return res.status(404).json({ error: 'Internet Archive album not found.' });
    return res.json(data);
  }
  if (rawId.startsWith('oc_book_')) {
    return res.json({ id: rawId, title: 'Open Culture Result', artist: 'Open Culture', artworkURL: null, trackCount: 0, tracks: [] });
  }

  const bookId = rawId.replace('lv_book_', '');
  try {
    const [bookData, trackData] = await Promise.all([
      lvGet('/audiobooks', { id: bookId, extended: 1, coverart: 1 }),
      lvGet('/audiotracks', { project_id: bookId })
    ]);
    const book   = lvBooks(bookData)[0] || {};
    const art    = bookArtwork(book);
    const author = getAuthorName(book);
    BOOK_CACHE.set(String(bookId), { title: cleanText(book.title), artist: author, artworkURL: art });

    const sections = lvSections(trackData).sort((a, b) => parseInt(a.play_order || a.section_number || 0) - parseInt(b.play_order || b.section_number || 0));
    const tracks   = sections.map(s => mapSectionToTrack(s, bookId));

    res.json({
      id:          rawId,
      title:       cleanText(book.title),
      artist:      author,
      artworkURL:  art,
      year:        book.copyright_year ? String(book.copyright_year) : null,
      description: cleanText(book.description || '').replace(/<[^>]*>/g, '').slice(0, 600),
      trackCount:  tracks.length,
      tracks
    });
  } catch (e) {
    console.error('[album]', e.message);
    res.status(500).json({ error: 'Book fetch failed.' });
  }
});

// Artist = Author page
app.get('/u/:token/artist/:id', tokenMiddleware, async function(req, res) {
  const rawId = req.params.id;
  const isNameBased = rawId.startsWith('lv_authorname_');
  try {
    let authorInfo = {}, books = [], fullName = '';
    if (isNameBased) {
      const authorName = decodeURIComponent(rawId.replace('lv_authorname_', ''));
      fullName = authorName;
      const bookData = await lvGet('/audiobooks', { author: authorName, limit: 30, extended: 1, coverart: 1 });
      books = lvBooks(bookData);
    } else {
      const authorId = rawId.replace('lv_author_', '');
      const [authorData, bookData] = await Promise.all([
        lvGet('/authors', { id: authorId }),
        lvGet('/audiobooks', { author_id: authorId, limit: 30, extended: 1, coverart: 1 })
      ]);
      authorInfo = lvAuthors(authorData)[0] || {};
      fullName   = cleanText([authorInfo.first_name, authorInfo.last_name].filter(Boolean).join(' ')) || ('Author ' + authorId);
      books = lvBooks(bookData);
    }
    const albums     = books.map(mapBookToAlbum);

    // topTracks = first chapter of each of the author's first 5 books
    const topTracks = [];
    for (const book of books.slice(0, 5)) {
      try {
        const td  = await lvGet('/audiotracks', { project_id: String(book.id) });
        const secs = lvSections(td).sort((a, b) => parseInt(a.play_order || a.section_number || 0) - parseInt(b.play_order || b.section_number || 0));
        if (secs.length > 0) {
          BOOK_CACHE.set(String(book.id), { title: cleanText(book.title), artist: getAuthorName(book), artworkURL: bookArtwork(book) });
          topTracks.push(mapSectionToTrack(secs[0], String(book.id)));
        }
      } catch (e2) { /* skip */ }
    }

    const genreSet = new Set();
    books.forEach(b => { if (Array.isArray(b.genres)) b.genres.forEach(g => genreSet.add(g.name)); });

    res.json({
      id:         rawId,
      name:       fullName || ('Author ' + authorId),
      artworkURL: books.length > 0 ? bookArtwork(books[0]) : null,
      bio:        authorInfo.bio ? cleanText(authorInfo.bio).replace(/<[^>]*>/g, '').slice(0, 500) : null,
      genres:     Array.from(genreSet).slice(0, 3),
      topTracks,
      albums
    });
  } catch (e) {
    console.error('[artist]', e.message);
    res.status(500).json({ error: 'Author fetch failed.' });
  }
});

// Playlist = Genre browser
app.get('/u/:token/playlist/:id', tokenMiddleware, async function(req, res) {
  const rawId   = req.params.id;
  const genreId = rawId.replace('lv_genre_', '');
  try {
    const data  = await lvGet('/audiobooks', { genre: genreId, limit: 30, extended: 1, coverart: 1 });
    const books = lvBooks(data);
    if (!books.length) return res.status(404).json({ error: 'No books found for this genre.' });

    const tracks = books.map(mapBookToTrack);
    let genreName = 'Audiobooks';
    const firstGenres = books[0].genres;
    if (Array.isArray(firstGenres)) {
      const match = firstGenres.find(g => String(g.id) === String(genreId));
      if (match) genreName = cleanText(match.name);
    }

    res.json({
      id:          rawId,
      title:       genreName + ' Audiobooks',
      description: 'Free public domain ' + genreName.toLowerCase() + ' audiobooks from LibriVox',
      artworkURL:  bookArtwork(books[0]),
      creator:     'LibriVox',
      tracks
    });
  } catch (e) {
    console.error('[playlist]', e.message);
    res.status(500).json({ error: 'Genre fetch failed.' });
  }
});

// Import
app.get('/u/:token/import', tokenMiddleware, async function(req, res) {
  const inputQ = cleanText(req.query.q);
  if (!inputQ) return res.status(400).json({ error: 'Pass ?q= with a book title or LibriVox URL.' });

  let bookId = null;

  if (/librivox\.org/.test(inputQ)) {
    const slug  = inputQ.replace(/.*librivox\.org\//i, '').replace(/\/$/, '').replace(/-/g, ' ');
    const found = await lvGet('/audiobooks', { title: '^' + slug, limit: 1, extended: 1, coverart: 1 });
    const b = lvBooks(found);
    if (b.length) bookId = String(b[0].id);
  }

  if (!bookId) {
    const found = await lvGet('/audiobooks', { title: inputQ, limit: 1, extended: 1, coverart: 1 });
    const b = lvBooks(found);
    if (!b.length) return res.status(404).json({ error: 'Book not found. Try a different title.' });
    bookId = String(b[0].id);
  }

  const [bookData, trackData] = await Promise.all([
    lvGet('/audiobooks', { id: bookId, extended: 1, coverart: 1 }),
    lvGet('/audiotracks', { project_id: bookId })
  ]);

  const book   = lvBooks(bookData)[0] || {};
  const art    = bookArtwork(book);
  const author = getAuthorName(book);
  BOOK_CACHE.set(bookId, { title: cleanText(book.title), artist: author, artworkURL: art });

  const sections = lvSections(trackData).sort((a, b) => parseInt(a.play_order || a.section_number || 0) - parseInt(b.play_order || b.section_number || 0));
  const tracks   = sections.map(s => mapSectionToTrack(s, bookId));

  res.json({ title: cleanText(book.title), artworkURL: art, tracks });
});

// Health
app.get('/health', function(req, res) {
  res.json({ status: 'ok', version: '1.0.0', redisConnected: !!(redis && redis.status === 'ready'), activeTokens: TOKEN_CACHE.size, cachedChapters: CHAPTER_CACHE.size, cachedBooks: BOOK_CACHE.size, timestamp: new Date().toISOString() });
});

app.listen(PORT, () => console.log('Eclipse LibriVox Addon v1.0.0 on port ' + PORT));
