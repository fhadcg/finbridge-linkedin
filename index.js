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
const TOKEN_FILE = path.join('/tmp', '.tokens.json');
const LOG_FILE = path.join('/tmp', 'posting-log.json');

function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}

function loadTokens() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
}

function logPost(postId, status, message) {
  let log = [];
  if (fs.existsSync(LOG_FILE)) {
    try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
  }
  log.push({ postId, status, message, timestamp: new Date().toISOString() });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  console.log(`[${new Date().toISOString()}] Post #${postId}: ${status} — ${message}`);
}

function getPostedIds() {
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    const log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    return log.filter(l => l.status === 'GEPLAATST').map(l => l.postId);
  } catch { return []; }
}

function getNextPost() {
  const postedIds = getPostedIds();
  return posts.find(p => !postedIds.includes(p.id));
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
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
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

async function postToLinkedIn(post) {
  const tokens = loadTokens();
  if (!tokens || !tokens.access_token) {
    logPost(post.id, 'SKIP', 'Geen tokens. Log in via de webpagina.');
    return false;
  }
  try {
    const COMPANY_ID = process.env.LINKEDIN_COMPANY_ID;
    const authorURN = `urn:li:organization:${COMPANY_ID}`;
    await publishPost(tokens.access_token, authorURN, post.text);
    logPost(post.id, 'GEPLAATST', post.title);
    return true;
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    logPost(post.id, 'FOUT', errMsg);
    return false;
  }
}

function startScheduler() {
  console.log('Scheduler gestart...');
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    const todayDate = now.toISOString().split('T')[0];
    const currentHHMM = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const duePost = posts.find(p => p.date === todayDate && p.time === currentHHMM);
    if (duePost) {
      const postedIds = getPostedIds();
      if (!postedIds.includes(duePost.id)) {
        console.log(`Posten: #${duePost.id} — ${duePost.title}`);
        await postToLinkedIn(duePost);
      }
    }
  });
}

// Hoofdpagina
app.get('/', (req, res) => {
  const tokens = loadTokens();
  const nextPost = getNextPost();
  const postedIds = getPostedIds();

  if (tokens && tokens.access_token) {
    res.send(`
      <html><head><meta charset="utf-8">
      <style>
        body { font-family: sans-serif; padding: 40px; background: #f0f9f0; max-width: 700px; margin: 0 auto; }
        h2 { color: #1a1a1a; }
        .status { background: #d4edda; border: 1px solid #c3e6cb; padding: 16px; border-radius: 8px; margin-bottom: 24px; }
        .post-preview { background: white; border: 1px solid #ddd; padding: 20px; border-radius: 8px; margin-bottom: 24px; }
        .post-preview h3 { margin-top: 0; color: #0077b5; }
        .btn { display: inline-block; padding: 14px 28px; border-radius: 6px; text-decoration: none; font-size: 16px; font-weight: bold; border: none; cursor: pointer; }
        .btn-blue { background: #0077b5; color: white; }
        .btn-green { background: #28a745; color: white; font-size: 18px; padding: 16px 32px; }
        .btn-gray { background: #6c757d; color: white; }
        .links { margin-top: 24px; }
        .links a { margin-right: 16px; color: #0077b5; }
      </style>
      </head><body>
      <h2>🚀 Finbridge LinkedIn Auto-Poster</h2>
      <div class="status">
        ✅ <strong>Actief en verbonden met LinkedIn</strong><br>
        📊 ${postedIds.length} van ${posts.length} posts geplaatst
      </div>

      ${nextPost ? `
      <div class="post-preview">
        <h3>Volgende post: #${nextPost.id} — ${nextPost.title}</h3>
        <p><strong>Ingepland:</strong> ${nextPost.date} om ${nextPost.time}</p>
        <p style="color:#555; font-size:14px;">${nextPost.text.substring(0, 200)}...</p>
      </div>
      <form method="POST" action="/post-now">
        <button type="submit" class="btn btn-green">🚀 Plaats #${nextPost.id} NU op LinkedIn</button>
      </form>
      ` : '<p>✅ Alle 44 posts zijn geplaatst!</p>'}

      <div class="links">
        <a href="/status">📋 Bekijk posting log</a>
        <a href="/upcoming">📅 Alle geplande posts</a>
      </div>
      </body></html>
    `);
  } else {
    const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=w_member_social`;
    res.send(`
      <html><head><meta charset="utf-8">
      <style>body { font-family: sans-serif; padding: 40px; background: #f3f9ff; max-width: 600px; margin: 0 auto; }</style>
      </head><body>
      <h2>🔗 Finbridge LinkedIn Auto-Poster</h2>
      <p>Klik hieronder om eenmalig in te loggen bij LinkedIn.</p>
      <a href="${authUrl}" style="background:#0077b5;color:white;padding:14px 28px;border-radius:6px;text-decoration:none;font-size:16px;font-weight:bold;display:inline-block;">
        🔑 Inloggen bij LinkedIn
      </a>
      </body></html>
    `);
  }
});

// Post Nu endpoint
app.post('/post-now', async (req, res) => {
  const nextPost = getNextPost();
  if (!nextPost) {
    return res.send(`<html><body style="font-family:sans-serif;padding:40px;">
      <h2>✅ Alle posts zijn al geplaatst!</h2>
      <a href="/">← Terug</a>
    </body></html>`);
  }

  const success = await postToLinkedIn(nextPost);

  res.send(`
    <html><head><meta charset="utf-8">
    <style>body { font-family: sans-serif; padding: 40px; max-width: 600px; margin: 0 auto; }</style>
    </head><body>
    <h2>${success ? '✅ Post geplaatst!' : '❌ Post mislukt'}</h2>
    <p><strong>#${nextPost.id} — ${nextPost.title}</strong></p>
    ${success
      ? '<p style="color:green">De post staat nu live op de Finbridge LinkedIn pagina! 🎉</p>'
      : '<p style="color:red">Er ging iets mis. Bekijk de log voor details.</p>'
    }
    <br>
    <a href="/" style="background:#0077b5;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">← Terug naar dashboard</a>
    <a href="/status" style="background:#6c757d;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin-left:12px;">📋 Bekijk log</a>
    </body></html>
  `);
});

// Callback
app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<html><body><h2>❌ Geannuleerd</h2><a href="/">Opnieuw</a></body></html>`);
  try {
    const tokenRes = await axios.post('https://www.linkedin.com/oauth/v2/accessToken', null, {
      params: { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, client_secret: CLIENT_SECRET }
    });
    saveTokens({
      access_token: tokenRes.data.access_token,
      refresh_token: tokenRes.data.refresh_token || null,
      expires_at: Date.now() + (tokenRes.data.expires_in * 1000)
    });
    console.log('✅ Ingelogd!');
    res.send(`<html><body style="font-family:sans-serif;padding:40px;background:#f0f9f0">
      <h2>✅ Gelukt! LinkedIn gekoppeld.</h2>
      <p>De tool post nu automatisch alle ${posts.length} posts.</p>
      <a href="/">← Naar dashboard</a>
      </body></html>`);
  } catch (err) {
    res.send(`<html><body><h2>❌ Fout: ${err.message}</h2><a href="/">Opnieuw</a></body></html>`);
  }
});

// Status log
app.get('/status', (req, res) => {
  let log = [];
  if (fs.existsSync(LOG_FILE)) {
    try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
  }
  const rows = [...log].reverse().map(l =>
    `<tr><td>${l.postId}</td><td style="color:${l.status==='GEPLAATST'?'green':l.status==='FOUT'?'red':'orange'}">${l.status}</td><td>${l.message}</td><td>${l.timestamp}</td></tr>`
  ).join('');
  res.send(`<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;padding:20px">
    <h2>📊 Posting Log</h2><a href="/">← Terug</a><br><br>
    <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%">
    <tr style="background:#0077b5;color:white"><th>#</th><th>Status</th><th>Bericht</th><th>Tijd</th></tr>
    ${rows || '<tr><td colspan="4">Nog geen posts</td></tr>'}
    </table></body></html>`);
});

// Upcoming posts
app.get('/upcoming', (req, res) => {
  const postedIds = getPostedIds();
  const upcoming = posts.filter(p => !postedIds.includes(p.id));
  const rows = upcoming.map(p =>
    `<tr><td>${p.id}</td><td>${p.date}</td><td>${p.time}</td><td>${p.title}</td></tr>`
  ).join('');
  res.send(`<html><head><meta charset="utf-8"></head><body style="font-family:sans-serif;padding:20px">
    <h2>📅 Geplande Posts (${upcoming.length})</h2><a href="/">← Terug</a><br><br>
    <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%">
    <tr style="background:#0077b5;color:white"><th>#</th><th>Datum</th><th>Tijd</th><th>Titel</th></tr>
    ${rows}
    </table></body></html>`);
});

app.listen(PORT, () => {
  console.log(`Server draait op poort ${PORT}`);
  startScheduler();
});
