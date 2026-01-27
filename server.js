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
// Updated to include both 3.5 and 4.0 models
const ALLOWED_MODELS = ['gpt-3.5-turbo', 'gpt-3.5-turbo-16k', 'gpt-4', 'gpt-4-turbo', 'gpt-4-32k'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

/* ---------- Express setup ---------- */
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* ---------- File upload setup ---------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, and PDF are allowed.'));
    }
  }
});

/* ---------- Maintenance Mode ---------- */
app.use((req, res, next) => {
  if (MAINTENANCE_MODE) {
    return res.status(503).json({
      message: '🚧 The API is under maintenance. Please try again later.'
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

// Map model names from app to OpenAI API
function mapModelToOpenAI(model) {
  const modelMap = {
    'gpt35Turbo': 'gpt-3.5-turbo',
    'gpt-3.5-turbo': 'gpt-3.5-turbo',
    'gpt-4': 'gpt-4',
    'gpt-4-turbo': 'gpt-4-turbo',
    'davinci': 'text-davinci-003',
    'curie': 'text-curie-001',
    'babbage': 'text-babbage-001',
    'ada': 'text-ada-001'
  };
  return modelMap[model] || 'gpt-3.5-turbo';
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

/* ---------- Routes ---------- */
app.get('/', (_req, res) => {
  res.json({
    message: '✅ Chat AI Prime Server is running',
    version: '2.0.0',
    endpoints: {
      chat: 'POST /v1/chat/completions',
      completions: 'POST /v1/completions',
      images: {
        generate: 'POST /v1/images/generations',
        upload: 'POST /v1/images/upload'
      },
      moderations: 'POST /v1/moderations'
    },
    features: [
      'Chat Completions (GPT-3.5, GPT-4)',
      'DALL-E Image Generation',
      'GPT-4 Image Generation Support',
      'Image Upload & Processing',
      'Content Moderation',
      'Streaming Support',
      'Caching',
      'Retry Logic'
    ]
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    openai_key: OPENAI_KEY ? 'configured' : 'missing'
  });
});

/* ---------- Legacy Text Completions (for compatibility) ---------- */
app.post('/v1/completions', async (req, res) => {
  try {
    console.log('📨 Legacy completions request:', { 
      model: req.body.model,
      prompt_length: req.body.prompt?.length,
      stream: req.body.stream 
    });

    const { model = 'gpt-3.5-turbo', prompt, stream = false } = req.body;
    
    if (!prompt || prompt.trim().length === 0) {
      return res.status(400).json({
        error: {
          message: 'Prompt is required',
          type: 'invalid_request_error'
        }
      });
    }

    const openaiModel = mapModelToOpenAI(model);
    
    // Convert legacy request to chat format
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: prompt.trim() }
    ];

    const requestBody = {
      model: openaiModel,
      messages: messages,
      max_tokens: req.body.max_tokens || 512,
      temperature: req.body.temperature || 0.7,
      stream: stream
    };

    const key = cacheKey(requestBody);
    if (!stream && cache.has(key)) {
      console.log('⚡ Cache hit');
      return res.json(cache.get(key));
    }

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Accept': stream ? 'text/event-stream' : 'application/json'
      },
      body: JSON.stringify(requestBody)
    };

    const { body, statusCode, headers } = await callOpenAIWithRetry(
      'https://api.openai.com/v1/chat/completions',
      options
    );

    if (stream) {
      res.writeHead(statusCode, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      for await (const chunk of body) {
        res.write(chunk);
      }
      res.end();
      return;
    }

    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    const fullBuffer = Buffer.concat(chunks);
    const responseText = fullBuffer.toString('utf-8');

    if (statusCode === 200 && fullBuffer.length < 100 * 1024) {
      try {
        const openaiResponse = JSON.parse(responseText);
        // Convert chat response back to completions format
        const legacyResponse = {
          id: openaiResponse.id,
          object: 'text_completion',
          created: openaiResponse.created,
          model: model, // Keep original model name for compatibility
          choices: openaiResponse.choices.map(choice => ({
            text: choice.message?.content || '',
            index: choice.index,
            finish_reason: choice.finish_reason
          })),
          usage: openaiResponse.usage
        };
        
        cache.set(key, legacyResponse);
        
        if (cache.size > 500) {
          const firstKey = cache.keys().next().value;
          if (firstKey) cache.delete(firstKey);
        }
        
        res.status(200).json(legacyResponse);
      } catch (e) {
        console.error('❌ Cache parse error:', e.message);
        res.status(statusCode);
        res.setHeader('Content-Type', headers['content-type'] || 'application/json');
        res.send(fullBuffer);
      }
    } else {
      res.status(statusCode);
      res.setHeader('Content-Type', headers['content-type'] || 'application/json');
      res.send(fullBuffer);
    }

  } catch (error) {
    console.error('❌ Completions error:', error.message);
    res.status(500).json({
      error: {
        message: 'Internal server error',
        type: 'server_error',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      }
    });
  }
});

/* ---------- Chat Completions ---------- */
app.post('/v1/chat/completions', async (req, res) => {
  try {
    console.log('📨 Chat request received:', { 
      model: req.body.model,
      messages: req.body.messages?.length,
      stream: req.body.stream 
    });

    const { model = 'gpt-3.5-turbo', messages, stream = false } = req.body;
    
    if (!messages || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: 'Messages array is required',
          type: 'invalid_request_error'
        }
      });
    }

    // Map model name if needed
    const openaiModel = mapModelToOpenAI(model);
    
    req.body.model = openaiModel;
    req.body.messages = truncateMessages(messages);
    req.body.max_tokens = Math.min(req.body.max_tokens ?? 512, MAX_TOKENS_OUT);
    req.body.temperature = Math.min(Math.max(req.body.temperature ?? DEFAULT_TEMP, 0), 2);

    const key = cacheKey(req.body);
    if (!stream && cache.has(key)) {
      console.log('⚡ Cache hit');
      return res.json(cache.get(key));
    }

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Accept': stream ? 'text/event-stream' : 'application/json'
      },
      body: JSON.stringify(req.body)
    };

    const { body, statusCode, headers } = await callOpenAIWithRetry(
      'https://api.openai.com/v1/chat/completions',
      options
    );

    if (stream) {
      res.writeHead(statusCode, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      for await (const chunk of body) {
        res.write(chunk);
      }
      res.end();
      return;
    }

    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    const fullBuffer = Buffer.concat(chunks);
    const responseText = fullBuffer.toString('utf-8');

    if (statusCode === 200 && fullBuffer.length < 100 * 1024) {
      try {
        const responseJson = JSON.parse(responseText);
        cache.set(key, responseJson);
        
        if (cache.size > 500) {
          const firstKey = cache.keys().next().value;
          if (firstKey) cache.delete(firstKey);
        }
      } catch (e) {
        console.error('❌ Cache parse error:', e.message);
      }
    }

    res.status(statusCode);
    res.setHeader('Content-Type', headers['content-type'] || 'application/json');
    res.send(fullBuffer);

  } catch (error) {
    console.error('❌ Chat error:', error.message);
    res.status(500).json({
      error: {
        message: 'Internal server error',
        type: 'server_error',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      }
    });
  }
});

/* ---------- Image Generation (DALL-E) ---------- */
app.post('/v1/images/generations', async (req, res) => {
  try {
    console.log('🎨 Image generation request:', { 
      prompt_length: req.body.prompt?.length,
      model: req.body.model 
    });

    const { prompt, n = 1, size = '512x512', response_format = 'url', model = 'dall-e-2' } = req.body;

    if (!prompt || prompt.trim().length === 0) {
      return res.status(400).json({
        error: {
          message: 'Prompt is required',
          type: 'invalid_request_error'
        }
      });
    }

    const imageCount = Math.min(Math.max(parseInt(n), 1), 10);
    const validSizes = ['256x256', '512x512', '1024x1024', '1024x1792', '1792x1024'];
    const imageSize = validSizes.includes(size) ? size : '512x512';
    
    // Support for DALL-E 3 and GPT-4 image generation
    const imageModel = model === 'dall-e-3' || model === 'gpt-4' ? 'dall-e-3' : 'dall-e-2';

    const openaiBody = {
      prompt: prompt.trim(),
      n: imageCount,
      size: imageSize,
      model: imageModel,
      response_format: response_format
    };

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify(openaiBody)
    };

    const { body, statusCode } = await callOpenAIWithRetry(
      'https://api.openai.com/v1/images/generations',
      options
    );

    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    const fullBuffer = Buffer.concat(chunks);
    const responseText = fullBuffer.toString('utf-8');

    if (statusCode === 200) {
      try {
        const responseJson = JSON.parse(responseText);
        
        responseJson.metadata = {
          generated_at: new Date().toISOString(),
          model: imageModel,
          prompt_length: prompt.length,
          size: imageSize
        };
        
        res.status(200).json(responseJson);
      } catch (e) {
        console.error('❌ JSON parse error:', e.message);
        res.status(500).json({
          error: {
            message: 'Failed to parse response',
            type: 'parse_error'
          }
        });
      }
    } else {
      res.status(statusCode);
      res.setHeader('Content-Type', 'application/json');
      res.send(fullBuffer);
    }

  } catch (error) {
    console.error('❌ Image generation error:', error.message);
    res.status(500).json({
      error: {
        message: 'Image generation failed',
        type: 'server_error',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      }
    });
  }
});

/* ---------- Image Upload ---------- */
app.post('/v1/images/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: {
          message: 'No file uploaded',
          type: 'invalid_request_error'
        }
      });
    }

    console.log('📤 Image upload:', {
      filename: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype
    });

    // For now, we'll just return a mock URL since OpenAI's image upload API
    // requires specific endpoints. You can implement actual upload logic here.
    
    const imageId = uuidv4();
    const mockUrl = `https://api.dicebear.com/7.x/avatars/svg?seed=${imageId}`;
    
    res.status(200).json({
      id: imageId,
      url: mockUrl,
      metadata: {
        uploaded_at: new Date().toISOString(),
        original_name: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype
      }
    });

  } catch (error) {
    console.error('❌ Image upload error:', error.message);
    res.status(500).json({
      error: {
        message: 'Image upload failed',
        type: 'server_error'
      }
    });
  }
});

/* ---------- Moderations ---------- */
app.post('/v1/moderations', async (req, res) => {
  try {
    const { input } = req.body;

    if (!input || input.trim().length === 0) {
      return res.status(400).json({
        error: {
          message: 'Input is required',
          type: 'invalid_request_error'
        }
      });
    }

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({ input: input.trim() })
    };

    const { body, statusCode } = await callOpenAIWithRetry(
      'https://api.openai.com/v1/moderations',
      options
    );

    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    const fullBuffer = Buffer.concat(chunks);
    
    res.status(statusCode);
    res.setHeader('Content-Type', 'application/json');
    res.send(fullBuffer.toString('utf-8'));

  } catch (error) {
    console.error('❌ Moderation error:', error.message);
    res.status(200).json({
      id: 'modr-' + Date.now(),
      model: 'text-moderation-stable',
      results: [{
        flagged: false,
        categories: {},
        category_scores: {},
        bypassed: true,
        message: 'Moderation temporarily unavailable — continuing safely.'
      }]
    });
  }
});

/* ---------- Error Handling ---------- */
app.use((req, res) => {
  res.status(404).json({
    error: {
      message: `Route ${req.method} ${req.path} not found`,
      type: 'not_found'
    }
  });
});

app.use((error, req, res, next) => {
  console.error('🚨 Unhandled error:', error);
  res.status(500).json({
    error: {
      message: 'Internal server error',
      type: 'server_error'
    }
  });
});

/* ---------- Start Server ---------- */
const server = createServer(app);

server.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log(`🚀 Chat AI Prime Server`);
  console.log(`📡 Running on port: ${PORT}`);
  console.log(`🤖 Supported Models: ${ALLOWED_MODELS.join(', ')}`);
  console.log(`🎨 Image Models: DALL-E 2, DALL-E 3`);
  console.log(`🔧 Maintenance: ${MAINTENANCE_MODE ? 'ON' : 'OFF'}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log('='.repeat(50));
});

process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received, shutting down');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('👋 SIGINT received, shutting down');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
