import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { request as undiciRequest } from 'undici';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

/* ---------- ES Modules fix ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ---------- Config ---------- */
const PORT = process.env.PORT || 3000;
const MAINTENANCE_MODE = process.env.MAINTENANCE_MODE === 'true';
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const MAX_INPUT_CHARS = Number(process.env.MAX_INPUT_CHARS || 8000);
const MAX_TOKENS_OUT = Number(process.env.MAX_TOKENS_OUT || 1000);
const DEFAULT_TEMP = Number(process.env.DEFAULT_TEMP || 0.7);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/* ---------- Express setup ---------- */
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

/* ---------- Public Images ---------- */
const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(PUBLIC_DIR)) {
  fs.mkdirSync(PUBLIC_DIR);
}
app.use('/public', express.static(PUBLIC_DIR));

/* ---------- File upload setup ---------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type.'));
    }
  }
});

/* ---------- Maintenance Mode ---------- */
app.use((req, res, next) => {
  if (MAINTENANCE_MODE) {
    return res.status(503).json({
      message: '🚧 API under maintenance'
    });
  }
  next();
});

/* ---------- Utils ---------- */
const cache = new Map();

function cacheKey(body) {
  return JSON.stringify(body);
}

function truncateMessages(msgs) {
  let total = 0;
  const result = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    total += (msgs[i].content?.length ?? 0);
    if (total > MAX_INPUT_CHARS) break;
    result.unshift(msgs[i]);
  }
  return result;
}

// ✅ Clean model mapping
function mapModelToOpenAI(model) {
  const modelMap = {
    'gpt-3.5-turbo': 'gpt-4o-mini',
    'gpt-4': 'gpt-4o-mini',
    'gpt-4-turbo': 'gpt-4o-mini'
  };
  return modelMap[model] || 'gpt-4o-mini';
}

async function callOpenAIWithRetry(url, opts, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await undiciRequest(url, opts);
      return response;
    } catch (err) {
      console.error(`🔁 Retry ${i + 1}/${retries}:`, err.message);
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, delay * (i + 1)));
      } else {
        throw err;
      }
    }
  }
}

/* ---------- Root ---------- */
app.get('/', (_req, res) => {
  res.json({
    message: '✅ Chat AI Prime Server running',
    version: '3.0.0',
    endpoints: {
      chat: 'POST /v1/chat/completions',
      images: 'POST /v1/images',
      upload: 'POST /v1/images/upload',
      moderations: 'POST /v1/moderations'
    },
    imageModel: 'gpt-image-1'
  });
});

/* ---------- Health ---------- */
app.get('/health', (_req, res) => {
  res.status(200).json({ 
    status: 'OK',
    openai_key: OPENAI_KEY ? 'configured' : 'missing'
  });
});

/* ---------- Chat Completions ---------- */
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model = 'gpt-4', messages, stream = false } = req.body;

    if (!messages?.length) {
      return res.status(400).json({ error: { message: 'Messages required' }});
    }

    req.body.model = mapModelToOpenAI(model);
    req.body.messages = truncateMessages(messages);
    req.body.max_tokens = Math.min(req.body.max_tokens ?? 512, MAX_TOKENS_OUT);
    req.body.temperature = Math.min(Math.max(req.body.temperature ?? DEFAULT_TEMP, 0), 2);

    const key = cacheKey(req.body);
    if (!stream && cache.has(key)) {
      return res.json(cache.get(key));
    }

    const { body, statusCode, headers } = await callOpenAIWithRetry(
      'https://api.openai.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify(req.body)
      }
    );

    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    if (statusCode === 200 && buffer.length < 100 * 1024) {
      try {
        cache.set(key, JSON.parse(buffer.toString()));
      } catch {}
    }

    res.status(statusCode);
    res.setHeader('Content-Type', headers['content-type'] || 'application/json');
    res.send(buffer);

  } catch (error) {
    console.error('❌ Chat error:', error);
    res.status(500).json({ error: { message: 'Chat failed' }});
  }
});

/* ---------- ✅ Image Generation (dall-e-3) with Credit System ---------- */
app.post('/v1/images', async (req, res) => {
  try {
    const { prompt, size = "1024x1024" } = req.body;
    const isPro = req.headers['x-is-pro'] === 'true';
    const remainingCredits = parseInt(req.headers['x-remaining-credits']) || 0;
    
    // Check if user has credits available
    if (!isPro && remainingCredits <= 0) {
      return res.status(403).json({ 
        error: { 
          message: 'No image generation credits remaining. Please upgrade to Pro or earn more credits.' 
        } 
      });
    }

    // For testing: allow one free image for non-pro users
    // Remove this condition after testing
    const isTesting = true; // Set to false in production
    if (isTesting && !isPro && remainingCredits === 0) {
      // Allow one free image for testing
      console.log("🔧 TEST MODE: Allowing one free image for testing");
    } else if (!isPro && remainingCredits <= 0) {
      return res.status(403).json({ 
        error: { 
          message: 'No image generation credits remaining. Please upgrade to Pro or earn more credits.' 
        } 
      });
    }

    if (!prompt?.trim()) {
      return res.status(400).json({ error: { message: 'Prompt required' }});
    }

    const openaiBody = {
      model: "dall-e-3",
      prompt: prompt.trim(),
      size,
      response_format: "b64_json"
    };

    const { body, statusCode } = await callOpenAIWithRetry(
      "https://api.openai.com/v1/images/generations",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify(openaiBody)
      }
    );
    
    const chunks = [];
    for await (const c of body) chunks.push(c);
    const buffer = Buffer.concat(chunks);
    const json = JSON.parse(buffer.toString());

    if (statusCode !== 200) {
      console.error("❌ OpenAI Error:", json);
      return res.status(statusCode).json(json);
    }

    const base64Image = json.data[0].b64_json;
    if (!base64Image) {
        throw new Error("Missing b64_json in OpenAI response");
    }
    const imageBuffer = Buffer.from(base64Image, "base64");

    const fileName = `img_${Date.now()}.png`;
    const filePath = path.join(PUBLIC_DIR, fileName);
    fs.writeFileSync(filePath, imageBuffer);

    const fullUrl = `${req.protocol}://${req.get("host")}/public/${fileName}`;

    // Return success with credit consumption info
    res.json({
      created: Date.now(),
      data: [
        {
          url: fullUrl
        }
      ],
      credits_used: 1,
      remaining_credits: isPro ? "unlimited" : Math.max(0, remainingCredits - 1)
    });

  } catch (err) {
    console.error("❌ Image error:", err);
    res.status(500).json({ error: { message: "Image generation failed" }});
  }
});

/* ---------- Image Upload ---------- */
app.post('/v1/images/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: { message: 'No file uploaded' }});
    }

    const imageId = uuidv4();
    const mockUrl = `https://api.dicebear.com/7.x/avatars/svg?seed=${imageId}`;

    res.json({
      id: imageId,
      url: mockUrl,
      uploaded_at: new Date().toISOString()
    });

  } catch (error) {
    res.status(500).json({ error: { message: 'Upload failed' }});
  }
});

/* ---------- Moderations ---------- */
app.post('/v1/moderations', async (req, res) => {
  try {
    const { input } = req.body;

    const { body, statusCode } = await callOpenAIWithRetry(
      'https://api.openai.com/v1/moderations',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify({ input })
      }
    );

    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    res.status(statusCode);
    res.setHeader('Content-Type', 'application/json');
    res.send(buffer.toString());

  } catch {
    res.json({ flagged: false, bypassed: true });
  }
});

/* ---------- Errors ---------- */
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Route not found' }});
});

/* ---------- Start Server ---------- */
const server = createServer(app);

server.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🎨 Image model: gpt-image-1`);
  console.log(`🤖 Chat model: gpt-4o-mini`);
  console.log('='.repeat(50));
});





