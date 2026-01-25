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
  const log = `[${new Date().toLocaleTimeString('ru-RU')}] ${msg}`;
  logs.unshift(log);
  if (logs.length > 100) logs.pop();
  console.log(log);
};

function extractJson(text) {
  try {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start !== -1 && end !== -1) return text.substring(start, end + 1);
    return null;
  } catch (e) { return null; }
}

async function runDiscovery() {
  addLog("🚀 Попытка запуска Gemini 3 PRO Discovery...");
  
  const performRequest = async (model) => {
    return await ai.models.generateContent({
      model: model,
      contents: "Найди 3 свежие и важные новости про технологии аккумуляторов. Составь экспертный обзор на русском языке. Верни ТОЛЬКО JSON массив объектов. КАЖДЫЙ ОБЪЕКТ ДОЛЖЕН СОДЕРЖАТЬ: {id, title, summary, telegramPost, visualPrompt, impactScore, techSpecs: {energyDensity, chemistry}, sources: [{title, url}]}. ОБЯЗАТЕЛЬНО заполни массив sources ссылками на найденные статьи.",
      config: { tools: [{ googleSearch: {} }] }
    });
  };

  try {
    let result;
    try {
      result = await performRequest('gemini-3-pro-preview');
    } catch (proErr) {
      if (proErr.message.includes('429')) {
        addLog("⚠️ Лимит Pro исчерпан (биллинг еще не обновился). Использую Flash...");
        result = await performRequest('gemini-3-flash-preview');
      } else {
        throw proErr;
      }
    }
    
    const responseText = result.text || "";
    const jsonStr = extractJson(responseText);

    if (!jsonStr) {
        addLog("❌ ОШИБКА: Движок не смог сформировать валидный JSON.");
        return;
    }

    const rawItems = JSON.parse(jsonStr);
    const newArticles = rawItems.map(item => ({
      ...item,
      id: item.id || `art_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      sources: Array.isArray(item.sources) ? item.sources : [],
      createdAt: new Date().toISOString(),
      status: 'draft'
    }));

    articles = [...newArticles, ...articles].slice(0, 50);
    addLog(`✅ УСПЕХ: Синхронизировано ${newArticles.length} новых постов.`);

  } catch (err) {
    addLog(`❌ ОШИБКА ДВИЖКА: ${err.message}`);
  }
}

app.get('/api/status', (req, res) => res.json({ isOnline: true, version: "1.3.2-stable", logs: logs }));
app.get('/api/articles', (req, res) => res.json(articles));
app.post('/api/trigger', (req, res) => { runDiscovery(); res.json({ status: "processing" }); });

app.post('/api/publish', async (req, res) => {
  const { articleId, image } = req.body;
  const article = articles.find(a => a.id === articleId);
  if (!article) return res.status(404).json({ error: "Article not found" });
  
  try {
    const method = image ? 'sendPhoto' : 'sendMessage';
    const payload = image 
      ? { chat_id: process.env.TELEGRAM_CHAT_ID, photo: image, caption: article.telegramPost, parse_mode: 'HTML' }
      : { chat_id: process.env.TELEGRAM_CHAT_ID, text: article.telegramPost, parse_mode: 'HTML' };

    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (r.ok) {
        article.status = 'published';
        addLog("📢 Пост успешно отправлен в Telegram!");
        res.json({ success: true });
    } else {
        const data = await r.json();
        addLog(`❌ Ошибка Telegram API: ${data.description}`);
        res.status(500).json(data);
    }
  } catch (e) { 
    addLog(`❌ Ошибка публикации: ${e.message}`);
    res.status(500).send(e.message); 
  }
});

cron.schedule('0 * * * *', runDiscovery);
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => addLog(`🔥 Стабильный движок v1.3.2 запущен на порту ${PORT}`));
