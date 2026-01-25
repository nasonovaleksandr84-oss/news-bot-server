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
  addLog("🚀 Запуск DEEP RESEARCH (Gemini 3 PRO)...");
  
  const performRequest = async (model) => {
    addLog(`🔍 Модель: ${model}. Изучаю последние патенты и новости...`);
    return await ai.models.generateContent({
      model: model,
      contents: "Найди 3 максимально свежих и важных новости про аккумуляторы (твердотельные, натриевые и т.д.). Напиши ОЧЕНЬ ГЛУБОКИЕ, ПРОФЕССИОНАЛЬНЫЕ лонгриды на русском. Текст каждого поста должен быть в 2-3 раза длиннее обычного (минимум 4-5 абзацев). Обязательно включи: 1. Суть прорыва. 2. Технические детали (материалы, цифры). 3. Сравнение с текущими литий-ионными АКБ. 4. Мнение эксперта (имитация). Верни ТОЛЬКО JSON массив объектов: [{id, title, summary, telegramPost, visualPrompt, impactScore, techSpecs: {energyDensity, chemistry}, sources: [{title, url}]}].",
      config: { tools: [{ googleSearch: {} }] }
    });
  };

  try {
    let result;
    try {
      result = await performRequest('gemini-3-pro-preview');
    } catch (proErr) {
      addLog("⚠️ Pro Mode недоступен или лимит. Пробую Flash...");
      result = await performRequest('gemini-3-flash-preview');
    }
    
    addLog("✍️ ИИ пишет подробные статьи...");
    const responseText = result.text || "";
    const jsonStr = extractJson(responseText);

    if (!jsonStr) {
        addLog("❌ ОШИБКА: ИИ не выдал JSON.");
        return;
    }

    const rawItems = JSON.parse(jsonStr);
    const newArticles = rawItems.map(item => ({
      ...item,
      id: item.id || `art_${Date.now()}`,
      sources: Array.isArray(item.sources) ? item.sources : [],
      createdAt: new Date().toISOString(),
      status: 'draft'
    }));

    articles = [...newArticles, ...articles].slice(0, 50);
    addLog(`✅ ГОТОВО: Создано ${newArticles.length} масштабных обзоров.`);

  } catch (err) {
    addLog(`❌ КРИТИЧЕСКАЯ ОШИБКА: ${err.message}`);
  }
}

// FIX: Обработка корня, чтобы Крон не получал 404
app.get('/', (req, res) => {
  res.send('Newsroom Engine v1.4.1 is Active. Server is Online.');
});

// FIX: Поддержка GET для Крона (чтобы можно было просто перейти по ссылке и запустить)
app.get('/api/trigger', (req, res) => {
  runDiscovery();
  res.json({ status: "discovery_started_via_get" });
});

app.get('/api/status', (req, res) => res.json({ isOnline: true, version: "1.4.1-stable", logs: logs }));
app.get('/api/articles', (req, res) => res.json(articles));
app.post('/api/trigger', (req, res) => { runDiscovery(); res.json({ status: "processing" }); });

app.post('/api/publish', async (req, res) => {
  const { articleId, image } = req.body;
  const article = articles.find(a => a.id === articleId);
  if (!article) return res.status(404).json({ error: "Not found" });
  
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
        addLog("✅ Опубликовано в Telegram.");
        res.json({ success: true });
    } else {
        const data = await r.json();
        addLog(`❌ TG Error: ${data.description}`);
        res.status(500).json(data);
    }
  } catch (e) { 
    res.status(500).send(e.message); 
  }
});

cron.schedule('0 * * * *', runDiscovery);
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => addLog(`🔥 Стабильный движок v1.4.1 (Fix 404) запущен на порту ${PORT}`));
