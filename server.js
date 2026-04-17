require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

// ─── Security headers ────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false // disabled so inline scripts in index.html work
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Rate limiting ────────────────────────────────────────────────────────────
// General API limiter — 120 requests / 15 min per IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down and try again in a few minutes.' }
});

// Strict limiter for expensive AI endpoints — 30 calls / 15 min per IP
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI request limit reached — please wait a few minutes before trying again.' }
});

app.use('/api/', apiLimiter);
app.use('/api/analyze-one', aiLimiter);
app.use('/api/start-analysis', aiLimiter);
app.use('/api/analyze-all', aiLimiter);
app.use('/api/chat', aiLimiter);
app.use('/api/tts', aiLimiter);

// ─── Optional basic auth (set ACCESS_PASSWORD in .env to enable) ─────────────
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD;
if (ACCESS_PASSWORD) {
  app.use((req, res, next) => {
    // Let the health check through unauthenticated
    if (req.path === '/api/health') return next();
    const auth = req.headers['authorization'] || '';
    const b64 = auth.replace(/^Basic\s+/, '');
    let password = '';
    let username = '';
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      username = decoded.split(':')[0] || '';
      password = decoded.split(':')[1] || '';
    } catch (_) {}
    if (username === 'edgar' && password === ACCESS_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="DocReview"');
    res.status(401).send('Authentication required');
  });
}

// ─── In-memory session store with TTL cleanup ─────────────────────────────────
const sessions = {};
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// Sweep expired sessions every 30 minutes
setInterval(() => {
  const now = Date.now();
  let swept = 0;
  for (const [id, sess] of Object.entries(sessions)) {
    if (now - sess.lastActiveAt > SESSION_TTL_MS) {
      delete sessions[id];
      swept++;
    }
  }
  if (swept) console.log(`[session-sweep] Removed ${swept} expired session(s)`);
}, 30 * 60 * 1000).unref();

function getOrCreateSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = { docs: [], history: [], lastActiveAt: Date.now() };
  } else {
    sessions[sessionId].lastActiveAt = Date.now();
  }
  return sessions[sessionId];
}

// ─── Multer upload config ─────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: 100 * 1024 * 1024 }
});

// ─── Text Extraction ──────────────────────────────────────────────────────────

async function extractText(filePath, mimeType, fileName) {
  // Sanitize fileName — strip any path components, keep only the basename
  const safeName = path.basename(fileName);
  const ext = path.extname(safeName).toLowerCase();
  try {
    if (ext === '.pdf') {
      const pdfParse = require('pdf-parse');
      const buf = fs.readFileSync(filePath);
      const data = await pdfParse(buf);
      return { text: data.text || '', method: 'pdf', pages: data.numpages };
    }
    if (ext === '.docx') {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: filePath });
      return { text: result.value || '', method: 'docx' };
    }
    if (['.txt', '.md', '.csv', '.log'].includes(ext)) {
      return { text: fs.readFileSync(filePath, 'utf8'), method: 'text' };
    }
    if (['.xlsx', '.xls'].includes(ext)) {
      const XLSX = require('xlsx');
      const wb = XLSX.readFile(filePath);
      let text = '';
      for (const name of wb.SheetNames) {
        text += `\n[Sheet: ${name}]\n` + XLSX.utils.sheet_to_csv(wb.Sheets[name]) + '\n';
      }
      return { text: text.trim(), method: 'xlsx' };
    }
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
      const buf = fs.readFileSync(filePath);
      return { text: '', imageBase64: buf.toString('base64'), imageMediaType: mimeType || 'image/jpeg', method: 'image' };
    }
    if (['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.wmv', '.flv', '.mpg', '.mpeg', '.3gp'].includes(ext)) {
      const stats = fs.statSync(filePath);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
      return {
        text: `[VIDEO FILE]\nFilename: ${safeName}\nFormat: ${ext.slice(1).toUpperCase()}\nSize: ${sizeMB} MB\n\nThis is a video file. Analyze based on the filename and any context available. Note that no transcript or visual frames are available — provide whatever insight you can from the filename and metadata, and note what additional information would be needed for a deeper analysis.`,
        method: 'video'
      };
    }
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return { text: raw, method: 'raw-text' };
    } catch (_) {
      return { text: '', method: 'unsupported' };
    }
  } catch (e) {
    console.error('[extract]', e.message);
    return { text: '', method: 'error', error: e.message };
  }
}

function cleanup(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
}

// ─── Claude Prompts ───────────────────────────────────────────────────────────

const SYSTEM_ANALYZE = `You are an expert document analyst — sharp, thorough, and direct. Analyze the provided document completely.

Return ONLY a raw JSON object (no markdown fences) with this exact structure:
{
  "summary": "2-3 sentence overview of what this document is and its key purpose",
  "keyPoints": ["Up to 6 most important points from the document"],
  "dates": [
    {
      "date": "YYYY-MM-DD or descriptive string like 'Q3 2025' or 'Upon completion'",
      "label": "Brief label (e.g. 'Project Deadline', 'Contract Expiry')",
      "description": "What is happening or due on this date"
    }
  ],
  "tasks": [
    {
      "title": "Concise action item title",
      "priority": "High|Medium|Low",
      "description": "What needs to be done and why",
      "dueDate": "YYYY-MM-DD or null"
    }
  ],
  "feedback": "A candid, collegial assessment of this document — its quality, clarity, completeness, potential gaps, risks, or red flags. Write this as one colleague talking to another: direct, honest, and useful. 2-4 sentences.",
  "areasOfInterest": [
    {
      "title": "Area or topic title",
      "description": "Why this section or topic stands out and what Edgar should pay attention to"
    }
  ],
  "thingsToNote": [
    "A specific observation, caveat, nuance, or concern Edgar should keep in mind"
  ],
  "highlights": [
    {
      "title": "Short highlight label",
      "content": "The specific text, clause, figure, or finding being highlighted",
      "significance": "Why this matters — implications, risks, opportunities"
    }
  ],
  "suggestedPrompts": [
    "A specific, insightful question Edgar should ask about this document"
  ]
}

Rules:
- Extract EVERY date, deadline, or time reference
- Extract ALL action items, obligations, open items, or follow-ups
- areasOfInterest: 2-5 items — focus on what's strategically or operationally significant
- thingsToNote: 3-6 specific observations — nuances, assumptions, ambiguities, dependencies
- highlights: 2-5 items — the most important excerpts or findings worth calling out explicitly
- suggestedPrompts: 5-7 questions that would yield the most useful follow-up analysis
- Be thorough — do not summarize or skip items
- Return ONLY the JSON object`;

const SYSTEM_ANALYZE_ALL = (fileNames) => `You are an expert document analyst — sharp, thorough, and direct. You are analyzing a set of ${fileNames.length} documents together as a collection.

Documents in this set: ${fileNames.join(', ')}

Return ONLY a raw JSON object (no markdown fences) with this exact structure:
{
  "summary": "3-4 sentence overview of this document set — what they are collectively, how they relate, and the big picture",
  "keyPoints": ["Up to 8 most important cross-document insights or themes"],
  "dates": [
    {
      "date": "YYYY-MM-DD or descriptive string",
      "label": "Brief label",
      "description": "What is happening and which document it comes from"
    }
  ],
  "tasks": [
    {
      "title": "Concise action item title",
      "priority": "High|Medium|Low",
      "description": "What needs to be done, why, and which document it comes from",
      "dueDate": "YYYY-MM-DD or null"
    }
  ],
  "feedback": "A candid cross-document assessment: how well do these documents work together? Are they consistent? Are there conflicts, overlaps, or gaps between them? Write as a colleague giving a real opinion. 3-5 sentences.",
  "areasOfInterest": [
    {
      "title": "Area or theme title",
      "description": "Why this cross-document topic stands out and what Edgar should pay attention to"
    }
  ],
  "thingsToNote": [
    "A cross-document observation, inconsistency, dependency, or concern Edgar should be aware of"
  ],
  "highlights": [
    {
      "title": "Short highlight label",
      "content": "The specific finding, conflict, or cross-reference being highlighted",
      "significance": "Why this matters across the document set"
    }
  ],
  "suggestedPrompts": [
    "A specific question that would yield the most useful cross-document analysis"
  ]
}

Rules:
- Synthesize across ALL documents — find themes, conflicts, dependencies, and gaps between them
- Every date and task should reference which document it came from
- highlights and areasOfInterest should focus on cross-document insights when possible
- suggestedPrompts: 5-7 questions, favor ones that span multiple documents
- Be thorough and direct
- Return ONLY the JSON object`;

const SYSTEM_CHAT = (docs) => `You are a sharp, direct document analyst. Your colleague Edgar has uploaded documents for you to review together. You know this material as well as he does — you're equals working through it together.

Address him as Edgar naturally, the way a colleague would — not constantly, but when it fits. Be direct, conversational, and occasionally candid. If something in the documents is worth flagging, say so. If a question has a straightforward answer, give it straight.

${docs.length > 0
  ? `DOCUMENTS IN THIS SESSION:\n${docs.map(d => `\n=== ${d.fileName} ===\n${(d.text || '[image file]').slice(0, 8000)}`).join('\n').slice(0, 24000)}`
  : 'No documents uploaded yet.'}

Rules:
- Base answers strictly on the document content above
- Reference which document your answer comes from when relevant
- If the answer isn't in the documents, say so clearly — don't guess
- Match Edgar's conversational register — if he's casual, be casual; if he's asking something detailed, go deep`;

// ─── Claude API ───────────────────────────────────────────────────────────────

async function callClaude({ model = 'claude-sonnet-4-20250514', systemPrompt, messages, maxTokens = 4096, timeoutMs = 90000 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, messages }),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!res.ok) {
    const err = await res.text();
    // Don't leak raw API response to client — log it server-side, throw a clean message
    console.error('[claude-api]', res.status, err.slice(0, 200));
    if (res.status === 429) throw new Error('Claude API rate limit reached — please try again in a moment.');
    if (res.status >= 500) throw new Error('Claude API is temporarily unavailable — please try again.');
    throw new Error(`Analysis service error (${res.status})`);
  }

  const data = await res.json();
  return data?.content?.[0]?.text || '';
}

function parseJSON(raw) {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    return JSON.parse(cleaned);
  } catch (_) {
    return null;
  }
}

async function analyzeDoc(fileName, extracted) {
  let messages;

  if (extracted.imageBase64) {
    messages = [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: extracted.imageMediaType, data: extracted.imageBase64 } },
        { type: 'text', text: `Analyze this image file: ${fileName}. Extract all important information, dates, tasks, and provide feedback.` }
      ]
    }];
  } else {
    const truncated = (extracted.text || '').slice(0, 18000);
    if (!truncated.trim()) {
      return { summary: 'Could not extract text from this file type.', keyPoints: [], dates: [], tasks: [], feedback: '', areasOfInterest: [], thingsToNote: [], highlights: [], suggestedPrompts: [] };
    }
    messages = [{ role: 'user', content: `Analyze this document (${fileName}):\n\n${truncated}` }];
  }

  const raw = await callClaude({
    model: 'claude-opus-4-20250514',
    systemPrompt: SYSTEM_ANALYZE,
    messages,
    maxTokens: 8192,
    timeoutMs: 120000
  });
  const parsed = parseJSON(raw);
  if (parsed) return parsed;
  return { summary: raw, keyPoints: [], dates: [], tasks: [], feedback: '', areasOfInterest: [], thingsToNote: [], highlights: [], suggestedPrompts: [] };
}

async function analyzeAllDocs(docs) {
  if (!docs.length) throw new Error('No documents to analyze');

  const fileNames = docs.map(d => d.fileName);
  const combined = docs.map(d =>
    `\n=== ${d.fileName} ===\n${(d.text || '[image file]').slice(0, 10000)}`
  ).join('\n').slice(0, 30000);

  const messages = [{ role: 'user', content: `Analyze these ${docs.length} documents together as a collection:\n${combined}` }];

  const raw = await callClaude({
    model: 'claude-opus-4-20250514',
    systemPrompt: SYSTEM_ANALYZE_ALL(fileNames),
    messages,
    maxTokens: 8192,
    timeoutMs: 120000
  });
  const parsed = parseJSON(raw);
  if (parsed) return parsed;
  return { summary: raw, keyPoints: [], dates: [], tasks: [], feedback: '', areasOfInterest: [], thingsToNote: [], highlights: [], suggestedPrompts: [] };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

const EMPTY_ANALYSIS = { summary: '', keyPoints: [], dates: [], tasks: [], feedback: '', areasOfInterest: [], thingsToNote: [], highlights: [], suggestedPrompts: [] };

// Queue file (extract only — no analysis yet)
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const sessionId = req.body.sessionId || `s_${crypto.randomUUID()}`;
  const fileName = path.basename(req.file.originalname); // sanitize path chars
  const mimeType = req.file.mimetype;

  let extracted;
  try {
    extracted = await extractText(req.file.path, mimeType, fileName);
  } finally {
    cleanup(req.file.path);
  }

  const session = getOrCreateSession(sessionId);
  session.docs.push({
    fileName,
    text: extracted.text || '',
    imageBase64: extracted.imageBase64 || null,
    imageMediaType: extracted.imageMediaType || null,
    method: extracted.method,
    analyzed: false,
    analysis: null,
    uploadedAt: new Date().toISOString()
  });

  res.json({ ok: true, sessionId, fileName, extractMethod: extracted.method, queued: true });
});

// Analyze a single doc by fileName — used for per-file progress tracking
app.post('/api/analyze-one', async (req, res) => {
  const { sessionId, fileName } = req.body;
  if (!sessionId || !fileName) return res.status(400).json({ error: 'sessionId and fileName required' });

  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: 'Session not found — it may have expired. Please refresh and re-upload.' });

  const doc = session.docs.find(d => d.fileName === fileName);
  if (!doc) return res.status(404).json({ error: 'Document not found in session' });
  if (doc.analyzed) return res.json({ ok: true, fileName, analysis: doc.analysis });

  session.lastActiveAt = Date.now();

  try {
    const analysis = await analyzeDoc(doc.fileName, doc);
    doc.analyzed = true;
    doc.analysis = analysis;
    res.json({ ok: true, fileName, analysis });
  } catch (e) {
    console.error('[analyze-one]', fileName, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Analyze all queued docs — legacy batch endpoint (kept for compatibility)
app.post('/api/start-analysis', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const session = sessions[sessionId];
  if (!session || !session.docs.length) return res.status(404).json({ error: 'No documents queued' });

  const queued = session.docs.filter(d => !d.analyzed);
  if (!queued.length) return res.json({ ok: true, results: [], message: 'All documents already analyzed' });

  session.lastActiveAt = Date.now();

  const results = [];
  for (const doc of queued) {
    let analysis;
    try {
      analysis = await analyzeDoc(doc.fileName, doc);
      doc.analyzed = true;
      doc.analysis = analysis;
    } catch (e) {
      console.error('[start-analysis]', doc.fileName, e.message);
      analysis = { ...EMPTY_ANALYSIS, summary: 'Analysis failed: ' + e.message };
      doc.analyzed = true;
      doc.analysis = analysis;
    }
    results.push({ fileName: doc.fileName, analysis });
  }

  res.json({ ok: true, sessionId, results });
});

// Analyze all docs in session together (cross-document synthesis)
app.post('/api/analyze-all', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const session = sessions[sessionId];
  if (!session || !session.docs.length) return res.status(404).json({ error: 'No documents in session' });

  const analyzed = session.docs.filter(d => d.analyzed);
  if (analyzed.length < 2) return res.status(400).json({ error: 'Need at least 2 analyzed documents for combined analysis' });

  session.lastActiveAt = Date.now();

  try {
    const analysis = await analyzeAllDocs(analyzed);
    res.json({ ok: true, analysis, docCount: analyzed.length });
  } catch (e) {
    console.error('[analyze-all]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Chat
app.post('/api/chat', async (req, res) => {
  const { sessionId, message } = req.body;
  if (!sessionId || !message) return res.status(400).json({ error: 'sessionId and message required' });

  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: 'Session not found — it may have expired. Please refresh and re-upload.' });

  session.lastActiveAt = Date.now();
  session.history.push({ role: 'user', content: message });
  const recentHistory = session.history.slice(-20);

  try {
    const answer = await callClaude({
      model: 'claude-sonnet-4-20250514',
      systemPrompt: SYSTEM_CHAT(session.docs),
      messages: recentHistory,
      maxTokens: 2048
    });
    session.history.push({ role: 'assistant', content: answer });
    res.json({ answer });
  } catch (e) {
    session.history.pop();
    res.status(500).json({ error: e.message });
  }
});

// 11 Labs TTS
app.post('/api/tts', async (req, res) => {
  const { text, voiceId = '21m00Tcm4TlvDq8ikWAM' } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });

  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return res.status(500).json({ error: 'TTS service not configured' });

  try {
    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': key },
      body: JSON.stringify({
        text: text.slice(0, 5000),
        model_id: 'eleven_turbo_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.0, use_speaker_boost: true }
      }),
      signal: AbortSignal.timeout(20000)
    });

    if (!ttsRes.ok) {
      const err = await ttsRes.text();
      console.error('[tts]', ttsRes.status, err.slice(0, 200));
      return res.status(500).json({ error: 'TTS service error — please try again.' });
    }

    const buf = await ttsRes.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ error: 'TTS request failed — please try again.' });
  }
});

// Reset session
app.post('/api/reset', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId && sessions[sessionId]) delete sessions[sessionId];
  res.json({ ok: true });
});

app.get('/api/health', (_, res) => res.json({ ok: true, sessions: Object.keys(sessions).length, uptime: process.uptime() }));

// ─── Graceful shutdown ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3333;
const server = app.listen(PORT, () => {
  console.log(`\nDoc Ingest Tool → http://localhost:${PORT}`);
  if (ACCESS_PASSWORD) console.log('  Access password: ENABLED');
  console.log('');
});

function shutdown(signal) {
  console.log(`\n[${signal}] Graceful shutdown…`);
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000); // force exit after 10s
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
