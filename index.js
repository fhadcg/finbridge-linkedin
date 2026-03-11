/**
 * Finbridge LinkedIn Auto-Poster
 * ================================
 * Stap 1: node index.js
 * Stap 2: Klik de link die verschijnt in de terminal
 * Stap 3: Log in bij LinkedIn → geef toestemming
 * Stap 4: Klaar! Posts worden automatisch verstuurd.
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const posts = require('./posts');

const app = express();
const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/callback';
const TOKEN_FILE = path.join(__dirname, '.tokens.json');
const LOG_FILE = path.join(__dirname, 'posting-log.json');

// ─── Validate config ──────────────────────────────────────────────────────────
if (!CLIENT_ID || !CLIENT_SECRET || CLIENT_ID === 'jouw_client_id_hier') {
  console.error('\n❌ FOUT: .env bestand niet ingevuld!');
  console.error('📋 Open .env en vul LINKEDIN_CLIENT_ID en LINKEDIN_CLIENT_SECRET in.\n');
  process.exit(1);
}

// ─── Token storage ────────────────────────────────────────────────────────────
function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

function loadTokens() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// ─── Log posting results ──────────────────────────────────────────────────────
function logPost(postId, status, message) {
  let log = [];
  if (fs.existsSync(LOG_FILE)) {
    try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
  }
  log.push({ postId, status, message, timestamp: new Date().toISOString() });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  console.log(`[${new Date().toLocaleTimeString('nl-NL')}] Post #${postId}: ${status} — ${message}`);
}

// ─── LinkedIn API calls ───────────────────────────────────────────────────────
async function getPersonURN(accessToken) {
  const res = await axios.get('https://api.linkedin.com/v2/me', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return `urn:li:person:${res.data.id}`;
}

async function getCompanyURN(accessToken, companyId) {
  return `urn:li:organization:${companyId}`;
}

async function publishPost(accessToken, authorURN, text) {
  const payload = {
    author: authorURN,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: 'NONE'
      }
    },
    visibility: {
      'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC'
    }
  };

  const res = await axios.post('https://api.linkedin.com/v2/ugcPosts', payload, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0'
    }
  });

  return res.data;
}

// ─── Main posting function ────────────────────────────────────────────────────
async function postToLinkedIn(post) {
  const tokens = loadTokens();
  if (!tokens || !tokens.access_token) {
    logPost(post.id, 'SKIP', 'Geen tokens gevonden. Herstart de app en log opnieuw in.');
    return;
  }

  try {
    let authorURN;

    if (post.account === 'personal') {
      authorURN = await getPersonURN(tokens.access_token);
    } else {
      // company page — vul hieronder jouw LinkedIn company numeric ID in
      // Te vinden op: linkedin.com/company/finbridge-nl/ → admin panel → company ID
      const COMPANY_ID = tokens.company_id || process.env.LINKEDIN_COMPANY_ID || 'VOUW_COMPANY_ID_IN';
      authorURN = getCompanyURN(tokens.access_token, COMPANY_ID);
    }

    await publishPost(tokens.access_token, authorURN, post.text);
    logPost(post.id, '✅ GEPLAATST', post.title);

  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    logPost(post.id, '❌ FOUT', msg);

    // Token verlopen? Refresh automatisch
    if (err.response?.status === 401 && tokens.refresh_token) {
      console.log('🔄 Token verlopen, vernieuwen...');
      await refreshToken(tokens.refresh_token);
      // Retry once
      await postToLinkedIn(post);
    }
  }
}

// ─── Token refresh ────────────────────────────────────────────────────────────
async function refreshToken(refreshToken) {
  try {
    const res = await axios.post('https://www.linkedin.com/oauth/v2/accessToken', null, {
      params: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET
      }
    });
    const tokens = loadTokens() || {};
    tokens.access_token = res.data.access_token;
    if (res.data.refresh_token) tokens.refresh_token = res.data.refresh_token;
    tokens.expires_at = Date.now() + (res.data.expires_in * 1000);
    saveTokens(tokens);
    console.log('✅ Token vernieuwd');
  } catch (err) {
    console.error('❌ Token vernieuwen mislukt. Herstart de app en log opnieuw in.');
  }
}

// ─── Scheduler ────────────────────────────────────────────────────────────────
function startScheduler() {
  console.log('\n📅 Scheduler gestart. Controleer elke minuut op posts...\n');

  // Check every minute
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    const todayDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const currentHHMM = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

    const duePost = posts.find(p => p.date === todayDate && p.time === currentHHMM);

    if (duePost) {
      // Check if already posted
      let log = [];
      if (fs.existsSync(LOG_FILE)) {
        try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
      }
      const alreadyPosted = log.some(l => l.postId === duePost.id && l.status.includes('GEPLAATST'));

      if (!alreadyPosted) {
        console.log(`\n🚀 Tijd om te posten: Post #${duePost.id} — "${duePost.title}"`);
        await postToLinkedIn(duePost);
      }
    }
  });

  // Show upcoming posts
  showUpcoming();
}

function showUpcoming() {
  const now = new Date();
  const upcoming = posts
    .filter(p => new Date(`${p.date}T${p.time}:00`) > now)
    .slice(0, 5);

  console.log('📋 Volgende 5 geplande posts:');
  console.log('─'.repeat(60));
  upcoming.forEach(p => {
    console.log(`  Post #${String(p.id).padEnd(3)} | ${p.date} ${p.time} | ${p.account.padEnd(8)} | ${p.title}`);
  });
  console.log('─'.repeat(60));
  console.log(`\n📊 Totaal: ${posts.length} posts | Log: posting-log.json\n`);
}

// ─── OAuth routes ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const tokens = loadTokens();
  if (tokens && tokens.access_token) {
    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#f0f9f0">
      <h2>✅ Finbridge LinkedIn Auto-Poster is actief!</h2>
      <p>Alle <strong>${posts.length} posts</strong> zijn gepland en worden automatisch geplaatst.</p>
      <p><a href="/status">Bekijk posting status →</a></p>
      <p><a href="/upcoming">Bekijk aankomende posts →</a></p>
      </body></html>
    `);
  } else {
    const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=openid%20profile%20email%20openid%20profile%20email%20openid%20profile%20email%20w_member_social`;
    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#f3f9ff">
      <h2>🔗 Finbridge LinkedIn Auto-Poster</h2>
      <p>Klik de knop hieronder om in te loggen bij LinkedIn.</p>
      <p>Dit doe je <strong>één keer</strong>. Daarna post de tool automatisch alle 44 posts.</p>
      <br>
      <a href="${authUrl}" style="background:#0077b5;color:white;padding:14px 28px;border-radius:6px;text-decoration:none;font-size:16px;font-weight:bold">
        🔑 Inloggen bij LinkedIn
      </a>
      </body></html>
    `);
  }
});

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.send(`<html><body style="padding:40px"><h2>❌ Inloggen geannuleerd</h2><p><a href="/">Probeer opnieuw</a></p></body></html>`);
  }

  try {
    const tokenRes = await axios.post('https://www.linkedin.com/oauth/v2/accessToken', null, {
      params: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET
      }
    });

    const tokens = {
      access_token: tokenRes.data.access_token,
      refresh_token: tokenRes.data.refresh_token || null,
      expires_at: Date.now() + (tokenRes.data.expires_in * 1000),
      authorized_at: new Date().toISOString()
    };

    saveTokens(tokens);

    // Get profile info
    const profile = await axios.get('https://api.linkedin.com/v2/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });

    const name = `${profile.data.localizedFirstName} ${profile.data.localizedLastName}`;
    console.log(`\n✅ Succesvol ingelogd als: ${name}`);
    console.log('🚀 Scheduler actief — posts worden automatisch geplaatst!\n');

    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#f0f9f0">
      <h2>✅ Gelukt! Je bent ingelogd als <strong>${name}</strong></h2>
      <p>De tool is nu actief en zal automatisch alle <strong>${posts.length} posts</strong> plaatsen op de geplande datum en tijd.</p>
      <p><strong>Je kunt dit venster nu sluiten.</strong> Laat de terminal open staan op de achtergrond.</p>
      <br>
      <p><a href="/upcoming">📅 Bekijk alle geplande posts →</a></p>
      <p><a href="/status">📊 Bekijk posting log →</a></p>
      </body></html>
    `);

  } catch (err) {
    console.error('OAuth fout:', err.response?.data || err.message);
    res.send(`<html><body style="padding:40px"><h2>❌ Inloggen mislukt</h2><p>${err.message}</p><p><a href="/">Probeer opnieuw</a></p></body></html>`);
  }
});

app.get('/status', (req, res) => {
  let log = [];
  if (fs.existsSync(LOG_FILE)) {
    try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
  }
  const rows = log.reverse().map(l =>
    `<tr><td>${l.postId}</td><td>${l.status}</td><td>${l.message}</td><td>${new Date(l.timestamp).toLocaleString('nl-NL')}</td></tr>`
  ).join('');
  res.send(`<html><body style="font-family:sans-serif;padding:20px">
    <h2>📊 Posting Log</h2>
    <p><a href="/">← Terug</a></p>
    <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%">
    <tr style="background:#0077b5;color:white"><th>Post #</th><th>Status</th><th>Bericht</th><th>Tijd</th></tr>
    ${rows || '<tr><td colspan="4">Nog geen posts geplaatst</td></tr>'}
    </table></body></html>`);
});

app.get('/upcoming', (req, res) => {
  const now = new Date();
  let log = [];
  if (fs.existsSync(LOG_FILE)) {
    try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
  }
  const rows = posts.map(p => {
    const dt = new Date(`${p.date}T${p.time}:00`);
    const posted = log.some(l => l.postId === p.id && l.status.includes('GEPLAATST'));
    const status = posted ? '✅ Geplaatst' : dt < now ? '⏳ Gemist' : '⏰ Gepland';
    const bg = posted ? '#f0fff0' : dt < now ? '#fff5f5' : 'white';
    return `<tr style="background:${bg}"><td>${p.id}</td><td>${p.date} ${p.time}</td><td>${p.account}</td><td>${p.title}</td><td>${status}</td></tr>`;
  }).join('');
  res.send(`<html><body style="font-family:sans-serif;padding:20px">
    <h2>📅 Alle Geplande Posts (${posts.length} totaal)</h2>
    <p><a href="/">← Terug</a></p>
    <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%">
    <tr style="background:#0077b5;color:white"><th>#</th><th>Datum & Tijd</th><th>Account</th><th>Titel</th><th>Status</th></tr>
    ${rows}
    </table></body></html>`);
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log('\n' + '═'.repeat(60));
  console.log('  🚀 FINBRIDGE LINKEDIN AUTO-POSTER');
  console.log('═'.repeat(60));

  const tokens = loadTokens();
  if (tokens && tokens.access_token) {
    console.log('✅ Al ingelogd! Scheduler wordt gestart...');
    startScheduler();
  } else {
    console.log('\n📌 ACTIE VEREIST: Open deze link in je browser:\n');
    console.log(`   👉  http://localhost:${PORT}\n`);
    console.log('   Klik op "Inloggen bij LinkedIn" en geef eenmalig toestemming.');
    console.log('   Daarna start de tool automatisch.\n');

    // Try to auto-open browser
    try {
      const open = require('open');
      await open(`http://localhost:${PORT}`);
    } catch {}
  }
});

// Auto-start scheduler when tokens exist at startup
const existingTokens = loadTokens();
if (existingTokens) {
  setTimeout(startScheduler, 2000);
}
