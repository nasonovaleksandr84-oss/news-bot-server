const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const fetch = require('node-fetch');
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(cors());
app.use(express.json());

// Инициализация AI
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
  
  if (!token || !chatId) {
    addLog("⚠️ Ошибка: TELEGRAM_TOKEN или TELEGRAM_CHAT_ID не заданы в настройках Render");
    return false;
  }

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
    const data = await res.json();
    if (res.ok) {
      addLog("📢 Успешно отправлено в Telegram!");
      return true;
    } else {
      addLog(`❌ Ошибка Telegram API: ${data.description}`);
      return false;
    }
  } catch (e) {
    addLog(`❌ Ошибка сети при отправке в TG: ${e.message}`);
    return false;
  }
}

async function runDiscovery() {
  addLog("🔍 Запускаю ИИ-поиск новостей (Gemini 3 Pro + Search)...");
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: "Найди 3 самые важные технические новости про твердотельные аккумуляторы и электромобили за последние 24 часа. Сформируй список объектов JSON. Каждый объект должен иметь: id, title, summary, telegramPost, visualPrompt, impactScore (1-100), keywords (массив). Отвечай ТОЛЬКО чистым JSON.",
      config: { 
        tools: [{ googleSearch: {} }] 
      }
    });

    const text = response.text;
    // Очистка от markdown-оберток если они есть
    const jsonStr = text.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '').trim();
    const newArticles = JSON.parse(jsonStr);
    
    // Добавляем дату создания
    const processed = newArticles.map(a => ({
      ...a,
      createdAt: new Date().toISOString(),
      status: 'draft'
    }));

    articles = [...processed, ...articles].slice(0, 20);
    addLog(`✅ Найдено и обработано новостей: ${processed.length}`);
    
  } catch (err) {
    addLog(`❌ Ошибка в runDiscovery: ${err.message}`);
    // Если упал парсинг JSON, выведем сырой текст для отладки
    console.error(err);
  }
}

// --- API ЭНДПОИНТЫ ---

app.get('/api/status', (req, res) => {
  res.json({ 
    isOnline: true, 
    version: "1.2.0", 
    mode: 'production',
    logs: logs.slice(0, 10)
  });
});

app.get('/api/articles', (req, res) => {
  res.json(articles);
});

app.post('/api/trigger', (req, res) => {
  addLog("🕹️ Ручной запуск поиска из админки...");
  runDiscovery();
  res.json({ status: "processing" });
});

app.post('/api/publish', async (req, res) => {
  const { articleId, image } = req.body;
  const article = articles.find(a => a.id === articleId);
  
  if (!article) {
    return res.status(404).json({ error: "Новость не найдена" });
  }

  addLog(`📤 Публикация новости: ${article.title}`);
  const success = await sendToTelegram(article.telegramPost, image);
  
  if (success) {
    article.status = 'published';
    res.json({ success: true });
  } else {
    res.status(500).json({ error: "Ошибка отправки в Telegram" });
  }
});

// Крон: раз в час
cron.schedule('0 * * * *', runDiscovery);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  addLog(`🚀 Сервер v1.2.0 готов к работе на порту ${PORT}`);
});
