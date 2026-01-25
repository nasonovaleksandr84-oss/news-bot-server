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

async function runDiscovery() {
  addLog("🔍 Глубокий поиск новостей начат...");
  try {
    addLog("📡 Запрос к Gemini 3 Pro (Google Search Grounding)...");
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: "Найди 3 новости про твердотельные аккумуляторы за последние 24 часа. Сфокусируйся на технических прорывах. Формат: JSON список [{id, title, summary, telegramPost, visualPrompt, impactScore, keywords, techSpecs: {energyDensity, chemistryType}}]. Только JSON.",
      config: { tools: [{ googleSearch: {} }] }
    });
    
    addLog("⏳ Ответ получен, начинаю парсинг JSON...");
    const jsonStr = response.text.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
    const newArticles = JSON.parse(jsonStr).map(a => ({
      ...a, 
      id: a.id || Math.random().toString(36).substr(2, 9),
      createdAt: new Date().toISOString(), 
      status: 'draft'
    }));
    
    articles = [...newArticles, ...articles].slice(0, 30);
    addLog(`✅ Успех! Добавлено новых новостей: ${newArticles.length}`);
  } catch (err) { 
    addLog(`❌ Критическая ошибка ИИ: ${err.message}`); 
    if (err.message.includes('Quota')) addLog("⚠️ Превышен лимит API Key.");
  }
}

app.get('/api/status', (req, res) => res.json({ isOnline: true, version: "1.2.2", logs: logs.slice(0, 20), mode: 'production' }));
app.get('/api/articles', (req, res) => res.json(articles));
app.post('/api/trigger', (req, res) => { addLog("🕹️ Ручной запуск из админки..."); runDiscovery(); res.json({ status: "processing" }); });

app.post('/api/publish', async (req, res) => {
  const { articleId, image } = req.body;
  const article = articles.find(a => a.id === articleId);
  if (!article) return res.status(404).json({ error: "Not found" });
  
  addLog(`📢 Публикация в Telegram: ${article.title}`);
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  const method = image ? 'sendPhoto' : 'sendMessage';
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const body = image 
    ? { chat_id: chatId, photo: image, caption: article.telegramPost, parse_mode: 'HTML' }
    : { chat_id: chatId, text: article.telegramPost, parse_mode: 'HTML' };

  try {
    const r = await fetch(url, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body) });
    if (r.ok) {
      article.status = 'published';
      addLog("✅ Опубликовано успешно.");
      return res.json({ success: true });
    }
    const errData = await r.json();
    addLog(`❌ Ошибка TG: ${errData.description}`);
    res.status(500).json({ error: errData.description });
  } catch (e) { addLog("❌ Ошибка сети при отправке в TG"); res.status(500).json({ error: "Network error" }); }
});

cron.schedule('0 * * * *', runDiscovery);
app.listen(process.env.PORT || 10000, () => addLog("🚀 Сервер v1.2.2 запущен и готов к работе"));
