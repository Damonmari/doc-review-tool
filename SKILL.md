# doc-ingest-tool

## Status: Active — v1.0 (Session-Only)

## Description
Standalone document intelligence tool. Upload any document (PDF, DOCX, TXT, XLSX, CSV, images), get automatic Claude analysis with extracted dates and action items, then have a voice or chat conversation about the content. Session resets on browser close or "Start Over".

## Architecture
- **Frontend:** Single HTML file (`public/index.html`) — dark UI, drag-and-drop upload, chat bubbles, voice controls
- **Backend:** Node.js/Express (`server.js`) — in-memory sessions, text extraction, Claude API, 11 Labs TTS
- **AI:** Claude claude-sonnet-4-20250514 via Anthropic API
- **Voice:** 11 Labs TTS (Rachel voice) + browser Web Speech API for STT
- **Persistence:** None — all state is in-memory, cleared on server restart

## How to Run
```bash
cd ~/Documents/HQ/02-PRODUCTS/doc-ingest-tool
npm install         # first time only
node server.js
# → http://localhost:3333
```

## API Endpoints
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/upload` | POST | Upload file, extract text, run Claude analysis |
| `/api/chat` | POST | Chat against uploaded docs in session |
| `/api/tts` | POST | 11 Labs TTS — returns audio/mpeg |
| `/api/reset` | POST | Clear session from memory |
| `/api/health` | GET | Health check |

## Supported File Types
PDF, DOCX, TXT, MD, CSV, LOG, XLSX, XLS, JPG, PNG, GIF, WEBP

## Key Files
- `server.js` — Express server, all API logic, text extraction, Claude + 11 Labs calls
- `public/index.html` — Complete frontend (upload, analysis display, chat, voice)
- `.env` — API keys (Anthropic + ElevenLabs)
- `uploads/` — Temp dir for multer; files deleted after extraction

## Environment Variables (.env)
```
ANTHROPIC_API_KEY=...
ELEVENLABS_API_KEY=...
PORT=3333
```

## What It Does
1. **Upload** — Drag/drop any file. Multiple files supported per session.
2. **Auto-analyze** — Claude reads the document and returns: summary, key points, important dates, action items with priorities
3. **Choose mode** — Chat (text Q&A) or Voice (speak questions, hear answers via 11 Labs)
4. **Converse** — Full conversational memory within the session across all uploaded docs

## Known Limitations (v1)
- No persistence — session ends when server restarts or "Start Over" is clicked
- Video files not supported (no transcription in v1)
- Voice requires Chrome or Edge (Web Speech API)
- Large files truncated at ~16,000 characters for analysis

## Roadmap (v2)
- [ ] Persistent sessions with SQLite
- [ ] Video/audio transcription (Whisper API)
- [ ] Export dates to calendar / tasks to a task manager
- [ ] Multi-user sessions
- [ ] Voice selection (multiple 11 Labs voices)

## History
- 2026-04-16: v1.0 built — full pipeline working (upload → extract → Claude analysis → chat + voice)
