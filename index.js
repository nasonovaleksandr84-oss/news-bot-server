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

async function runDiscovery() {
  addLog("🔍 Поиск активирован...");
  try {
    addLog("📡 Соединение с Gemini 3 Pro + Search Grounding...");
    
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: "Найди 3 свежих новости про аккумуляторы и твердотельные батареи. Верни СТРОГО JSON массив объектов: [{id, title, summary, telegramPost, visualPrompt, impactScore, techSpecs: {energyDensity, chemistry}}]. Только JSON без лишних слов.",
      config: { 
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json"
      }
    });
    
    if (!response.text) {
      throw new Error("Пустой ответ от ИИ");
    }

    addLog("⏳ Анализ ответа...");
    // Очистка от markdown оберток, если они есть
    let jsonStr = response.text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(json)?/, '').replace(/```$/, '').trim();
    }

    const newArticles = JSON.parse(jsonStr).map(a => ({
      ...a, 
      id: a.id || `art_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      createdAt: new Date().toISOString(), 
      status: 'draft'
    }));
    
    articles = [...newArticles, ...articles].slice(0, 50);
    addLog(`✅ Успех: Найдено и обработано ${newArticles.length} новостей.`);
  } catch (err) { 
    addLog(`❌ ОШИБКА: ${err.message}`);
    console.error(err);
  }
}

app.get('/api/status', (req, res) => res.json({ 
  isOnline: true, 
  version: "1.2.3", 
  logs: logs, 
  mode: 'production' 
}));

app.get('/api/articles', (req, res) => res.json(articles));

app.post('/api/trigger', (req, res) => { 
  addLog("🕹️ Ручной запуск через панель управления..."); 
  runDiscovery(); 
  res.json({ status: "started" }); 
});

app.post('/api/publish', async (req, res) => {
  const { articleId, image } = req.body;
  const article = articles.find(a => a.id === articleId);
  if (!article) return res.status(404).json({ error: "Article not found" });
  
  addLog(`📢 Публикация: ${article.title}`);
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  try {
    const endpoint = image ? 'sendPhoto' : 'sendMessage';
    const body = image 
      ? { chat_id: chatId, photo: image, caption: article.telegramPost, parse_mode: 'HTML' }
      : { chat_id: chatId, text: article.telegramPost, parse_mode: 'HTML' };

    const r = await fetch(`https://api.telegram.org/bot${token}/${endpoint}`, { 
      method: 'POST', 
      headers: {'Content-Type': 'application/json'}, 
      body: JSON.stringify(body) 
    });
    
    if (r.ok) {
      article.status = 'published';
      addLog("✅ Телеграм подтвердил получение.");
      return res.json({ success: true });
    }
    const error = await r.json();
    addLog(`❌ Ошибка TG: ${error.description}`);
    res.status(500).json(error);
  } catch (e) { 
    addLog("❌ Ошибка сети при связи с TG");
    res.status(500).json({ error: "Network failed" }); 
  }
});

cron.schedule('0 * * * *', runDiscovery);
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => addLog(`🚀 Движок v1.2.3 запущен на порту ${PORT}`));
