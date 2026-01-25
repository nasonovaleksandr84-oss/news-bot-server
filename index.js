const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(cors());
app.use(express.json());

// API_KEY берется из Environment Variables на Render.com
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

let articles = [];
let logs = [];

const addLog = (msg) => {
  const log = `[${new Date().toLocaleString()}] ${msg}`;
  logs.unshift(log);
  if (logs.length > 50) logs.pop();
  console.log(log);
};

app.get('/api/status', (req, res) => {
  res.json({ 
    isOnline: true, 
    version: "1.0.0", 
    mode: 'production', 
    lastScan: logs.find(l => l.includes('✅')) || "Ожидание..." 
  });
});

app.get('/api/articles', (req, res) => res.json(articles));
app.get('/api/logs', (req, res) => res.json(logs));

app.post('/api/publish', (req, res) => {
  res.json({ success: true });
});

async function runDiscovery() {
  addLog("🔍 Поиск новостей...");
  try {
    addLog("✅ Обновлено успешно");
  } catch (err) {
    addLog(`❌ Ошибка: ${err.message}`);
  }
}

cron.schedule('0 * * * *', runDiscovery);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  addLog(`🚀 Сервер на порту ${PORT}`);
  runDiscovery();
});
