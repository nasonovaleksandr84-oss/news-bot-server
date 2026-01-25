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

// Конвертер из Markdown в HTML для Telegram
function formatToTelegramHTML(text) {
  if (!text) return "";
  return text
    .replace(/\*\*(.*?)\*\*/g, '<b>$1</b>') // Жирный
    .replace(/\*(.*?)\*/g, '<i>$1</i>')      // Курсив
    .replace(/__(.*?)__/g, '<i>$1</i>');       // Курсив (нижнее подчеркивание)
}

// Генерация изображения на сервере
async function generateVisualForArticle(visualPrompt) {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: { parts: [{ text: `Professional technical 3D visualization, 8k, cinematic lighting: ${visualPrompt}` }] },
      config: { imageConfig: { aspectRatio: "16:9" } }
    });

    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        return part.inlineData.data; // Base64
      }
    }
  } catch (e) {
    addLog(`⚠️ Ошибка генерации фото: ${e.message}`);
    return null;
  }
}

async function sendToTelegram(article, imageBase64) {
  const token = process.env.TELEGRAM_TOKEN;
  let chatId = process.env.TELEGRAM_CHAT_ID;
  
  if (!token || !chatId) return false;

  if (!chatId.startsWith('-') && !chatId.startsWith('@')) {
    chatId = `-100${chatId}`;
  }

  // Форматируем текст (убираем звезды, ставим HTML теги)
  const formattedText = formatToTelegramHTML(article.telegramPost);
  const caption = `<b>${article.title}</b>\n\n${formattedText}\n\n🔗 <a href="${article.sources[0]?.url}">Читать оригинал</a>`;

  try {
    let endpoint = 'sendMessage';
    let body = { chat_id: chatId, text: caption, parse_mode: 'HTML' };

    if (imageBase64) {
      endpoint = 'sendPhoto';
      // Отправка файла через multipart/form-data была бы сложнее, 
      // но Bot API поддерживает прямую отправку base64 через URL (иногда) или просто передачу Buffer.
      // Используем метод передачи Buffer для надежности
      const formData = new URLSearchParams();
      formData.append('chat_id', chatId);
      formData.append('photo', `data:image/png;base64,${imageBase64}`); // Для небольших фото
      formData.append('caption', caption);
      formData.append('parse_mode', 'HTML');
      
      // Однако проще всего отправить как JSON, если мы используем URL картинки или отправить Buffer
      // Используем упрощенный метод через URL, если картинка не проходит - шлем текст.
    }

    const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: `data:image/png;base64,${imageBase64}`,
        caption: caption,
        parse_mode: 'HTML'
      })
    });

    // Если фото не прошло (бывает из-за размера base64), шлем текст
    if (!r.ok) {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: caption, parse_mode: 'HTML' })
        });
    }

    article.status = 'published';
    addLog(`✅ Опубликовано в TG: ${article.title.substring(0,25)}...`);
    return true;
  } catch (e) {
    addLog(`❌ Сбой TG: ${e.message}`);
    return false;
  }
}

async function runDiscovery() {
  addLog("🔋 ГЛУБОКИЙ ПОИСК (v1.4.4 - Media Mode)...");
  
  try {
    const result = await ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: "Найди 3 актуальные новости про аккумуляторы и энергетику. Для каждой напиши подробный пост для Telegram. ИСПОЛЬЗУЙ ТОЛЬКО <b> И <i> ТЕГИ ДЛЯ ВЫДЕЛЕНИЯ ТЕКСТА. ЗАПРЕЩЕНО ИСПОЛЬЗОВАТЬ **. Ссылки бери ПРЯМЫЕ из поиска. Верни JSON: [{title, telegramPost, visualPrompt, sources:[{url}]}]",
      config: { tools: [{ googleSearch: {} }] }
    });

    const start = result.text.indexOf('[');
    const end = result.text.lastIndexOf(']');
    const items = JSON.parse(result.text.substring(start, end + 1));

    for (const item of items) {
      item.id = `art_${Date.now()}_${Math.random().toString(36).substr(2,4)}`;
      item.createdAt = new Date().toISOString();
      
      addLog(`🎨 Генерирую обложку: ${item.title.substring(0,30)}...`);
      const imageBase64 = await generateVisualForArticle(item.visualPrompt);
      
      await sendToTelegram(item, imageBase64);
      articles.unshift(item);
    }
    
    articles = articles.slice(0, 50);
  } catch (err) {
    addLog(`❌ Критическая ошибка: ${err.message}`);
  }
}

app.get('/api/trigger', (req, res) => { runDiscovery(); res.json({ status: "started" }); });
app.get('/api/status', (req, res) => res.json({ isOnline: true, version: "1.4.4", logs: logs }));
app.get('/api/articles', (req, res) => res.json(articles));
app.post('/api/publish', async (req, res) => {
    const { articleId, image } = req.body;
    const article = articles.find(a => a.id === articleId);
    if (!article) return res.status(404).send("Not found");
    const success = await sendToTelegram(article, image);
    res.json({ success });
});

cron.schedule('0 * * * *', runDiscovery);
app.listen(process.env.PORT || 10000, () => addLog("🔥 Engine v1.4.4 Active"));
