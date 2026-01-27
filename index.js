
const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require("@google/genai");

const app = express();
app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// Память сервера (очищается при перезагрузке, но помогает внутри сессии)
let articles = [];
let logs = [];
let postedTitles = new Set(); // Для мгновенной фильтрации дублей

const addLog = (msg) => {
  const log = `[${new Date().toLocaleTimeString('ru-RU')}] ${msg}`;
  logs.unshift(log);
  if (logs.length > 50) logs.pop();
  console.log(log);
};

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
  const now = new Date();
  addLog(`🔎 Запуск цикла поиска. Время: ${now.toLocaleTimeString()}`);
  
  // Берем заголовки из текущего списка, чтобы не повторяться
  const history = articles.slice(0, 50).map(a => a.title).join(' | ');

  try {
    const result = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `Найди 1 новую важную новость за последние 24 часа про Solid-State Battery. Сегодня ${now.toISOString().split('T')[0]}.`,
      config: { 
        systemInstruction: `Ты аналитик. Сегодня ${now.toLocaleDateString()}. 
        Найди ОДНУ новость, которой нет в списке: [${history}].
        Используй ТОЛЬКО реальные ссылки из поиска.
        Верни JSON: [{title, summary, telegramPost, visualPrompt, sourceUrl}]`,
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json"
      }
    });

    const newItems = JSON.parse(result.text);
    const chunks = result.candidates?.[0]?.groundingMetadata?.groundingChunks;

    if (!newItems || newItems.length === 0) {
      addLog("📭 Новых релевантных новостей за 24 часа не найдено.");
      return;
    }

    for (const item of newItems) {
      // Жесткая проверка на дубликат в памяти сервера
      if (postedTitles.has(item.title)) {
        addLog(`🚫 Пропуск дубликата: ${item.title}`);
        continue;
      }

      // Подтягиваем реальную ссылку из Grounding, если она есть
      if (chunks && chunks.length > 0 && chunks[0].web?.uri) {
        item.sourceUrl = chunks[0].web.uri;
      }

      addLog(`🎨 Генерация арта для: ${item.title}`);
      const imgResp = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [{ text: `High-tech clean visualization: ${item.visualPrompt}` }] },
        config: { imageConfig: { aspectRatio: "16:9" } }
      });
      
      let base64 = null;
      for (const p of imgResp.candidates[0].content.parts) if (p.inlineData) base64 = p.inlineData.data;

      const caption = `<b>${item.title}</b>\n\n${item.telegramPost}\n\n🔗 <a href="${item.sourceUrl}">Источник</a>`;
      
      const tgRes = await sendPhotoToTelegram(process.env.TELEGRAM_CHAT_ID, process.env.TELEGRAM_TOKEN, caption, base64);
      
      if (tgRes.ok) {
        postedTitles.add(item.title);
        item.id = Date.now();
        item.imageUrl = base64 ? `data:image/png;base64,${base64}` : null;
        articles.unshift(item);
        addLog(`✅ Опубликовано: ${item.title}`);
      } else {
        addLog(`❌ Ошибка TG: ${tgRes.description}`);
      }
    }
  } catch (err) {
    addLog(`❌ Критическая ошибка: ${err.message}`);
  }
}

app.get('/api/trigger', (req, res) => {
  runDiscovery(); // Запуск в фоне
  res.json({ status: "triggered" });
});

app.get('/api/articles', (req, res) => res.json(articles));
app.get('/api/status', (req, res) => res.json({ logs, online: true }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => addLog(`🚀 Eco-Server v2 ready on ${PORT}`));
