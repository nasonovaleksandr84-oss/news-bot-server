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

async function sendToTelegram(text) {
  const token = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!token || !chatId) {
    addLog("⚠️ Пропуск TG: не настроены TELEGRAM_TOKEN или TELEGRAM_CHAT_ID в Render");
    return false;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML'
      })
    });
    const data = await res.json();
    if (res.ok) {
      addLog("📢 Пост успешно отправлен в Telegram!");
      return true;
    } else {
      addLog(`❌ Ошибка TG API: ${data.description}`);
      return false;
    }
  } catch (e) {
    addLog(`❌ Ошибка сетевого запроса к TG: ${e.message}`);
    return false;
  }
}

async function runDiscovery() {
  addLog("🔍 Начинаю поиск свежих новостей про аккумуляторы...");
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: "Найди 3 самые важные новости про твердотельные и литиевые аккумуляторы за последние 24 часа. Составь отчет на русском языке. Для каждой новости напиши заголовок и краткий абзац. В конце добавь подходящие хештеги.",
      config: { 
        tools: [{ googleSearch: {} }] 
      }
    });

    const newsText = response.text;
    if (!newsText) throw new Error("AI вернул пустой ответ");
    
    addLog("✅ Нейросеть успешно обработала данные");
    
    // Отправляем результат в Telegram
    await sendToTelegram(newsText);
    
  } catch (err) {
    addLog(`❌ Критическая ошибка в цикле: ${err.message}`);
  }
}

// Эндпоинты
app.get('/api/status', (req, res) => {
  res.json({ 
    isOnline: true, 
    version: "1.1.5", 
    mode: 'production',
    logs: logs 
  });
});

app.post('/api/trigger', (req, res) => {
  addLog("🕹️ Ручной запуск через админку...");
  runDiscovery();
  res.json({ status: "started" });
});

// Крон: каждый час
cron.schedule('0 * * * *', () => {
  addLog("⏰ Запуск по расписанию...");
  runDiscovery();
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  addLog(`🚀 Сервер запущен на порту ${PORT}. Версия 1.1.5`);
});
