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
    return;
  }
  try {
    const COMPANY_ID = process.env.LINKEDIN_COMPANY_ID;
    const authorURN = `urn:li:organization:${COMPANY_ID}`;
    await publishPost(tokens.access_token, authorURN, post.text);
    logPost(post.id, 'GEPLAATST', post.title);
  } catch (err) {
    logPost(post.id, 'FOUT', err.response?.data?.message || err.message);
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
      let log = [];
      if (fs.existsSync(LOG_FILE)) {
        try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
      }
      const alreadyPosted = log.some(l => l.postId === duePost.id && l.status === 'GEPLAATST');
      if (!alreadyPosted) {
        console.log(`Posten: #${duePost.id} — ${duePost.title}`);
        await postToLinkedIn(duePost);
      }
    }
  });
}

app.get('/', (req, res) => {
  const tokens = loadTokens();
  if (tokens && tokens.access_token) {
    res.send(`<html><body style="font-family:sans-serif;padding:40px;background:#f0f9f0">
      <h2>✅ Finbridge LinkedIn Auto-Poster is actief!</h2>
      <p>Alle <strong>${posts.length} posts</strong> worden automatisch geplaatst.</p>
      <p><a href="/status">Bekijk posting status</a></p>
      </body></html>`);
  } else {
    const authUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=w_member_social`;
    res.send(`<html><body style="font-family:sans-serif;padding:40px;background:#f3f9ff">
      <h2>🔗 Finbridge LinkedIn Auto-Poster</h2>
      <p>Klik hieronder om eenmalig in te loggen bij LinkedIn.</p>
      <a href="${authUrl}" style="background:#0077b5;color:white;padding:14px 28px;border-radius:6px;text-decoration:none;font-size:16px;font-weight:bold">
        🔑 Inloggen bij LinkedIn
      </a></body></html>`);
  }
});

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
      <p>Je kunt dit venster sluiten.</p>
      </body></html>`);
  } catch (err) {
    res.send(`<html><body><h2>❌ Fout: ${err.message}</h2><a href="/">Opnieuw</a></body></html>`);
  }
});

app.get('/status', (req, res) => {
  let log = [];
  if (fs.existsSync(LOG_FILE)) {
    try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
  }
  const rows = log.reverse().map(l =>
    `<tr><td>${l.postId}</td><td>${l.status}</td><td>${l.message}</td><td>${l.timestamp}</td></tr>`
  ).join('');
  res.send(`<html><body style="font-family:sans-serif;padding:20px">
    <h2>📊 Posting Log</h2><a href="/">← Terug</a><br><br>
    <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%">
    <tr style="background:#0077b5;color:white"><th>#</th><th>Status</th><th>Bericht</th><th>Tijd</th></tr>
    ${rows || '<tr><td colspan="4">Nog geen posts</td></tr>'}
    </table></body></html>`);
});

app.listen(PORT, () => {
  console.log(`Server draait op poort ${PORT}`);
  startScheduler();
});
