const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = require('node-fetch');
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

let articles = [];
let logs = [];

const addLog = (msg) => {
  const log = `[${new Date().toLocaleString('ru-RU')}] ${msg}`;
  logs.unshift(log);
  if (logs.length > 50) logs.pop();
  console.log(log);
};

async function sendToTelegram(text, image = null) {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;

  const method = image ? 'sendPhoto' : 'sendMessage';
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const body = image 
    ? { chat_id: chatId, photo: image, caption: text, parse_mode: 'HTML' }
    : { chat_id: chatId, text: text, parse_mode: 'HTML' };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return res.ok;
  } catch (e) { return false; }
}

async function runDiscovery() {
  addLog("🔍 Глубокий поиск новостей...");
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: "Найди 3 новости про твердотельные аккумуляторы за 24ч. Формат: JSON список [{id, title, summary, telegramPost, visualPrompt, impactScore, keywords}]. Только JSON.",
      config: { tools: [{ googleSearch: {} }] }
    });
    const jsonStr = response.text.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
    const newArticles = JSON.parse(jsonStr).map(a => ({...a, createdAt: new Date().toISOString(), status: 'draft'}));
    articles = [...newArticles, ...articles].slice(0, 20);
    addLog(`✅ Обновлено: +${newArticles.length} новостей`);
  } catch (err) { addLog(`❌ Ошибка: ${err.message}`); }
}

app.get('/api/status', (req, res) => res.json({ isOnline: true, version: "1.2.1", logs: logs.slice(0, 10) }));
app.get('/api/articles', (req, res) => res.json(articles));
app.post('/api/trigger', (req, res) => { addLog("🕹️ Ручной запуск..."); runDiscovery(); res.json({ status: "ok" }); });
app.post('/api/publish', async (req, res) => {
  const { articleId, image } = req.body;
  const article = articles.find(a => a.id === articleId);
  if (article && await sendToTelegram(article.telegramPost, image)) {
    article.status = 'published';
    addLog(`📢 Опубликовано: ${article.title}`);
    return res.json({ success: true });
  }
  res.status(500).json({ error: "Fail" });
});

cron.schedule('0 * * * *', runDiscovery);
app.listen(process.env.PORT || 10000, () => addLog("🚀 Сервер v1.2.1 в сети"));
