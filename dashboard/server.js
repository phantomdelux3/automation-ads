import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.DASHBOARD_PORT || 4000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/history', (req, res) => {
  const historyFile = process.env.HISTORY_FILE || path.join(__dirname, '..', 'history.json');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const runs = JSON.parse(fs.readFileSync(historyFile, 'utf8')); // throws on a half-written file
    if (!Array.isArray(runs)) return res.json([]);
    // Only the run being viewed needs its per-session records; the others are
    // sent as summaries so the 3s poll stays small. Default: the newest run.
    const wanted = req.query.run || (runs[0] && (runs[0].id || runs[0].timestamp));
    res.json(runs.map((r) => {
      if (!r || (r.id || r.timestamp) === wanted || !Array.isArray(r.sessions)) return r;
      const { sessions, ...rest } = r;
      return { ...rest, sessionCount: sessions.length };
    }));
  } catch (e) {
    if (e.code === 'ENOENT') return res.json([]);
    res.status(503).json({ error: 'history temporarily unavailable' });
  }
});

app.listen(port, () => {
  console.log(`Dashboard running at http://localhost:${port}`);
});
