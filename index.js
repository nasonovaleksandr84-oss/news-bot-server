
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
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
  if (logs.length > 50) logs.pop();
  console.log(log);
};

function formatToTelegramHTML(text) {
  if (!text) return "";
  return text
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.*?)\*/g, '<i>$1</i>')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>');
}

async function sendPhotoToTelegram(chatId, token, caption, base64Image) {
  if (!base64Image) return { ok: false };
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const buffer = Buffer.from(base64Image, 'base64');
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="img.png"\r\nContent-Type: image/png\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`),
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n`),
    Buffer.from(`--${boundary}--\r\n`)
  ]);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: payload
  });
  return await res.json();
}

async function runDiscovery() {
  addLog("🏢 Поиск прорывов в Solid-State...");
  try {
    const result = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: "Найди 1-2 последние новости про Solid-State Battery breakthroughs за 24ч. Игнорируй повторы.",
      config: { 
        systemInstruction: "Верни JSON массив: [{title, summary, telegramPost, visualPrompt, sourceUrl}]",
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json"
      }
    });

    const newItems = JSON.parse(result.text);
    for (const item of newItems) {
      addLog(`🎨 Генерация визуала: ${item.title.substring(0,30)}...`);
      const imgResp = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [{ text: `High-tech solid state battery tech: ${item.visualPrompt}` }] },
        config: { imageConfig: { aspectRatio: "16:9" } }
      });
      let base64 = null;
      for (const p of imgResp.candidates[0].content.parts) if (p.inlineData) base64 = p.inlineData.data;

      const caption = `<b>${item.title}</b>\n\n${formatToTelegramHTML(item.telegramPost)}\n\n🔗 <a href="${item.sourceUrl}">Источник</a>`;
      const tg = await sendPhotoToTelegram(process.env.TELEGRAM_CHAT_ID, process.env.TELEGRAM_TOKEN, caption, base64);
      
      item.id = Date.now() + Math.random();
      item.imageUrl = base64 ? `data:image/png;base64,${base64}` : null;
      articles.unshift(item);
      addLog(`✅ Успешно опубликовано: ${item.title}`);
    }
    if (articles.length > 50) articles = articles.slice(0, 50);
  } catch (err) {
    addLog(`❌ Ошибка цикла: ${err.message}`);
  }
}

app.get('/api/trigger', (req, res) => { runDiscovery(); res.json({ status: "triggered" }); });
app.get('/api/articles', (req, res) => res.json(articles));
app.get('/api/status', (req, res) => res.json({ logs: logs, online: true }));

cron.schedule('0 * * * *', runDiscovery);
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => addLog(`🚀 Backend Ready on port ${PORT}`));
