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

// Функция отправки в Telegram
async function sendToTelegram(article) {
  const token = process.env.TELEGRAM_TOKEN;
  let chatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!token || !chatId) {
    addLog("⚠️ Пропуск авто-поста: Не настроены TELEGRAM_TOKEN или TELEGRAM_CHAT_ID в переменных окружения.");
    return false;
  }

  // Авто-фикс ID канала (должен начинаться с -100 для публичных каналов)
  if (!chatId.startsWith('-') && !chatId.startsWith('@')) {
    chatId = `-100${chatId}`;
  }

  addLog(`📤 Публикация в канал (${article.title.substring(0,20)}...)`);
  
  try {
    const payload = { 
      chat_id: chatId, 
      text: `<b>${article.title}</b>\n\n${article.telegramPost}\n\n🔗 <a href="${article.sources[0]?.url}">Читать оригинал</a>`, 
      parse_mode: 'HTML',
      disable_web_page_preview: false
    };

    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    const res = await r.json();
    if (r.ok) {
      article.status = 'published';
      addLog("✅ Успешно опубликовано автоматически.");
      return true;
    } else {
      addLog(`❌ Ошибка TG: ${res.description}`);
      return false;
    }
  } catch (e) {
    addLog(`❌ Сбой сети при отправке: ${e.message}`);
    return false;
  }
}

function cleanAndParse(text) {
  try {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start === -1 || end === -1) return null;
    let jsonStr = text.substring(start, end + 1);
    jsonStr = jsonStr.replace(/,\s*]/g, ']').replace(/,\s*}/g, '}');
    return JSON.parse(jsonStr);
  } catch (e) { return null; }
}

async function runDiscovery(autoPublish = true) {
  addLog("🔎 ЗАПУСК ПОИСКА (v1.4.3 - Direct Sourcing)...");
  
  const performRequest = async (model) => {
    return await ai.models.generateContent({
      model: model,
      contents: "Найди 3 свежайшие новости о прорывах в аккумуляторах. Напиши ЭКСПЕРТНЫЕ лонгриды на русском. ТРЕБОВАНИЕ К ССЫЛКАМ: Дай ПРЯМУЮ ссылку на конкретную статью/новость, а не на главную страницу сайта. Верни JSON массив объектов: [{id, title, summary, telegramPost, visualPrompt, sources: [{title, url}] }].",
      config: { tools: [{ googleSearch: {} }] }
    });
  };

  try {
    const result = await performRequest('gemini-3-pro-preview');
    const items = cleanAndParse(result.text || "");

    if (!items) {
      addLog("⚠️ ИИ не смог сформировать данные. Пробую еще раз...");
      return;
    }

    const newArticles = items.map(item => ({
      ...item,
      id: `art_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      createdAt: new Date().toISOString(),
      status: 'draft'
    }));

    articles = [...newArticles, ...articles].slice(0, 50);
    addLog(`✅ Найдено ${newArticles.length} новостей.`);

    // АВТО-ПУБЛИКАЦИЯ
    if (autoPublish) {
      for (const article of newArticles) {
        await sendToTelegram(article);
      }
    }

  } catch (err) {
    addLog(`❌ Ошибка: ${err.message}`);
  }
}

app.get('/', (req, res) => res.send('News Engine v1.4.3 (Auto-Post) is Running.'));
app.get('/api/trigger', (req, res) => { runDiscovery(true); res.json({ status: "auto_discovery_started" }); });
app.get('/api/status', (req, res) => res.json({ isOnline: true, version: "1.4.3-autopost", logs: logs }));
app.get('/api/articles', (req, res) => res.json(articles));
app.post('/api/trigger', (req, res) => { runDiscovery(true); res.json({ status: "processing" }); });

app.post('/api/publish', async (req, res) => {
  const { articleId } = req.body;
  const article = articles.find(a => a.id === articleId);
  if (!article) return res.status(404).send("Article not found");
  const success = await sendToTelegram(article);
  if (success) res.json({ success: true });
  else res.status(500).json({ error: "TG failed" });
});

cron.schedule('0 * * * *', () => runDiscovery(true));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => addLog(`🚀 Newsroom Engine v1.4.3 (Auto-Post) стартовал на порту ${PORT}`));
