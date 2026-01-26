
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { GoogleGenAI, Type } = require("@google/genai");

const app = express();
app.use(cors());
app.use(express.json());

// Инициализация ИИ (Flash модель для экономии бюджета при поиске)
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

async function sendPhotoToTelegram(chatId, token, caption, base64Image) {
  if (!base64Image) return { ok: false, description: "No image provided" };
  
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  const buffer = Buffer.from(base64Image, 'base64');
  
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="battery_tech.png"\r\nContent-Type: image/png\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`),
    Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n`),
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
  console.log("Starting discovery cycle...");
  const systemPrompt = `Ты - эксперт по твердотельным аккумуляторам. 
Найди 1-2 новости про Solid-State Batteries за последние 24 часа. 
ИГНОРИРУЙ обычный литий-ион. 
Формат ответа JSON: [{ "title": "...", "telegramPost": "...", "visualPrompt": "...", "sourceUrl": "..." }]`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: "Найди последние прорывы в Solid-State Batteries",
      config: { 
        systemInstruction: systemPrompt,
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json"
      }
    });

    const news = JSON.parse(response.text);
    for (const item of news) {
      // Генерация изображения
      const imgResp = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [{ text: `Futuristic 8k render of solid state battery tech: ${item.visualPrompt}` }] },
        config: { imageConfig: { aspectRatio: "16:9" } }
      });

      let base64 = null;
      for (const p of imgResp.candidates[0].content.parts) if (p.inlineData) base64 = p.inlineData.data;

      const caption = `<b>${item.title}</b>\n\n${item.telegramPost}\n\n🔗 <a href="${item.sourceUrl}">Источник</a>`;
      
      await sendPhotoToTelegram(
        process.env.TELEGRAM_CHAT_ID, 
        process.env.TELEGRAM_TOKEN, 
        caption, 
        base64
      );
      console.log("Published:", item.title);
    }
  } catch (err) {
    console.error("Discovery error:", err.message);
  }
}

// Эндпоинт для внешнего крона (cron-job.org)
app.get('/api/trigger', async (req, res) => {
  await runDiscovery();
  res.json({ status: "success" });
});

// Внутренний крон (на случай если сервер не спит)
cron.schedule('0 * * * *', runDiscovery);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
