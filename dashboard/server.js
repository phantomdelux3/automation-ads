import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 4000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/history', (req, res) => {
  const historyFile = path.join(__dirname, '..', 'history.json');
  if (fs.existsSync(historyFile)) {
    const data = fs.readFileSync(historyFile, 'utf8');
    res.setHeader('Content-Type', 'application/json');
    res.send(data);
  } else {
    res.json([]);
  }
});

app.listen(port, () => {
  console.log(`Dashboard running at http://localhost:${port}`);
});
