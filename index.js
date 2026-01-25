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

function formatToTelegramHTML(text) {
  if (!text) return "";
  return text
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.*?)\*/g, '<i>$1</i>')
    .replace(/__(.*?)__/g, '<i>$1</i>')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Возвращаем теги обратно после очистки спецсимволов
    .replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>')
    .replace(/&lt;i&gt;/g, '<i>').replace(/&lt;\/i&gt;/g, '</i>')
    .replace(/&lt;a (.*?)&gt;/g, '<a $1>').replace(/&lt;\/a&gt;/g, '</a>');
}

// Загрузка фото в Telegram через Multipart (решает проблему отсутствия картинок)
async function sendPhotoToTelegram(chatId, token, caption, base64Image) {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const buffer = Buffer.from(base64Image, 'base64');
  
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n`),
    Buffer.from(`--${boundary}--\r\n`)
  ]);

  const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: payload
  });

  return await response.json();
}

async function runDiscovery() {
  addLog("🏢 ЗАПУСК РЕДАКЦИИ (v1.4.5 - Deduplication & Photo Fix)...");
  
  // Берем последние 10 тем для исключения повторов
  const recentTopics = articles.slice(0, 10).map(a => a.title).join(', ');

  const systemPrompt = `Ты - главный редактор техно-блога. Твоя задача:
1. Просканируй новости за последний час про аккумуляторы и энергетику.
2. ЕСЛИ несколько источников пишут об одном и том же, ОБЪЕДИНИ их в один пост.
3. НЕ ПИШИ о темах, которые уже были: [${recentTopics}].
4. Для каждой темы выбери ОДНУ самую надежную и прямую ссылку из поиска.
5. Пиши экспертно на русском. Используй <b> и <i>. Никаких звёздочек **.
Верни JSON массив объектов: [{title, summary, telegramPost, visualPrompt, sourceUrl}]`;

  try {
    const result = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: systemPrompt,
      config: { tools: [{ googleSearch: {} }] }
    });

    const cleanText = result.text.substring(result.text.indexOf('['), result.text.lastIndexOf(']') + 1);
    const newItems = JSON.parse(cleanText);

    if (newItems.length === 0) {
      addLog("📭 Новых уникальных тем не обнаружено.");
      return;
    }

    for (const item of newItems) {
      addLog(`🎨 Создаю визуал: ${item.title.substring(0,30)}...`);
      
      const imgResp = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [{ text: `High-tech photorealistic 8k render: ${item.visualPrompt}` }] },
        config: { imageConfig: { aspectRatio: "16:9" } }
      });

      let base64 = null;
      for (const p of imgResp.candidates[0].content.parts) if (p.inlineData) base64 = p.inlineData.data;

      const chatId = process.env.TELEGRAM_CHAT_ID;
      const token = process.env.TELEGRAM_TOKEN;

      const caption = `<b>${item.title}</b>\n\n${formatToTelegramHTML(item.telegramPost)}\n\n🔗 <a href="${item.sourceUrl}">Читать источник</a>`;

      if (token && chatId) {
        const tgRes = await sendPhotoToTelegram(chatId, token, caption, base64);
        if (tgRes.ok) {
           addLog(`✅ Опубликовано: ${item.title.substring(0,20)}...`);
        } else {
           addLog(`⚠️ Ошибка TG: ${tgRes.description}. Пробую только текст...`);
           await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
             method: 'POST',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify({ chat_id: chatId, text: caption, parse_mode: 'HTML' })
           });
        }
      }

      item.id = Date.now() + Math.random();
      item.status = 'published';
      articles.unshift(item);
    }
    articles = articles.slice(0, 50);
  } catch (err) {
    addLog(`❌ Ошибка редакции: ${err.message}`);
  }
}

app.get('/api/trigger', (req, res) => { runDiscovery(); res.json({ status: "working" }); });
app.get('/api/status', (req, res) => res.json({ isOnline: true, version: "1.4.5", logs: logs }));
app.get('/api/articles', (req, res) => res.json(articles));

cron.schedule('0 * * * *', runDiscovery);
app.listen(process.env.PORT || 10000, () => addLog("🚀 Editor Engine v1.4.5 Ready"));
