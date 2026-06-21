/* =====================================================
   MELODIFY — FULL SONG STREAMING + DYNAMIC COLORS
   APIs: JioSaavn (full songs) → iTunes (fallback 30s)
   Features:
     • Dynamic poster color extraction (Spotify-style)
     • Movie/Hero name → full album songs
     • Full song playback (320kbps from JioSaavn)
   ===================================================== */

// ─── CONFIG ──────────────────────────────────────────
const SAAVN_ENDPOINTS = [
  'https://saavan-api.vercel.app',        // ✅ Working
  'https://jiosaavn-api-2.vercel.app',   // ✅ Working fallback
];
let activeSaavnEndpoint = SAAVN_ENDPOINTS[0];

// Audio CORS proxy — helps when direct CDN URLs are blocked
const AUDIO_PROXY = 'https://corsproxy.io/?url=';

// CORS proxy for images
const CORS_PROXY = 'https://corsproxy.io/?url=';

// Helper: extract image URL from a JioSaavn image object (handles .url and .link)
function imgUrl(imgObj) {
  if (!imgObj) return '';
  const u = imgObj.url || imgObj.link || '';
  return u.replace('50x50', '500x500').replace('150x150', '500x500').replace('100x100', '500x500');
}

// Get best image from image array (handles both .url and .link)
function getBestImage(imgs, size = 'high') {
  if (!imgs || !imgs.length) return '';
  const idx = size === 'high' ? [2, 1, 0] : [1, 0, 2];
  for (const i of idx) {
    const u = imgUrl(imgs[i]);
    if (u) return u;
  }
  return '';
}

// ─── STATE ───────────────────────────────────────────
const state = {
  queue: [],
  currentIndex: -1,
  isPlaying: false,
  isShuffle: false,
  isRepeat: false,
  isMuted: false,
  volume: 0.8,
  liked: JSON.parse(localStorage.getItem('melodify_liked') || '[]'),
  recent: JSON.parse(localStorage.getItem('melodify_recent') || '[]'),
  playlists: JSON.parse(localStorage.getItem('melodify_playlists') || '[]'),
  pendingSongForPlaylist: null,
  filter: 'all',
  theme: localStorage.getItem('melodify_theme') || 'default',
  currentColor: null,
};

const audio = document.getElementById('audioPlayer');
let searchDebounceTimer = null;

// ─── THEMES ──────────────────────────────────────────
const themes = ['default', 'neon', 'gold', 'ocean'];
function cycleTheme() {
  const idx = themes.indexOf(state.theme);
  state.theme = themes[(idx + 1) % themes.length];
  applyTheme();
  localStorage.setItem('melodify_theme', state.theme);
  showToast('Theme: ' + capitalize(state.theme));
}
function applyTheme() {
  document.body.className = state.theme === 'default' ? '' : 'theme-' + state.theme;
}
applyTheme();

// ─── SECTION NAV ─────────────────────────────────────
function showSection(name) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  const sec = document.getElementById('section-' + name);
  if (sec) sec.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.section === name);
  });
  if (name === 'library') renderLibrary();
}
function showLiked() { showSection('library'); }
function toggleSidebar() { document.getElementById('sidebar').classList.toggle('open'); }
function toggleQueue() { document.getElementById('queueSidebar').classList.toggle('open'); renderQueue(); }

// ─── JioSaavn API ────────────────────────────────────
async function saavnFetch(path, params = {}) {
  const paramStr = new URLSearchParams(params).toString();
  for (const endpoint of SAAVN_ENDPOINTS) {
    try {
      const url = `${endpoint}${path}${paramStr ? '?' + paramStr : ''}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      activeSaavnEndpoint = endpoint;
      return data;
    } catch (e) { continue; }
  }
  return null;
}

async function searchSaavnSongs(query, limit = 25) {
  try {
    const data = await saavnFetch('/search/songs', { query, limit });
    if (!data) return [];
    return (data.data?.results || data.results || []).map(normalizeSong).filter(Boolean);
  } catch (e) { return []; }
}

async function searchSaavnAlbumsAll(query, limit = 20) {
  // Fetch more albums to get comprehensive hero movie coverage
  try {
    const [p1, p2] = await Promise.all([
      saavnFetch('/search/albums', { query, limit }),
      saavnFetch('/search/albums', { query, limit, page: 2 }),
    ]);
    const r1 = p1?.data?.results || p1?.results || [];
    const r2 = p2?.data?.results || p2?.results || [];
    // Deduplicate by id
    const seen = new Set();
    return [...r1, ...r2].filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true; });
  } catch (e) { return []; }
}

async function searchSaavnAlbums(query, limit = 8) {
  try {
    const data = await saavnFetch('/search/albums', { query, limit });
    if (!data) return [];
    return data.data?.results || data.results || [];
  } catch (e) { return []; }
}

async function getAlbumById(id) {
  try {
    const data = await saavnFetch('/albums', { id });
    if (!data) return null;
    return data.data || null;
  } catch (e) { return null; }
}

async function getSongById(id) {
  try {
    const data = await saavnFetch('/songs/' + id);
    if (!data) return null;
    return data.data?.[0] || null;
  } catch (e) { return null; }
}

async function searchSaavnArtist(query, limit = 5) {
  try {
    const data = await saavnFetch('/search/artists', { query, limit });
    if (!data) return [];
    return data.data?.results || data.results || [];
  } catch (e) { return []; }
}

// ─── NORMALIZE JioSaavn Song ──────────────────────────
function normalizeSong(s) {
  if (!s) return null;
  const imgs = s.image || [];
  const image = getBestImage(imgs, 'high');
  const imageMed = getBestImage(imgs, 'med');
  const primaryArtists = s.artists?.primary || [];
  const artistStr = primaryArtists.length
    ? primaryArtists.map(a => a.name).join(', ')
    : (typeof s.primaryArtists === 'string' ? s.primaryArtists : s.artists?.join?.(', ') || 'Unknown');
  const dlUrls = s.downloadUrl || s.download_url || [];
  // Normalize: some API versions use .link instead of .url
  const normalizedUrls = (Array.isArray(dlUrls) ? dlUrls : []).map(u => ({
    quality: u.quality || '',
    url: u.url || u.link || '',
  })).filter(u => u.url);
  return {
    id: s.id || ('saavn_' + Math.random()),
    name: decodeHtml(s.name || s.title || 'Unknown'),
    artist: decodeHtml(artistStr),
    album: decodeHtml(s.album?.name || s.album || ''),
    image,
    imageMed,
    downloadUrl: normalizedUrls,
    duration: Number(s.duration) || 0,
    source: 'saavn',
    fullSong: normalizedUrls.length > 0,
  };
}

// Get best stream URL — handles both .url and .link fields
function getBestUrl(song) {
  if (!song.downloadUrl?.length) return '';
  const order = ['320kbps', '160kbps', '96kbps', '48kbps', '12kbps'];
  for (const q of order) {
    const found = song.downloadUrl.find(u => u.quality === q && (u.url || u.link));
    if (found) return found.url || found.link;
  }
  const last = song.downloadUrl[song.downloadUrl.length - 1];
  return last?.url || last?.link || '';
}

// ─── DYNAMIC COLOR EXTRACTION (Spotify-style) ─────────
// Uses CORS proxy so canvas can read pixel data from external images
function applyDynamicColors(r, g, b, targetId = null) {
  state.currentColor = { r, g, b };

  if (targetId) {
    const el = document.getElementById(targetId);
    if (el) {
      el.style.background = `linear-gradient(160deg,
        rgba(${r},${g},${b},0.75) 0%,
        rgba(${Math.round(r * 0.6)},${Math.round(g * 0.6)},${Math.round(b * 0.6)},0.45) 45%,
        rgba(10,10,20,0.95) 100%)`;
      el.style.borderColor = `rgba(${r},${g},${b},0.6)`;
      el.style.boxShadow = `0 8px 80px rgba(${r},${g},${b},0.35)`;
    }
  }

  document.documentElement.style.setProperty('--dynamic-r', r);
  document.documentElement.style.setProperty('--dynamic-g', g);
  document.documentElement.style.setProperty('--dynamic-b', b);
  document.documentElement.style.setProperty('--dynamic-color', `rgb(${r},${g},${b})`);
  document.documentElement.style.setProperty('--dynamic-glow', `rgba(${r},${g},${b},0.35)`);
  document.documentElement.style.setProperty('--dynamic-soft', `rgba(${r},${g},${b},0.15)`);
  document.documentElement.style.setProperty('--dynamic-mid', `rgba(${r},${g},${b},0.5)`);

  const playerBar = document.getElementById('playerBar');
  if (playerBar) {
    playerBar.style.background = `linear-gradient(90deg,
      rgba(${r},${g},${b},0.18) 0%,
      rgba(10,10,20,0.97) 30%,
      rgba(10,10,20,0.97) 70%,
      rgba(${r},${g},${b},0.18) 100%)`;
    playerBar.style.borderTopColor = `rgba(${r},${g},${b},0.4)`;
  }

  const nowArt = document.getElementById('nowArt');
  if (nowArt) {
    nowArt.style.borderColor = `rgb(${r},${g},${b})`;
    nowArt.style.boxShadow = `0 0 30px rgba(${r},${g},${b},0.6), 0 0 6px rgba(${r},${g},${b},0.8)`;
  }

  const fill = document.getElementById('progressFill');
  if (fill) fill.style.background = `linear-gradient(90deg, rgba(${r},${g},${b},0.9), rgb(${r},${g},${b}))`;
  const thumb = document.getElementById('progressThumb');
  if (thumb) {
    thumb.style.background = `rgb(${r},${g},${b})`;
    thumb.style.boxShadow = `0 0 8px rgba(${r},${g},${b},0.8)`;
  }

  const heroBanner = document.getElementById('heroBanner');
  if (heroBanner) {
    heroBanner.style.background = `linear-gradient(135deg,
      rgba(${r},${g},${b},0.4) 0%,
      rgba(${Math.round(r * 0.5)},${Math.round(g * 0.5)},${Math.round(b * 0.5)},0.2) 50%,
      rgba(10,10,20,0.9) 100%)`;
  }

  const logoIcon = document.querySelector('.logo-icon');
  if (logoIcon) logoIcon.style.filter = `drop-shadow(0 0 8px rgba(${r},${g},${b},0.8))`;
}

function extractAndApplyColors(imgUrl, targetId = null) {
  if (!imgUrl) return;

  // Try with CORS proxy so canvas.getImageData() works
  const tryExtract = (src) => {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 80; canvas.height = 80;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, 80, 80);
          const data = ctx.getImageData(0, 0, 80, 80).data;

          const buckets = {};
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
            if (a < 200) continue;
            const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
            const sat = Math.max(r, g, b) - Math.min(r, g, b);
            if (brightness < 20 || brightness > 235 || sat < 40) continue;
            const key = `${Math.round(r / 24) * 24},${Math.round(g / 24) * 24},${Math.round(b / 24) * 24}`;
            buckets[key] = (buckets[key] || 0) + 1;
          }

          let dominant = Object.entries(buckets).sort((a, b) => b[1] - a[1])[0]?.[0];
          if (!dominant) {
            let rr = 0, gg = 0, bb = 0, n = 0;
            for (let i = 0; i < data.length; i += 4) {
              if (data[i + 3] > 128) { rr += data[i]; gg += data[i + 1]; bb += data[i + 2]; n++; }
            }
            if (n) dominant = `${Math.round(rr / n)},${Math.round(gg / n)},${Math.round(bb / n)}`;
          }
          if (dominant) {
            const [r, g, b] = dominant.split(',').map(Number);
            resolve({ r, g, b });
          } else resolve(null);
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  };

  const run = async () => {
    // Try 1: direct with crossOrigin
    let colors = await tryExtract(imgUrl);

    // Try 2: via CORS proxy
    if (!colors) {
      colors = await tryExtract(CORS_PROXY + encodeURIComponent(imgUrl));
    }

    if (colors) {
      applyDynamicColors(colors.r, colors.g, colors.b, targetId);
    } else {
      // Fallback: use a vibrant color based on image URL hash
      const hash = imgUrl.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 0);
      const palettes = [
        [220, 60, 80],   // red
        [255, 140, 0],   // orange
        [50, 180, 255],  // cyan
        [150, 80, 220],  // purple
        [0, 200, 130],   // teal
        [255, 60, 180],  // pink
        [80, 150, 255],  // blue
        [200, 180, 0],   // gold
      ];
      const [r, g, b] = palettes[Math.abs(hash) % palettes.length];
      applyDynamicColors(r, g, b, targetId);
    }
  };
  run();
}

// ─── KNOWN HEROES / ACTORS for smart detection ───────
const KNOWN_HEROES = [
  'allu arjun', 'jr ntr', 'ntr', 'prabhas', 'ram charan', 'mahesh babu', 'vijay', 'ajith',
  'kamal haasan', 'shah rukh khan', 'srk', 'salman khan', 'hrithik roshan', 'ranbir kapoor',
  'vijay deverakonda', 'nani', 'samantha', 'rashmika', 'trisha', 'anushka shetty',
  'chiranjeevi', 'balakrishna', 'venkatesh', 'nagarjuna', 'vikram', 'dhanush', 'suriya',
  'sivakarthikeyan', 'karthi', 'jayam ravi', 'fahadh faasil', 'mammootty', 'mohanlal',
  'dulquer salmaan', 'tovino', 'nivin pauly', 'rana daggubati', 'sai dharam tej',
  'bellamkonda', 'adivi sesh', 'naveen polishetty', 'allu sirish',
  'arijit singh', 'ar rahman', 'anirudh', 'sid sriram', 'shreya ghoshal',
  's.p. balasubrahmanyam', 'spb', 'kk', 'udit narayan', 'sonu nigam', 'shankar mahadevan',
  'thaman', 'devi sri prasad', 'dsp', 'Nitin sharma', 'yuvan shankar raja',
];

function isHeroQuery(q) {
  const lq = q.toLowerCase().trim();
  return KNOWN_HEROES.some(h => lq.includes(h) || h.includes(lq)) && lq.length > 3;
}

// ─── SMART ERA / LANGUAGE / MOOD QUERY DETECTION ─────
// Detects queries like "90s Telugu songs", "80s Hindi hits", "Tamil sad songs" etc.
// and expands them into multiple targeted sub-queries for much better coverage.

const ERA_MAP = {
  '90s': {
    label: '90s', queries90Telugu: [
      'Telugu super hit songs 1990', 'Telugu super hit songs 1991', 'Telugu super hit songs 1992',
      'Telugu super hit songs 1993', 'Telugu super hit songs 1994', 'Telugu super hit songs 1995',
      'Telugu super hit songs 1996', 'Telugu super hit songs 1997', 'Telugu super hit songs 1998',
      'Telugu super hit songs 1999',
    ]
  },
};

const LANGUAGE_ERA_ARTISTS = {
  telugu: {
    '80s': ['sp balasubrahmanyam telugu 1980', 's janaki telugu 1985', 'p susheela telugu old', 'ilayaraja telugu old'],
    '90s': [
      'chiranjeevi hits', 'nagarjuna hits 90s', 'venkatesh hits 90s', 'balakrishna 90s hits',
      'Nitin sharma telugu 90s', 'koti telugu 90s', 'sp balasubrahmanyam 90s telugu',
      'chitra telugu 90s', 's janaki telugu 90s', 'jolly song telugu 90s',
      'telugu video songs 1994', 'telugu video songs 1996', 'telugu video songs 1998',
      'super hit telugu songs 1990', 'super hit telugu songs 1995',
    ],
    '2000s': [
      'devi sri prasad 2000s', 'Nitin sharma 2000s telugu', 'chiranjeevi 2000s',
      'prabhas 2000s hits', 'mahesh babu 2000s', 'allu arjun 2000s',
      'telugu super hit songs 2005', 'telugu hits 2008',
    ],
    '2010s': [
      'allu arjun blockbuster', 'mahesh babu hits 2010', 'prabhas baahubali',
      'thaman telugu hits', 'dsp 2010s', 'trivikram songs',
    ],
  },
  tamil: {
    '90s': [
      'ar rahman 90s', 'ilayaraja 90s tamil', 'vijay 90s tamil hits',
      'ajith 90s hits', 'prabhu tamil 90s', 'deva tamil 90s',
      'super hit tamil songs 1993', 'super hit tamil songs 1997',
    ],
    '80s': ['ilayaraja 80s', 'rajinikanth 80s hits', 'kamal haasan 80s hits'],
    '2000s': ['ar rahman 2000s', 'harris jayaraj 2000s', 'vijay 2000s hits'],
  },
  hindi: {
    '90s': [
      'kumar sanu 90s hits', 'alka yagnik 90s', 'udit narayan 90s',
      'nadeem shravan 90s', 'anand milind 90s', 'salman khan 90s',
      'shahrukh khan 90s', 'madhuri dixit 90s',
      'super hit hindi songs 1993', 'super hit hindi songs 1997',
    ],
    '80s': ['lata mangeshkar 80s', 'kishore kumar 80s', 'asha bhosle 80s', 'rfi 80s'],
    '2000s': ['arijit singh 2000s', 'pritam 2000s', 'himesh reshammiya 2000s'],
  },
  malayalam: {
    '90s': ['mohanlal 90s hit songs', 'mammootty 90s', 'johnson master 90s malayalam'],
    '2000s': ['mohanlal 2000s', 'mammootty 2000s hits'],
  },
  kannada: {
    '90s': ['rajkumar kannada 90s', 'vishnuvardhan kannada 90s hits'],
    '2000s': ['puneeth rajkumar 2000s', 'darshan kannada 2000s'],
  },
};

const MOOD_QUERIES = {
  sad: { telugu: ['sad telugu songs', 'telugu breakup songs', 'manasu sad songs telugu'], hindi: ['sad hindi songs', 'hindi breakup songs', 'dard hindi songs'], tamil: ['sad tamil songs', 'kadhal sad songs'] },
  love: { telugu: ['telugu love songs', 'telugu romantic songs', 'prema songs telugu'], hindi: ['hindi love songs', 'romantic hindi songs'], tamil: ['tamil love songs', 'kadhal songs'] },
  dance: { telugu: ['telugu dance hits', 'item songs telugu', 'dj songs telugu'], hindi: ['hindi dance songs', 'bollywood dance hits'], tamil: ['tamil dance songs', 'kuthu songs'] },
  devotional: { telugu: ['telugu devotional songs', 'bhakti songs telugu', 'venkateswara songs'], hindi: ['hindi bhajan', 'devotional songs hindi'] },
  kids: { telugu: ['telugu kids songs', 'children songs telugu', 'bala geetalu'], hindi: ['hindi children songs', 'bal geet'] },
};

function detectSmartQuery(q) {
  const lq = q.toLowerCase().trim();

  // Detect era
  let era = null;
  if (/\b(90s?|1990s?|nineties)\b/.test(lq)) era = '90s';
  else if (/\b(80s?|1980s?|eighties)\b/.test(lq)) era = '80s';
  else if (/\b(2000s?|2k|noughties)\b/.test(lq)) era = '2000s';
  else if (/\b(2010s?|twenty tens?)\b/.test(lq)) era = '2010s';
  else if (/\b(70s?|1970s?|seventies)\b/.test(lq)) era = '70s';

  // Detect language
  let lang = null;
  if (/\b(telugu|andhra|tollywood)\b/.test(lq)) lang = 'telugu';
  else if (/\b(tamil|kollywood|tamilnadu)\b/.test(lq)) lang = 'tamil';
  else if (/\b(hindi|bollywood|hind)\b/.test(lq)) lang = 'hindi';
  else if (/\b(malayalam|mollywood|kerala)\b/.test(lq)) lang = 'malayalam';
  else if (/\b(kannada|sandalwood)\b/.test(lq)) lang = 'kannada';

  // Detect mood
  let mood = null;
  if (/\b(sad|break.?up|dukh|dard|emotional|cry|melancholy)\b/.test(lq)) mood = 'sad';
  else if (/\b(love|romantic|prema|romance|couple)\b/.test(lq)) mood = 'love';
  else if (/\b(dance|dj|item|kuthu|party|club)\b/.test(lq)) mood = 'dance';
  else if (/\b(devotional|bhakti|bhajan|god|prayer)\b/.test(lq)) mood = 'devotional';
  else if (/\b(kids|children|baby|bala|nursery)\b/.test(lq)) mood = 'kids';

  if (!era && !lang && !mood) return null; // not a smart query

  let subQueries = [];

  // Era + Language combo (most powerful)
  if (era && lang && LANGUAGE_ERA_ARTISTS[lang]?.[era]) {
    subQueries = [...LANGUAGE_ERA_ARTISTS[lang][era]];
  }

  // Mood + Language combo
  if (mood && lang && MOOD_QUERIES[mood]?.[lang]) {
    subQueries = [...(MOOD_QUERIES[mood][lang]), ...subQueries];
  } else if (mood && MOOD_QUERIES[mood]) {
    // fallback: pick any language mood queries
    const moodArr = Object.values(MOOD_QUERIES[mood]).flat();
    subQueries = [...moodArr, ...subQueries];
  }

  // Language only (no era/mood)
  if (!era && !mood && lang) {
    subQueries = [`${lang} hit songs`, `${lang} super hit songs`, `${lang} popular songs`, `${lang} blockbuster songs`];
  }

  // Era only (no language)
  if (era && !lang) {
    subQueries = [
      `superhit songs ${era}`, `hit songs ${era}`, `bollywood ${era} hits`,
      `telugu ${era} hits`, `tamil ${era} hits`,
    ];
  }

  // Always add the original query too
  subQueries.unshift(q);

  return {
    isSmartQuery: true,
    label: [era, lang, mood].filter(Boolean).join(' '),
    subQueries: subQueries.slice(0, 12), // max 12 sub-queries (= up to 360 songs)
  };
}

async function doSmartSearch(smartInfo, originalQuery) {
  showSection('search');
  showLoading(`🔍 Loading ${smartInfo.label} songs... This may take a moment!`);

  try {
    // Run all sub-queries in parallel (batched to avoid overload)
    const BATCH = 4;
    const seenIds = new Set();
    let allSongs = [];

    for (let i = 0; i < smartInfo.subQueries.length; i += BATCH) {
      const batch = smartInfo.subQueries.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(sq =>
          saavnFetch('/search/songs', { query: sq, limit: 30 })
            .then(d => (d?.data?.results || d?.results || []).map(normalizeSong).filter(Boolean))
            .catch(() => [])
        )
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          for (const s of r.value) {
            if (!seenIds.has(s.id)) { seenIds.add(s.id); allSongs.push(s); }
          }
        }
      }
    }

    // Also search page 2 of the base query
    try {
      const extra = await saavnFetch('/search/songs', { query: originalQuery, limit: 30, page: 2 });
      for (const s of (extra?.data?.results || extra?.results || []).map(normalizeSong).filter(Boolean)) {
        if (!seenIds.has(s.id)) { seenIds.add(s.id); allSongs.push(s); }
      }
    } catch (e) { }

    state.queue = allSongs;
    state._lastSearchQuery = originalQuery;
    state._searchPage = 1;
    hideLoading();
    renderSearchResults(allSongs, `${smartInfo.label} songs`, true);
    const firstImg = allSongs.find(s => s.image)?.image;
    if (firstImg) setTimeout(() => extractAndApplyColors(firstImg), 300);
    if (allSongs.length > 0) showToast(`✅ Found ${allSongs.length} songs!`);
  } catch (e) {
    hideLoading();
    showToast('Search failed. Try again.');
  }
}

// ─── SEARCH ──────────────────────────────────────────
function debouncedSearch() {
  const q = document.getElementById('globalSearch').value.trim();
  document.getElementById('searchClearBtn').style.display = q ? 'block' : 'none';
  clearTimeout(searchDebounceTimer);
  if (q.length < 2) { hideSuggestions(); return; }
  showSearchSuggestions(q);
  searchDebounceTimer = setTimeout(() => doSearch(), 700);
}

// ─── SEARCH SUGGESTIONS DROPDOWN ─────────────────────
function showSearchSuggestions(q) {
  const lq = q.toLowerCase();
  const heroMatches = KNOWN_HEROES.filter(h => h.includes(lq) || lq.includes(h.split(' ')[0])).slice(0, 4);
  const wrap = document.getElementById('searchSuggestionsBox');
  if (!wrap) return;
  if (!heroMatches.length) { hideSuggestions(); return; }
  wrap.innerHTML = heroMatches.map(h =>
    `<div class="suggestion-item" onmousedown="selectSuggestion('${h.replace(/'/g, "\\'")}')">` +
    `<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>` +
    `<span>${h.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')}</span>` +
    `<span class="sug-tag">Actor / Singer</span></div>`
  ).join('');
  wrap.style.display = 'block';
}

function hideSuggestions() {
  const wrap = document.getElementById('searchSuggestionsBox');
  if (wrap) wrap.style.display = 'none';
}

function selectSuggestion(name) {
  const display = name.split(' ').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  document.getElementById('globalSearch').value = display;
  document.getElementById('searchClearBtn').style.display = 'block';
  hideSuggestions();
  searchActor(display);
}

function clearSearch() {
  document.getElementById('globalSearch').value = '';
  document.getElementById('searchClearBtn').style.display = 'none';
}

async function doSearch() {
  const q = document.getElementById('globalSearch').value.trim();
  if (!q) return;
  hideSuggestions();

  // Smart hero detection — route directly to actor/hero search
  if (isHeroQuery(q)) {
    searchActor(q);
    return;
  }

  // Smart era/language/mood detection — fires multiple sub-queries
  const smartInfo = detectSmartQuery(q);
  if (smartInfo) {
    doSmartSearch(smartInfo, q);
    return;
  }

  showSection('search');

  if (state.filter === 'album' || state.filter === 'movie') {
    showLoading('Loading albums for "' + q + '"…');
    const albums = await searchSaavnAlbums(q, 20);
    hideLoading();
    renderAlbumGrid(albums, q);
    return;
  }

  showLoading('Searching "' + q + '"…');
  state._lastSearchQuery = q;
  state._searchPage = 1;
  try {
    // Fetch 3 pages in parallel for comprehensive results
    const [p1, p2, p3, albums, artists] = await Promise.all([
      searchSaavnSongs(q, 30),
      saavnFetch('/search/songs', { query: q, limit: 30, page: 2 }).then(d => (d?.data?.results || d?.results || []).map(normalizeSong).filter(Boolean)).catch(() => []),
      saavnFetch('/search/songs', { query: q, limit: 30, page: 3 }).then(d => (d?.data?.results || d?.results || []).map(normalizeSong).filter(Boolean)).catch(() => []),
      searchSaavnAlbums(q, 5),
      searchSaavnArtist(q, 3),
    ]);

    // If a matching artist/actor found, redirect to actor search
    if (artists.length > 0) {
      const topArtist = artists[0];
      const artistName = topArtist.name || '';
      const similarity = artistName.toLowerCase().includes(q.toLowerCase()) ||
        q.toLowerCase().includes(artistName.toLowerCase().split(' ')[0]);
      if (similarity && artistName.length > 3) {
        hideLoading();
        searchActor(artistName);
        return;
      }
    }

    // Deduplicate and merge all pages
    const seenIds = new Set();
    let finalSongs = [];
    for (const s of [...p1, ...p2, ...p3]) {
      if (!seenIds.has(s.id)) { seenIds.add(s.id); finalSongs.push(s); }
    }

    // Merge album songs for better results
    if (albums.length > 0) {
      try {
        const detail = await getAlbumById(albums[0].id);
        if (detail?.songs?.length) {
          const albumSongs = detail.songs.map(normalizeSong).filter(Boolean);
          for (const s of albumSongs) {
            if (!seenIds.has(s.id)) { seenIds.add(s.id); finalSongs.unshift(s); }
          }
          const imgs = detail.image || albums[0].image || [];
          const posterUrl = (imgs[2]?.url || imgs[1]?.url || imgs[0]?.url || '').replace('50x50', '500x500').replace('150x150', '500x500');
          if (posterUrl) setTimeout(() => extractAndApplyColors(posterUrl), 300);
        }
      } catch (e) { }
    }

    state.queue = finalSongs;
    hideLoading();
    renderSearchResults(finalSongs, q, true);
    if (finalSongs.length > 0) showToast(`✅ ${finalSongs.length} songs found!`);
  } catch (e) {
    hideLoading();
    showToast('Search failed. Try again.');
  }
}

async function searchByGenre(genre) {
  document.getElementById('globalSearch').value = genre;
  document.getElementById('searchClearBtn').style.display = 'block';
  showSection('search');
  showLoading('Loading ' + genre + '…');
  state._lastSearchQuery = genre;
  state._searchPage = 1;
  try {
    // Fetch 3 pages in parallel = up to 90 songs
    const [p1, p2, p3] = await Promise.all([
      searchSaavnSongs(genre, 30),
      saavnFetch('/search/songs', { query: genre, limit: 30, page: 2 }).then(d => (d?.data?.results || d?.results || []).map(normalizeSong).filter(Boolean)).catch(() => []),
      saavnFetch('/search/songs', { query: genre, limit: 30, page: 3 }).then(d => (d?.data?.results || d?.results || []).map(normalizeSong).filter(Boolean)).catch(() => []),
    ]);
    const seenIds = new Set();
    const songs = [];
    for (const s of [...p1, ...p2, ...p3]) {
      if (!seenIds.has(s.id)) { seenIds.add(s.id); songs.push(s); }
    }
    state.queue = songs;
    hideLoading();
    renderSearchResults(songs, genre, true);
    const firstWithImg = songs.find(s => s.image);
    if (firstWithImg) setTimeout(() => extractAndApplyColors(firstWithImg.image), 300);
  } catch (e) {
    hideLoading();
    showToast('Failed to load');
  }
}

function setFilter(f, btn) {
  state.filter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const q = document.getElementById('globalSearch').value.trim();
  if (q) doSearch();
}

// ─── ACTOR / HERO SEARCH ─────────────────────────────
async function searchActor(actorName) {
  if (!actorName) return;
  document.getElementById('actorSearchInput').value = actorName;
  showSection('actor');
  showLoading('Finding all movies & songs of ' + actorName + '…');
  document.getElementById('actorResultsArea').innerHTML = '';

  try {
    // Fetch artist info + comprehensive album list in parallel
    const [artists, albums] = await Promise.all([
      searchSaavnArtist(actorName, 3),
      searchSaavnAlbumsAll(actorName, 20),
    ]);

    let artistImage = '';
    let artistSongs = [];

    // Step 1: Get songs from artist profile
    if (artists.length > 0) {
      const artist = artists[0];
      const artistImgs = artist.image || [];
      artistImage = (artistImgs[2]?.url || artistImgs[1]?.url || artistImgs[0]?.url ||
        artistImgs[2]?.link || artistImgs[1]?.link || artistImgs[0]?.link || '')
        .replace('50x50', '500x500').replace('150x150', '500x500');
      try {
        const artistData = await saavnFetch('/artists/' + artist.id + '/songs', { limit: 50 });
        if (artistData?.data?.songs) {
          artistSongs = artistData.data.songs.map(normalizeSong).filter(Boolean);
        }
      } catch (e) { }
    }

    // Step 2: Fetch all album details (grouped by movie)
    const albumDetails = await Promise.allSettled(
      albums.slice(0, 15).map(async (alb) => {
        try {
          const detail = await getAlbumById(alb.id);
          const songs = (detail?.songs || []).map(normalizeSong).filter(Boolean);
          const imgs = detail?.image || alb.image || [];
          const img = getBestImage(imgs, 'high');
          return {
            id: alb.id,
            name: decodeHtml(alb.name || alb.title || 'Unknown'),
            year: alb.year || detail?.year || '',
            img,
            songs,
          };
        } catch (e) { return null; }
      })
    );

    const movieGroups = albumDetails
      .filter(r => r.status === 'fulfilled' && r.value?.songs?.length > 0)
      .map(r => r.value);

    // Step 3: Build flat queue from all movie songs (for playback)
    const seenIds = new Set();
    let allSongs = [];
    for (const mg of movieGroups) {
      for (const s of mg.songs) {
        if (!seenIds.has(s.id)) { seenIds.add(s.id); allSongs.push(s); }
      }
    }
    // Merge artist songs not already in queue
    for (const s of artistSongs) {
      if (!seenIds.has(s.id)) { seenIds.add(s.id); allSongs.push(s); }
    }
    // Fallback: direct song search
    if (allSongs.length < 5) {
      try {
        const directSongs = await searchSaavnSongs(actorName + ' songs', 25);
        for (const s of directSongs) {
          if (!seenIds.has(s.id)) { seenIds.add(s.id); allSongs.push(s); }
        }
      } catch (e) { }
    }

    hideLoading();
    state.queue = allSongs;

    const container = document.getElementById('actorResultsArea');
    if (!allSongs.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-icon">😕</div><p>No songs found for "${escHTML(actorName)}"</p></div>`;
      return;
    }

    if (artistImage) setTimeout(() => extractAndApplyColors(artistImage, 'actorHeaderEl'), 300);

    // Build hero header
    const headerHtml = `
      <div class="actor-header" id="actorHeaderEl">
        <div class="actor-avatar">
          ${artistImage
        ? `<img src="${artistImage}" alt="${escHTML(actorName)}" onerror="this.style.display='none';this.nextSibling.style.display='flex'" crossorigin="anonymous" /><div class="actor-initials" style="display:none">${actorName[0].toUpperCase()}</div>`
        : `<div class="actor-initials">${actorName[0].toUpperCase()}</div>`}
        </div>
        <div class="actor-info">
          <div class="actor-label">Artist / Actor</div>
          <h2 class="actor-name">${escHTML(actorName)}</h2>
          <div class="actor-meta">${movieGroups.length} movies &bull; ${allSongs.length} songs</div>
          <button class="movie-play-all" onclick="playAll()">
            <svg viewBox="0 0 24 24" fill="white" width="18" height="18"><path d="M8 5v14l11-7z"/></svg>
            Play All ${allSongs.length} Songs
          </button>
        </div>
      </div>`;

    // Build movies grid — each movie expandable
    let songOffset = 0;
    const moviesHtml = movieGroups.map((mg) => {
      const startIdx = songOffset;
      songOffset += mg.songs.length;
      const movieId = 'mg_' + mg.id;
      return `
        <div class="hero-movie-card" id="${movieId}">
          <div class="hero-movie-header" onclick="toggleMovieGroup('${movieId}')">
            <div class="hero-movie-thumb">
              ${mg.img ? `<img src="${escHTML(mg.img)}" alt="" loading="lazy" crossorigin="anonymous" onerror="this.parentNode.innerHTML='🎬'" />` : '🎬'}
            </div>
            <div class="hero-movie-meta">
              <div class="hero-movie-name">${escHTML(mg.name)}</div>
              <div class="hero-movie-info">${mg.songs.length} songs${mg.year ? ' &bull; ' + mg.year : ''}</div>
            </div>
            <button class="hero-movie-play" onclick="event.stopPropagation();playMovieGroup(${startIdx},${mg.songs.length})" title="Play this movie">
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M8 5v14l11-7z"/></svg>
            </button>
            <span class="hero-movie-toggle">▼</span>
          </div>
          <div class="hero-movie-songs" id="${movieId}_songs" style="display:none">
            <div class="song-list-container">
              ${mg.songs.map((s, i) => createSongListItem(s, startIdx + i, 'actor')).join('')}
            </div>
          </div>
        </div>`;
    }).join('');

    container.innerHTML = headerHtml +
      `<div class="hero-movies-section">
        <div class="hero-movies-title">🎬 Movies (${movieGroups.length})</div>
        <div class="hero-movies-grid">${moviesHtml}</div>
      </div>`;

  } catch (e) {
    hideLoading();
    showToast('Error finding songs for ' + actorName);
    console.error(e);
  }
}

function toggleMovieGroup(movieId) {
  const songsEl = document.getElementById(movieId + '_songs');
  const card = document.getElementById(movieId);
  if (!songsEl) return;
  const isOpen = songsEl.style.display !== 'none';
  songsEl.style.display = isOpen ? 'none' : 'block';
  const toggle = card?.querySelector('.hero-movie-toggle');
  if (toggle) toggle.textContent = isOpen ? '▼' : '▲';
}

function playMovieGroup(startIdx, count) {
  if (!state.queue.length) return;
  playSongAt(startIdx);
}

// ─── MOVIE SEARCH ─────────────────────────────────────
function searchMovie() {
  const q = document.getElementById('movieSearchInput').value.trim();
  if (!q) { showToast('Enter a movie name'); return; }
  loadMovieSongs(q);
}

async function loadMovieSongs(movieName) {
  document.getElementById('movieSearchInput').value = movieName;
  showSection('movies');
  showLoading('Loading "' + movieName + '" soundtrack…');
  try {
    let albums = await searchSaavnAlbums(movieName + ' movie', 5);
    if (!albums.length) albums = await searchSaavnAlbums(movieName, 5);

    let songs = [];
    let albumMeta = null;

    if (albums.length > 0) {
      albumMeta = albums[0];
      const albumDetail = await getAlbumById(albumMeta.id);
      if (albumDetail?.songs) {
        songs = albumDetail.songs.map(normalizeSong).filter(Boolean);
        if (albumDetail.image) albumMeta.image = albumDetail.image;
      }
    }

    // Fallback: direct song search
    if (songs.length === 0) {
      songs = await searchSaavnSongs(movieName + ' songs', 20);
    }

    hideLoading();
    if (!songs.length) {
      showToast('No songs found for "' + movieName + '"');
      return;
    }

    state.queue = songs;
    renderMovieResults(movieName, albumMeta, songs);

    const imgs = albumMeta?.image || [];
    const posterUrl = (imgs[2]?.url || imgs[1]?.url || imgs[0]?.url || '')
      .replace('50x50', '500x500').replace('150x150', '500x500');
    if (posterUrl) {
      setTimeout(() => extractAndApplyColors(posterUrl, 'movieHeader'), 400);
    } else {
      const firstSongImg = songs.find(s => s.image)?.image;
      if (firstSongImg) setTimeout(() => extractAndApplyColors(firstSongImg, 'movieHeader'), 400);
    }
  } catch (e) {
    hideLoading();
    showToast('Failed to load movie songs');
    console.error(e);
  }
}

// ─── RENDER FUNCTIONS ─────────────────────────────────
function renderSearchResults(songs, query, showLoadMore = false) {
  const container = document.getElementById('searchResults');
  if (!songs.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">😕</div><p>No results for "${query}"</p></div>`;
    return;
  }
  const cards = songs.map((s, i) => createMusicCard(s, i, 'main')).join('');
  const loadMoreBtn = showLoadMore
    ? `<div class="load-more-wrap" style="grid-column:1/-1;text-align:center;padding:16px 0">
        <button class="load-more-btn" id="loadMoreBtn" onclick="loadMoreSearchResults()">
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 14.03 20 13.07 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>
          Load More Songs
        </button>
      </div>`
    : '';
  container.innerHTML = cards + loadMoreBtn;
}

async function loadMoreSearchResults() {
  const q = state._lastSearchQuery;
  if (!q) return;
  state._searchPage = (state._searchPage || 1) + 1;
  const btn = document.getElementById('loadMoreBtn');
  if (btn) { btn.textContent = 'Loading…'; btn.disabled = true; }
  try {
    const nextPage = state._searchPage + 1;
    const [p1, p2] = await Promise.all([
      saavnFetch('/search/songs', { query: q, limit: 30, page: nextPage }).then(d => (d?.data?.results || d?.results || []).map(normalizeSong).filter(Boolean)).catch(() => []),
      saavnFetch('/search/songs', { query: q, limit: 30, page: nextPage + 1 }).then(d => (d?.data?.results || d?.results || []).map(normalizeSong).filter(Boolean)).catch(() => []),
    ]);
    const existingIds = new Set(state.queue.map(s => s.id));
    const newSongs = [...p1, ...p2].filter(s => !existingIds.has(s.id));
    if (!newSongs.length) { showToast('No more songs found'); if (btn) { btn.textContent = 'No more results'; } return; }
    state.queue = [...state.queue, ...newSongs];
    const startIdx = state.queue.length - newSongs.length;
    const newCards = newSongs.map((s, i) => createMusicCard(s, startIdx + i, 'main')).join('');
    const container = document.getElementById('searchResults');
    const wrap = container.querySelector('.load-more-wrap');
    if (wrap) wrap.insertAdjacentHTML('beforebegin', newCards);
    if (btn) { btn.textContent = 'Load More Songs'; btn.disabled = false; }
    showToast(`+${newSongs.length} more songs loaded`);
  } catch (e) {
    showToast('Failed to load more'); if (btn) { btn.textContent = 'Load More Songs'; btn.disabled = false; }
  }
}

function renderAlbumGrid(albums, query) {
  const container = document.getElementById('searchResults');
  if (!albums.length) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">😕</div><p>No albums for "${query}"</p></div>`;
    return;
  }
  container.innerHTML = albums.map(a => {
    const imgs = a.image || [];
    const img = (imgs[2]?.url || imgs[1]?.url || imgs[0]?.url || '')
      .replace('50x50', '500x500').replace('150x150', '500x500');
    const name = decodeHtml(a.name || a.title || 'Unknown');
    const artist = decodeHtml(a.primaryArtists || '');
    return `<div class="music-card" onclick="loadMovieSongs('${escJS(name)}')">
      <div class="card-art">
        ${img ? `<img src="${img}" alt="${escHTML(name)}" loading="lazy" crossorigin="anonymous" onerror="this.parentNode.innerHTML='<div class=\\'card-art-placeholder\\'>🎬</div>'" />` : '<div class="card-art-placeholder">🎬</div>'}
        <div class="card-play-overlay"><div class="card-play-btn"><svg viewBox="0 0 24 24" fill="white" width="20" height="20"><path d="M8 5v14l11-7z"/></svg></div></div>
      </div>
      <div class="card-title">${escHTML(name)}</div>
      <div class="card-subtitle">${escHTML(artist)}</div>
    </div>`;
  }).join('');
}

function renderMovieResults(movieName, albumMeta, songs) {
  const container = document.getElementById('movieResults');
  const imgs = albumMeta?.image || [];
  let posterUrl = (imgs[2]?.url || imgs[1]?.url || imgs[0]?.url || '')
    .replace('50x50', '500x500').replace('150x150', '500x500');

  const fullCount = songs.filter(s => s.fullSong).length;
  const fullBadge = fullCount > 0
    ? `<span style="color:#4ade80;font-weight:600">● ${fullCount} Full Songs</span>`
    : `<span style="color:#fb923c">⚡ Preview Only</span>`;

  container.innerHTML = `
    <div class="movie-header" id="movieHeader">
      ${posterUrl
      ? `<img class="movie-poster" src="${escHTML(posterUrl)}" alt="${escHTML(movieName)}" crossorigin="anonymous" onerror="this.outerHTML='<div class=\\'movie-poster-placeholder\\'>🎬</div>'" />`
      : '<div class="movie-poster-placeholder">🎬</div>'}
      <div class="movie-info">
        <div class="movie-category-tag">🎬 Movie Soundtrack</div>
        <h2 class="movie-title">${escHTML(movieName)}</h2>
        <div class="movie-meta">${songs.length} songs${albumMeta?.year ? ' • ' + albumMeta.year : ''} • ${fullBadge}</div>
        <button class="movie-play-all" onclick="playAll()">
          <svg viewBox="0 0 24 24" fill="white" width="18" height="18"><path d="M8 5v14l11-7z"/></svg>
          Play All
        </button>
      </div>
    </div>
    <div class="song-list-header">
      <span>#</span><span></span><span>Title</span><span>Duration</span><span></span>
    </div>
    <div class="song-list-container">
      ${songs.map((s, i) => createSongListItem(s, i, 'movie')).join('')}
    </div>`;
}

function createMusicCard(song, index, context) {
  const isPlaying = state.currentIndex === index && state.isPlaying && state.queue[index]?.id === song.id;
  const isLiked = state.liked.some(l => l.id === song.id);
  const imgSrc = song.image || song.imageMed || '';
  return `<div class="music-card${isPlaying ? ' now-playing-card' : ''}" onclick="playSongAt(${index})" oncontextmenu="showCtxMenu(event,state.queue[${index}],${index})">
    <div class="card-art">
      ${imgSrc
      ? `<img src="${escHTML(imgSrc)}" alt="${escHTML(song.name)}" loading="lazy" crossorigin="anonymous" onerror="this.parentNode.innerHTML='<div class=\\'card-art-placeholder\\'>🎵</div>'" />`
      : '<div class="card-art-placeholder">🎵</div>'}
      <div class="card-play-overlay"><div class="card-play-btn"><svg viewBox="0 0 24 24" fill="white" width="20" height="20"><path d="M8 5v14l11-7z"/></svg></div></div>
      ${isPlaying ? '<div class="eq-bars"><div class="eq-bar"></div><div class="eq-bar"></div><div class="eq-bar"></div></div>' : ''}
    </div>
    <div class="card-title">${escHTML(song.name)}</div>
    <div class="card-subtitle">${escHTML(song.artist || '')}</div>
    ${!song.fullSong ? '<div style="font-size:0.68rem;color:#fb923c;padding-top:2px">30s preview</div>' : ''}
  </div>`;
}

function createSongListItem(song, index, context) {
  const isLiked = state.liked.some(l => l.id === song.id);
  const imgSrc = song.imageMed || song.image || '';
  const fullBadge = song.fullSong
    ? '<span class="full-badge">FULL</span>'
    : '<span class="preview-badge">30s</span>';
  return `<div class="song-item" id="sitem-${escHTML(song.id)}" onclick="playFromList(${index})" oncontextmenu="showCtxMenu(event,state.queue[${index}],${index})">
    <span class="song-num">${index + 1}</span>
    <div class="song-art-mini">
      ${imgSrc
      ? `<img src="${escHTML(imgSrc)}" alt="" loading="lazy" crossorigin="anonymous" onerror="this.parentNode.innerHTML='<div class=\\'song-art-mini-placeholder\\'>🎵</div>'" />`
      : '<div class="song-art-mini-placeholder">🎵</div>'}
    </div>
    <div class="song-details">
      <div class="song-name">${escHTML(song.name)}</div>
      <div class="song-artist">${escHTML(song.artist || '')} ${fullBadge}</div>
    </div>
    <div class="song-duration">${formatDuration(song.duration)}</div>
    <button class="song-like-btn${isLiked ? ' liked' : ''}" onclick="toggleSongLike(event,'${escJS(song.id)}')" title="Like">♥</button>
  </div>`;
}

function playFromList(index) {
  playSongAt(index);
  document.querySelectorAll('.song-item').forEach((el, i) => {
    el.classList.toggle('playing', i === index);
    const numEl = el.querySelector('.song-num');
    if (numEl) numEl.textContent = i === index ? '▶' : String(i + 1);
  });
}

// ─── HOME SECTIONS ────────────────────────────────────
async function loadHomeSections() {
  await Promise.all([
    loadQuickPicks(),
    loadSection('featuredCards', 'trending 2024 Telugu Hindi Tamil songs', '🎵'),
    loadMovieCards(),
    loadSection('classicCards', 'classic 80s 90s Telugu Hindi songs old', '🎶'),
    loadMadeForYou(),
  ]);
  const firstSong = window['queue_featuredCards']?.[0];
  if (firstSong?.image) setTimeout(() => extractAndApplyColors(firstSong.image), 800);
}

// Quick picks with real movie posters from JioSaavn
const QUICK_PICK_MOVIES = [
  { label: 'RRR', query: 'RRR', search: 'RRR movie songs' },
  { label: 'Pushpa 2', query: 'Pushpa 2', search: 'Pushpa 2 songs' },
  { label: 'Kalki 2898', query: 'Kalki 2898 AD', search: 'Kalki 2898 AD songs' },
  { label: 'Devara', query: 'Devara', search: 'Devara movie songs' },
  { label: 'KGF 2', query: 'KGF Chapter 2', search: 'KGF Chapter 2 songs' },
  { label: 'Jawan', query: 'Jawan', search: 'Jawan movie songs' },
  { label: 'Leo', query: 'Leo Tamil', search: 'Leo Tamil songs' },
  { label: 'Animal', query: 'Animal 2023', search: 'Animal 2023 songs' },
  { label: 'Bahubali 2', query: 'Bahubali 2', search: 'Bahubali 2 songs' },
  { label: 'Vikram', query: 'Vikram Tamil', search: 'Vikram Tamil songs' },
  { label: 'Salaar', query: 'Salaar', search: 'Salaar songs' },
  { label: 'HanuMan', query: 'HanuMan', search: 'HanuMan Telugu songs' },
  { label: 'Adipurush', query: 'Adipurush', search: 'Adipurush songs' },
  { label: 'Ponniyin S1', query: 'Ponniyin Selvan', search: 'Ponniyin Selvan songs' },
  { label: 'Pathaan', query: 'Pathaan', search: 'Pathaan songs' },
  { label: 'Gadar 2', query: 'Gadar 2', search: 'Gadar 2 songs' },
];

async function loadQuickPicks() {
  const container = document.getElementById('quickPicks');
  if (!container) return;
  const results = await Promise.allSettled(
    QUICK_PICK_MOVIES.map(async (m) => {
      const albs = await searchSaavnAlbums(m.query, 1);
      const alb = albs[0];
      const img = getBestImage(alb?.image || [], 'high');
      return { ...m, img };
    })
  );
  container.innerHTML = results.map((r) => {
    if (r.status !== 'fulfilled') return '';
    const { label, search, img } = r.value;
    return `<div class="quick-card" onclick="searchByGenre('${escJS(search)}')">
      ${img
        ? `<img class="qc-poster" src="${escHTML(img)}" alt="${escHTML(label)}" loading="lazy" />`
        : `<div class="qc-no-img" style="background:linear-gradient(135deg,#a855f7,#06b6d4)"></div>`}
      <div class="qc-overlay"><span>${escHTML(label)}</span></div>
      <div class="qc-play"><svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M8 5v14l11-7z"/></svg></div>
    </div>`;
  }).join('');
}

async function loadSection(containerId, query, emoji = '🎵') {
  try {
    const songs = await searchSaavnSongs(query, 16);
    const container = document.getElementById(containerId);
    if (!container) return;
    window['queue_' + containerId] = songs.slice(0, 16);
    container.innerHTML = songs.slice(0, 16).map((s, i) => createHomeMusicCard(s, i, containerId, emoji)).join('');
  } catch (e) { }
}

function createHomeMusicCard(song, index, queueName, emoji) {
  const imgSrc = song.image || song.imageMed || '';
  return `<div class="music-card" onclick="playFromQueue('${queueName}',${index})" oncontextmenu="showCtxMenu(event,window['queue_${queueName}']?.[${index}],${index})">
    <div class="card-art">
      ${imgSrc
      ? `<img src="${escHTML(imgSrc)}" alt="${escHTML(song.name)}" loading="lazy" crossorigin="anonymous" onerror="this.parentNode.innerHTML='<div class=\\'card-art-placeholder\\'>${emoji}</div>'" />`
      : `<div class="card-art-placeholder">${emoji}</div>`}
      <div class="card-play-overlay"><div class="card-play-btn"><svg viewBox="0 0 24 24" fill="white" width="20" height="20"><path d="M8 5v14l11-7z"/></svg></div></div>
    </div>
    <div class="card-title">${escHTML(song.name)}</div>
    <div class="card-subtitle">${escHTML(song.artist || '')}</div>
  </div>`;
}

async function loadMovieCards() {
  // Telugu blockbusters
  const teluguMovies = ['RRR', 'Pushpa 2', 'Bahubali', 'Devara', 'HanuMan', 'Salaar', 'Kalki 2898 AD', 'Guntur Kaaram'];
  // Hindi hits
  const hindiMovies = ['Jawan', 'Animal 2023', 'Pathaan', 'Gadar 2', 'Dunki'];
  // Tamil hits  
  const tamilMovies = ['Leo Tamil', 'Vikram Tamil', 'Ponniyin Selvan', 'Jailer Tamil', 'Kanguva'];
  const allMovies = [...teluguMovies, ...hindiMovies, ...tamilMovies];
  const container = document.getElementById('movieCards');
  if (!container) return;
  const cardHtmlArr = await Promise.allSettled(allMovies.map(async (m) => {
    const albs = await searchSaavnAlbums(m, 1);
    const alb = albs[0];
    const img = getBestImage(alb?.image || [], 'high');
    const cleanName = m.replace(/ Tamil| Telugu| Hindi/gi, '');
    return `<div class="music-card" onclick="loadMovieSongs('${escJS(m)}')">
      <div class="card-art">
        ${img ? `<img src="${escHTML(img)}" alt="${escHTML(cleanName)}" loading="lazy" crossorigin="anonymous" onerror="this.parentNode.innerHTML='<div class=\\'card-art-placeholder\\'>🎬</div>'" />` : '<div class="card-art-placeholder">🎬</div>'}
        <div class="card-play-overlay"><div class="card-play-btn"><svg viewBox="0 0 24 24" fill="white" width="20" height="20"><path d="M8 5v14l11-7z"/></svg></div></div>
      </div>
      <div class="card-title">${escHTML(cleanName)}</div>
      <div class="card-subtitle">Movie Soundtrack</div>
    </div>`;
  }));
  container.innerHTML = cardHtmlArr.map(r => r.status === 'fulfilled' ? r.value : '').join('');
}

function playFromQueue(queueName, index) {
  const q = window['queue_' + queueName];
  if (!q) return;
  state.queue = q;
  playSongAt(index);
}

// ─── PLAYBACK ─────────────────────────────────────────

// Decode JioSaavn media URL (some APIs return base64/encoded URLs)
function decodeSaavnUrl(url) {
  if (!url) return '';
  // Some API versions return DES-encrypted URLs — we can't decrypt those,
  // but direct CDN URLs (aac.saavncdn.com, etc.) work fine as-is
  return url;
}

// Get all possible download URLs from a song detail object
function extractDlUrls(detail) {
  const raw = detail?.downloadUrl || detail?.download_url || detail?.media_url || [];
  let arr = [];
  if (Array.isArray(raw) && raw.length > 0) arr = raw;
  else if (typeof raw === 'string' && raw.length > 0) arr = [{ quality: '128kbps', url: raw }];
  else if (detail?.['320kbps']) arr = [{ quality: '320kbps', url: detail['320kbps'] }];
  // Normalize .link → .url
  return arr.map(u => ({ quality: u.quality || '', url: u.url || u.link || '' })).filter(u => u.url);
}

// Fetch fresh download URLs — tries every working API strategy
async function fetchFreshSaavnUrl(song) {
  if (!song.id) return null;
  const id = song.id;
  // Always clear stale URLs first — JioSaavn CDN links expire quickly
  song.downloadUrl = [];
  song.fullSong = false;

  // Only two APIs confirmed working (no CORS block)
  const API_BASES = [
    'https://saavan-api.vercel.app',
    'https://jiosaavn-api-2.vercel.app',
  ];

  for (const base of API_BASES) {
    // Try /songs/{id}
    try {
      const r = await fetch(`${base}/songs/${id}`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        const d = await r.json();
        const detail = d?.data?.[0] || d?.data || (Array.isArray(d) ? d[0] : null);
        if (detail) {
          const dlUrls = extractDlUrls(detail);
          if (dlUrls.length > 0) {
            song.downloadUrl = dlUrls;
            song.fullSong = true;
            const best = getBestUrl(song);
            if (best) { console.log('✅ URL from', base, ':', best.substring(0, 60)); return best; }
          }
        }
      }
    } catch (e) { /* continue */ }

    // Try /songs?id={id}
    try {
      const r = await fetch(`${base}/songs?id=${id}`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        const d = await r.json();
        const detail = d?.data?.[0] || d?.data || (Array.isArray(d) ? d[0] : null);
        if (detail) {
          const dlUrls = extractDlUrls(detail);
          if (dlUrls.length > 0) {
            song.downloadUrl = dlUrls;
            song.fullSong = true;
            const best = getBestUrl(song);
            if (best) { console.log('✅ URL from', base, '(query):', best.substring(0, 60)); return best; }
          }
        }
      }
    } catch (e) { /* continue */ }
  }

  console.warn('❌ All API strategies exhausted for song:', id);
  return null;
}

// Try playing audio — if CORS blocked, retry with proxy
async function tryPlayAudio(url) {
  audio.src = url;
  try {
    await audio.play();
    return true;
  } catch (e1) {
    if (e1.name === 'NotAllowedError') {
      console.warn('Autoplay blocked — user must tap play');
      return 'blocked';
    }
    // Try proxied URL as last resort
    try {
      const proxied = AUDIO_PROXY + encodeURIComponent(url);
      audio.src = proxied;
      await audio.play();
      console.log('✅ Playing via CORS proxy');
      return true;
    } catch (e2) {
      return false;
    }
  }
}

async function playSongAt(index) {
  if (index < 0 || index >= state.queue.length) return;
  const song = state.queue[index];
  if (!song) return;
  state.currentIndex = index;
  updateNowPlayingUI(song);

  if (song.image) setTimeout(() => extractAndApplyColors(song.image), 100);
  showToast('⏳ Loading…');

  let url = null;

  // Step 1: Fetch fresh URL from JioSaavn (always — URLs expire quickly)
  url = await fetchFreshSaavnUrl(song);
  if (url) song.fullSong = true;

  // Step 2: Try already-cached downloadUrl as fallback
  if (!url && song.downloadUrl?.length) {
    url = getBestUrl(song);
    console.log('Using cached URL:', url?.substring(0, 60));
  }

  if (!url) {
    showToast('❌ Song not available — trying next…');
    setTimeout(() => nextSong(), 1500);
    return;
  }

  audio.volume = state.volume;
  audio.muted = state.isMuted;

  // On audio error: try all lower-quality URLs, then proxy, then next song
  const handleAudioError = async () => {
    audio.removeEventListener('error', handleAudioError);
    console.warn('Audio error — trying fallback URLs');
    if (song.downloadUrl?.length) {
      const qualities = ['320kbps', '160kbps', '96kbps', '48kbps', '12kbps'];
      for (const q of qualities) {
        const alt = song.downloadUrl.find(u => u.quality === q && u.url && u.url !== audio.src);
        if (alt) {
          console.log('Trying quality fallback:', q);
          const result = await tryPlayAudio(alt.url);
          if (result === true) {
            state.isPlaying = true;
            updatePlayPauseBtn(true);
            return;
          }
          if (result === 'blocked') {
            showToast('▶ Tap play to start');
            return;
          }
        }
      }
    }
    showToast('❌ Cannot play — trying next song…');
    setTimeout(() => nextSong(), 1500);
  };

  audio.addEventListener('error', handleAudioError, { once: true });

  const playResult = await tryPlayAudio(url);
  if (playResult === true) {
    state.isPlaying = true;
    updatePlayPauseBtn(true);
    document.getElementById('vinylDisc')?.classList.add('playing');
    document.getElementById('nowArt')?.classList.add('playing-art');
    addToRecent(song);
    renderQueue();
    updateQueueActiveItem();
    updateLikeBtn();
    document.title = `♪ ${song.name} — Nitin Musi`;
    if ('mediaSession' in navigator) updateMediaSession(song);
    showToast('🎵 ' + song.name);
  } else if (playResult === 'blocked') {
    // Autoplay blocked — set up audio src so user can tap play
    audio.src = url;
    state.isPlaying = false;
    updatePlayPauseBtn(false);
    document.getElementById('nowArt')?.classList.add('playing-art');
    addToRecent(song);
    renderQueue();
    updateQueueActiveItem();
    updateLikeBtn();
    document.title = `♪ ${song.name} — Nitin Musi`;
    if ('mediaSession' in navigator) updateMediaSession(song);
    showToast('▶ Tap play to start');
  } else {
    showToast('❌ Cannot play — trying next…');
    setTimeout(() => nextSong(), 1500);
  }
}

function playAll() {
  if (state.queue.length) playSongAt(0);
}

function updateNowPlayingUI(song) {
  document.getElementById('nowTitle').textContent = song.name || 'Unknown';
  document.getElementById('nowArtist').textContent = song.artist || '';
  const nowArt = document.getElementById('nowArt');
  if (song.image) {
    nowArt.innerHTML = `<img src="${song.image}" alt="" crossorigin="anonymous" onerror="this.outerHTML='<div class=\\'art-placeholder\\'>♪</div>'" />`;
  } else {
    nowArt.innerHTML = '<div class="art-placeholder">♪</div>';
  }
  // Sync fullscreen player
  if (fpIsOpen) updateFullscreenUI(song);
}

// ─── CONTROLS ─────────────────────────────────────────
function togglePlay() {
  if (!state.queue.length) { showToast('Select a song first'); return; }
  if (state.currentIndex < 0) { playSongAt(0); return; }
  if (state.isPlaying) {
    audio.pause();
    state.isPlaying = false;
    document.getElementById('vinylDisc')?.classList.remove('playing');
  } else {
    audio.play().catch(() => { });
    state.isPlaying = true;
    document.getElementById('vinylDisc')?.classList.add('playing');
  }
  updatePlayPauseBtn(state.isPlaying);
}

function updatePlayPauseBtn(playing) {
  document.getElementById('playIcon').style.display = playing ? 'none' : 'block';
  document.getElementById('pauseIcon').style.display = playing ? 'block' : 'none';
  // Sync fullscreen icons
  const fpp = document.getElementById('fpPlayIcon');
  const fpu = document.getElementById('fpPauseIcon');
  if (fpp) fpp.style.display = playing ? 'none' : 'block';
  if (fpu) fpu.style.display = playing ? 'block' : 'none';
}

function nextSong() {
  if (!state.queue.length) return;
  let next = state.isShuffle
    ? Math.floor(Math.random() * state.queue.length)
    : (state.currentIndex + 1) % state.queue.length;
  playSongAt(next);
}

function previousSong() {
  if (!state.queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  const prev = (state.currentIndex - 1 + state.queue.length) % state.queue.length;
  playSongAt(prev);
}

function toggleShuffle() {
  state.isShuffle = !state.isShuffle;
  document.getElementById('shuffleBtn').classList.toggle('active', state.isShuffle);
  showToast(state.isShuffle ? '🔀 Shuffle ON' : 'Shuffle OFF');
}

function toggleRepeat() {
  state.isRepeat = !state.isRepeat;
  audio.loop = state.isRepeat;
  document.getElementById('repeatBtn').classList.toggle('active', state.isRepeat);
  showToast(state.isRepeat ? '🔁 Repeat ON' : 'Repeat OFF');
}

function toggleMute() {
  state.isMuted = !state.isMuted;
  audio.muted = state.isMuted;
  document.getElementById('volIcon').style.opacity = state.isMuted ? '0.3' : '1';
}

function setVolume(val) {
  state.volume = val / 100;
  audio.volume = state.volume;
  state.isMuted = false; audio.muted = false;
  document.getElementById('volIcon').style.opacity = '1';
}

function seekTo(e) {
  const track = document.getElementById('progressTrack');
  const rect = track.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  if (audio.duration) audio.currentTime = pct * audio.duration;
}

// ─── AUDIO EVENTS ─────────────────────────────────────
audio.addEventListener('timeupdate', () => {
  if (!audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('progressThumb').style.left = pct + '%';
  document.getElementById('currentTime').textContent = formatDuration(Math.floor(audio.currentTime));
  document.getElementById('totalTime').textContent = formatDuration(Math.floor(audio.duration));
  // Sync fullscreen progress
  if (fpIsOpen) {
    const ff = document.getElementById('fpProgressFill');
    const ft = document.getElementById('fpProgressThumb');
    const fc = document.getElementById('fpCurrentTime');
    const fd = document.getElementById('fpTotalTime');
    if (ff) ff.style.width = pct + '%';
    if (ft) ft.style.left = pct + '%';
    if (fc) fc.textContent = formatDuration(Math.floor(audio.currentTime));
    if (fd) fd.textContent = formatDuration(Math.floor(audio.duration));
  }
});
audio.addEventListener('ended', () => {
  if (sleepEndOfSong) {
    sleepEndOfSong = false;
    document.getElementById('sleepTimerBtn')?.classList.remove('active');
    showToast('😴 Sleep timer — music paused');
    state.isPlaying = false; updatePlayPauseBtn(false);
    return;
  }
  if (!state.isRepeat) nextSong();
});
audio.addEventListener('play', () => { state.isPlaying = true; updatePlayPauseBtn(true); });
audio.addEventListener('pause', () => { state.isPlaying = false; updatePlayPauseBtn(false); });
// Note: per-song error handling is done via handleAudioError in playSongAt()

// ─── LIKE ─────────────────────────────────────────────
function toggleLike() {
  if (state.currentIndex < 0) return;
  const song = state.queue[state.currentIndex];
  if (song) { toggleSongLikeById(song.id); updateLikeBtn(); updateFpLikeBtn(); }
}

function toggleSongLike(e, songId) {
  e.stopPropagation();
  toggleSongLikeById(songId);
  e.target.classList.toggle('liked', state.liked.some(l => l.id === songId));
  if (state.queue[state.currentIndex]?.id === songId) updateLikeBtn();
}

function toggleSongLikeById(songId) {
  const idx = state.liked.findIndex(l => l.id === songId);
  if (idx >= 0) {
    state.liked.splice(idx, 1);
    showToast('Removed from Liked Songs');
  } else {
    const song = state.queue.find(s => s.id === songId) || state.queue[state.currentIndex];
    if (song) { state.liked.unshift(song); showToast('❤️ Liked!'); }
  }
  localStorage.setItem('melodify_liked', JSON.stringify(state.liked));
  document.getElementById('likedCount').textContent = state.liked.length + ' songs';
}

function updateLikeBtn() {
  const song = state.queue[state.currentIndex];
  if (!song) return;
  const liked = state.liked.some(l => l.id === song.id);
  const btn = document.getElementById('likeBtn');
  btn.classList.toggle('liked', liked);
}

// ─── LIBRARY ─────────────────────────────────────────
function addToRecent(song) {
  state.recent = [song, ...state.recent.filter(r => r.id !== song.id)].slice(0, 50);
  localStorage.setItem('melodify_recent', JSON.stringify(state.recent));
}

function renderLibrary() {
  renderLibTab('likedSongsList', state.liked);
  renderLibTab('recentSongsList', state.recent);
}

function renderLibTab(containerId, songs) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = songs.length
    ? songs.map((s, i) => `<div class="song-item" onclick="playLibraryItem(${i},'${containerId}')">
        <span class="song-num">${i + 1}</span>
        <div class="song-art-mini">${s.image ? `<img src="${s.image}" loading="lazy" crossorigin="anonymous" />` : '<div class="song-art-mini-placeholder">🎵</div>'}</div>
        <div class="song-details"><div class="song-name">${escHTML(s.name)}</div><div class="song-artist">${escHTML(s.artist || '')}</div></div>
        <div class="song-duration">${formatDuration(s.duration)}</div>
        <button class="song-like-btn liked" onclick="toggleSongLike(event,'${escJS(s.id)}')">♥</button>
      </div>`).join('')
    : '<div class="empty-state"><div class="empty-icon">🎵</div><p>Nothing here yet</p></div>';
}

function playLibraryItem(index, containerId) {
  const sourceMap = {
    likedSongsList: state.liked,
    recentSongsList: state.recent,
  };
  state.queue = [...(sourceMap[containerId] || [])];
  playSongAt(index);
}

function showLibTab(tab, btn) {
  document.querySelectorAll('.lib-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('likedSongsList').style.display = tab === 'liked' ? 'flex' : 'none';
  document.getElementById('recentSongsList').style.display = tab === 'recent' ? 'flex' : 'none';
}

// ─── QUEUE ────────────────────────────────────────────
function renderQueue() {
  const list = document.getElementById('queueList');
  if (!state.queue.length) { list.innerHTML = '<div style="padding:20px;color:var(--text-muted);text-align:center">Empty queue</div>'; return; }
  list.innerHTML = state.queue.map((s, i) => `
    <div class="queue-item${i === state.currentIndex ? ' active' : ''}" onclick="playSongAt(${i})">
      <div class="queue-item-art">${s.image ? `<img src="${s.image}" crossorigin="anonymous">` : '🎵'}</div>
      <div class="queue-item-info">
        <div class="queue-item-title">${escHTML(s.name)}</div>
        <div class="queue-item-artist">${escHTML(s.artist || '')}</div>
      </div>
    </div>`).join('');
}

function updateQueueActiveItem() {
  document.querySelectorAll('.queue-item').forEach((el, i) => {
    el.classList.toggle('active', i === state.currentIndex);
  });
}

// ─── MEDIA SESSION ───────────────────────────────────
function updateMediaSession(song) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.name, artist: song.artist || '', album: song.album || 'Nitin Musi',
    artwork: song.image ? [{ src: song.image, sizes: '500x500', type: 'image/jpeg' }] : [],
  });
  navigator.mediaSession.setActionHandler('play', togglePlay);
  navigator.mediaSession.setActionHandler('pause', togglePlay);
  navigator.mediaSession.setActionHandler('nexttrack', nextSong);
  navigator.mediaSession.setActionHandler('previoustrack', previousSong);
}

// ─── KEYBOARD SHORTCUTS ───────────────────────────────
document.addEventListener('keydown', e => {
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  if (e.key === 'ArrowRight') { e.preventDefault(); nextSong(); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); previousSong(); }
  if (e.key === 'm') toggleMute();
  if (e.key === 's') toggleShuffle();
  if (e.key === 'r') toggleRepeat();
  if (e.key === 'l') toggleLike();
  if (e.key === 'q') toggleQueue();
});

// ─── UTILS ────────────────────────────────────────────
function formatDuration(sec) {
  if (!sec || isNaN(sec)) return '–';
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}
function decodeHtml(str) {
  if (!str) return '';
  const t = document.createElement('textarea');
  t.innerHTML = str; return t.value;
}
function escHTML(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escJS(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}
function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}
function showLoading(text) {
  document.getElementById('loadingOverlay').style.display = 'flex';
  document.getElementById('loadingText').textContent = text || 'Loading…';
}
function hideLoading() { document.getElementById('loadingOverlay').style.display = 'none'; }

// ─── PLAYLISTS ─────────────────────────────────────────
function savePlaylists() {
  localStorage.setItem('melodify_playlists', JSON.stringify(state.playlists));
  renderSidebarPlaylists();
}
function openPlaylistModal(song) {
  state.pendingSongForPlaylist = song || null;
  document.getElementById('playlistModal').style.display = 'flex';
  const inp = document.getElementById('playlistNameInput');
  inp.value = ''; setTimeout(() => inp.focus(), 80);
}
function createPlaylist() {
  const name = document.getElementById('playlistNameInput').value.trim();
  if (!name) { showToast('Enter a playlist name'); return; }
  const pl = { id: 'pl_' + Date.now(), name, songs: [], createdAt: Date.now() };
  state.playlists.unshift(pl);
  savePlaylists();
  document.getElementById('playlistModal').style.display = 'none';
  if (state.pendingSongForPlaylist) {
    addSongToPlaylist(pl.id, state.pendingSongForPlaylist);
    state.pendingSongForPlaylist = null;
  } else { showToast('✅ Playlist created!'); }
}
function addSongToPlaylist(pid, song) {
  const pl = state.playlists.find(p => p.id === pid);
  if (!pl) return;
  if (pl.songs.some(s => s.id === song.id)) { showToast('Already in "' + pl.name + '"'); return; }
  pl.songs.unshift(song); savePlaylists();
  showToast('Added to "' + pl.name + '"');
}
function removeSongFromPlaylist(pid, songId) {
  const pl = state.playlists.find(p => p.id === pid);
  if (!pl) return;
  pl.songs = pl.songs.filter(s => s.id !== songId);
  savePlaylists(); showToast('Removed'); loadPlaylistView(pid);
}
function deletePlaylist(pid) {
  state.playlists = state.playlists.filter(p => p.id !== pid);
  savePlaylists(); showSection('library'); showToast('Playlist deleted');
}
function renderSidebarPlaylists() {
  const el = document.getElementById('sidebarPlaylistsList');
  if (!el) return;
  el.innerHTML = state.playlists.length
    ? state.playlists.map(pl =>
      `<button class="sidebar-pl-item" onclick="loadPlaylistView('${pl.id}')">
          <span class="spl-icon">📋</span>
          <span class="spl-name">${escHTML(pl.name)}</span>
          <span class="spl-count">${pl.songs.length}</span>
        </button>`).join('')
    : '<div class="spl-empty">No playlists yet</div>';
}
function loadPlaylistView(pid) {
  const pl = state.playlists.find(p => p.id === pid);
  if (!pl) return;
  showSection('playlist-detail');
  state.queue = [...pl.songs];
  document.getElementById('playlistDetailContent').innerHTML = `
    <div class="playlist-hdr">
      <div class="pl-icon-big">📋</div>
      <div class="pl-hdr-info">
        <div class="pl-type-tag">Playlist</div>
        <h2 class="pl-hdr-name">${escHTML(pl.name)}</h2>
        <div class="pl-hdr-meta">${pl.songs.length} songs</div>
        <div style="display:flex;gap:10px;margin-top:12px">
          ${pl.songs.length ? `<button class="movie-play-all" onclick="playAll()"><svg viewBox="0 0 24 24" fill="white" width="18" height="18"><path d="M8 5v14l11-7z"/></svg> Play All</button>` : ''}
          <button class="pl-del-btn" onclick="deletePlaylist('${pl.id}')">🗑️ Delete</button>
        </div>
      </div>
    </div>
    ${pl.songs.length
      ? `<div class="song-list-header"><span>#</span><span></span><span>Title</span><span>Duration</span><span></span></div>
         <div class="song-list-container">${pl.songs.map((s, i) =>
        `<div class="song-item" onclick="playFromList(${i})">
            <span class="song-num">${i + 1}</span>
            <div class="song-art-mini">${s.image ? `<img src="${escHTML(s.image)}" loading="lazy" crossorigin="anonymous" />` : '<div class="song-art-mini-placeholder">🎵</div>'}</div>
            <div class="song-details"><div class="song-name">${escHTML(s.name)}</div><div class="song-artist">${escHTML(s.artist || '')}</div></div>
            <div class="song-duration">${formatDuration(s.duration)}</div>
            <button class="song-like-btn" onclick="event.stopPropagation();removeSongFromPlaylist('${pid}','${escJS(s.id)}')" title="Remove">✕</button>
          </div>`).join('')}</div>`
      : '<div class="empty-state"><div class="empty-icon">🎵</div><p>No songs — right-click any song to add!</p></div>'}`;
}

// ─── FULL SCREEN PLAYER ─────────────────────────────
let fpIsOpen = false;
function toggleFullscreen() {
  fpIsOpen = !fpIsOpen;
  const fp = document.getElementById('fullscreenPlayer');
  fp.style.display = fpIsOpen ? 'flex' : 'none';
  if (fpIsOpen) {
    const song = state.queue[state.currentIndex];
    if (song) updateFullscreenUI(song);
  }
}
function updateFullscreenUI(song) {
  document.getElementById('fpTitle').textContent = song.name || 'Unknown';
  document.getElementById('fpArtist').textContent = song.artist || '';
  const fpArt = document.getElementById('fpArt');
  fpArt.innerHTML = song.image
    ? `<img src="${escHTML(song.image)}" alt="" crossorigin="anonymous" />`
    : '<div style="font-size:5rem;color:var(--text-muted)">♪</div>';
  const bg = document.getElementById('fpBg');
  if (bg && song.image) bg.style.backgroundImage = `url(${song.image})`;
  updateFpLikeBtn();
}
function updateFpLikeBtn() {
  const song = state.queue[state.currentIndex];
  if (!song) return;
  const liked = state.liked.some(l => l.id === song.id);
  document.getElementById('fpLikeBtn')?.classList.toggle('liked', liked);
}

// ─── CONTEXT MENU ───────────────────────────────────
let ctxSong = null, ctxSongIndex = -1;
function showCtxMenu(e, song, index) {
  e.preventDefault(); e.stopPropagation();
  ctxSong = song; ctxSongIndex = index;
  const menu = document.getElementById('ctxMenu');
  menu.style.display = 'block';
  const x = Math.min(e.clientX, window.innerWidth - 220);
  const y = Math.min(e.clientY, window.innerHeight - 260);
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  const liked = song && state.liked.some(l => l.id === song.id);
  document.getElementById('ctxLikeBtn').innerHTML = liked ? '❤️ Unlike' : '♥ Like';
  // Build playlist submenu
  const sub = document.getElementById('ctxPlaylistSub');
  sub.innerHTML = `<div class="ctx-sub-item" onmousedown="openPlaylistModal(ctxSong)">+ New Playlist</div>` +
    state.playlists.map(pl =>
      `<div class="ctx-sub-item" onmousedown="addSongToPlaylist('${pl.id}',ctxSong)">${escHTML(pl.name)}</div>`
    ).join('');
}
function hideCtxMenu() { document.getElementById('ctxMenu').style.display = 'none'; ctxSong = null; }
function ctxPlay() { if (ctxSongIndex >= 0) playFromList(ctxSongIndex); hideCtxMenu(); }
function ctxAddToQueue() {
  if (!ctxSong) return;
  if (!state.queue.some(s => s.id === ctxSong.id)) { state.queue.push(ctxSong); showToast('Added to queue'); }
  else showToast('Already in queue');
  hideCtxMenu();
}
function ctxLike() { if (ctxSong) { toggleSongLikeById(ctxSong.id); updateLikeBtn(); } hideCtxMenu(); }
function ctxGoToArtist() {
  if (ctxSong?.artist) searchActor(ctxSong.artist.split(',')[0].trim());
  hideCtxMenu();
}
document.addEventListener('click', e => {
  if (!document.getElementById('ctxMenu')?.contains(e.target)) hideCtxMenu();
});

// ─── SLEEP TIMER ─────────────────────────────────────
let sleepTimerId = null, sleepEndOfSong = false;
function toggleSleepPopup() {
  const p = document.getElementById('sleepPopup');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
}
function setSleepTimer(minutes) {
  if (sleepTimerId) { clearTimeout(sleepTimerId); sleepTimerId = null; }
  sleepEndOfSong = false;
  const btn = document.getElementById('sleepTimerBtn');
  if (minutes === 0) {
    showToast('⏰ Sleep timer off');
    btn?.classList.remove('active');
  } else if (minutes === -1) {
    sleepEndOfSong = true;
    showToast('⏰ Stops after current song');
    btn?.classList.add('active');
  } else {
    sleepTimerId = setTimeout(() => {
      audio.pause(); state.isPlaying = false; updatePlayPauseBtn(false);
      showToast('😴 Sleep timer — paused'); btn?.classList.remove('active');
    }, minutes * 60000);
    showToast(`⏰ Pausing in ${minutes} min`);
    btn?.classList.add('active');
  }
  document.getElementById('sleepPopup').style.display = 'none';
}

// ─── MADE FOR YOU ──────────────────────────────────
async function loadMadeForYou() {
  const container = document.getElementById('madeForYouCards');
  if (!container) return;
  const pool = [...state.recent.slice(0, 5), ...state.liked.slice(0, 3)];
  let query = 'trending 2024 Telugu songs';
  if (pool.length > 0) {
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const artist = pick.artist?.split(',')[0]?.trim();
    query = artist ? `${artist} songs` : query;
  }
  try {
    const songs = await searchSaavnSongs(query, 12);
    window['queue_madeForYou'] = songs;
    container.innerHTML = songs.slice(0, 10).map((s, i) => createHomeMusicCard(s, i, 'madeForYou', '💜')).join('');
  } catch (e) {
    container.innerHTML = '<div style="color:var(--text-muted);padding:10px">Could not load</div>';
  }
}

// ─── INIT ─────────────────────────────────────────────
document.getElementById('likedCount').textContent = state.liked.length + ' songs';
document.getElementById('globalSearch').addEventListener('focus', () => {
  const q = document.getElementById('globalSearch').value.trim();
  if (q.length > 1) showSearchSuggestions(q);
});
document.getElementById('globalSearch').addEventListener('blur', () => {
  setTimeout(hideSuggestions, 200);
});
document.getElementById('movieSearchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') searchMovie();
});
document.getElementById('actorSearchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') searchActor(e.target.value.trim());
});
document.getElementById('playlistNameInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') createPlaylist();
});
renderSidebarPlaylists();

// Load home data
loadHomeSections();
