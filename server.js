/* --------------------------- server.js --------------------------- */
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { request as undiciRequest } from 'undici';

dotenv.config();

/* ---------- Config ---------- */
const PORT = process.env.PORT || 3000;
const MAINTENANCE_MODE = process.env.MAINTENANCE_MODE === 'true';
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const MAX_INPUT_CHARS = Number(process.env.MAX_INPUT_CHARS || 8000);
const MAX_TOKENS_OUT = Number(process.env.MAX_TOKENS_OUT || 1000);
const DEFAULT_TEMP = Number(process.env.DEFAULT_TEMP || 0.7);
const ALLOWED_MODELS = ['gpt-3.5-turbo', 'gpt-4']; // Allow GPT-4

/* ---------- Express setup ---------- */
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    message: '✅ OpenAI Proxy Server running',
    endpoints: {
      chat: 'POST /v1/chat/completions',
      images: 'POST /v1/images/generations',
      moderations: 'POST /v1/moderations'
    },
    features: ['Streaming', 'Caching', 'Retry Logic', 'DALL-E Image Generation']
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

/* ---------- Chat Completions ---------- */
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model = 'gpt-3.5-turbo', messages, stream = false } = req.body;
    
    // Check if model is allowed
    if (!ALLOWED_MODELS.includes(model)) {
      return res.status(400).json({
        error: {
          message: `Model ${model} not allowed. Allowed models: ${ALLOWED_MODELS.join(', ')}`,
          type: 'invalid_request_error'
        }
      });
    }

    // Truncate messages if needed
    if (messages) {
      req.body.messages = truncateMessages(messages);
    }

    // Set safe limits
    req.body.max_tokens = Math.min(req.body.max_tokens ?? 512, MAX_TOKENS_OUT);
    req.body.temperature = Math.min(Math.max(req.body.temperature ?? DEFAULT_TEMP, 0), 2);

    // For non-streaming requests, use cache
    const key = cacheKey(req.body);
    if (!stream && cache.has(key)) {
      console.log('⚡ Cache hit for chat');
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

    // Handle streaming response
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

    // Handle non-streaming response
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    const fullBuffer = Buffer.concat(chunks);
    const responseText = fullBuffer.toString('utf-8');

    // Cache successful responses (if under 100KB)
    if (statusCode === 200 && fullBuffer.length < 100 * 1024) {
      try {
        const responseJson = JSON.parse(responseText);
        cache.set(key, responseJson);
        
        // Limit cache size
        if (cache.size > 500) {
          const firstKey = cache.keys().next().value;
          if (firstKey) cache.delete(firstKey);
        }
      } catch (e) {
        console.error('❌ Cache parse error:', e.message);
      }
    }

    // Send response
    res.status(statusCode);
    res.setHeader('Content-Type', headers['content-type'] || 'application/json');
    res.send(fullBuffer);

  } catch (error) {
    console.error('❌ Chat completions error:', error.message);
    res.status(500).json({
      error: {
        message: 'Internal server error',
        type: 'server_error',
        details: error.message
      }
    });
  }
});

/* ---------- Image Generation (DALL-E) ---------- */
app.post('/v1/images/generations', async (req, res) => {
  try {
    const { prompt, n = 1, size = '512x512', response_format = 'url' } = req.body;

    // Validate required fields
    if (!prompt || prompt.trim().length === 0) {
      return res.status(400).json({
        error: {
          message: 'Prompt is required for image generation',
          type: 'invalid_request_error'
        }
      });
    }

    // Validate image count
    const imageCount = Math.min(Math.max(parseInt(n), 1), 10);
    
    // Validate size
    const validSizes = ['256x256', '512x512', '1024x1024'];
    const imageSize = validSizes.includes(size) ? size : '512x512';

    // Prepare request body for OpenAI
    const openaiBody = {
      prompt: prompt.trim(),
      n: imageCount,
      size: imageSize,
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
        
        // Add metadata
        responseJson.metadata = {
          generated_at: new Date().toISOString(),
          model: 'dall-e-2',
          prompt_length: prompt.length
        };
        
        res.status(200).json(responseJson);
      } catch (e) {
        console.error('❌ JSON parse error:', e.message);
        res.status(500).json({
          error: {
            message: 'Failed to parse OpenAI response',
            type: 'parse_error'
          }
        });
      }
    } else {
      // Forward OpenAI error
      res.status(statusCode);
      res.setHeader('Content-Type', 'application/json');
      res.send(fullBuffer);
    }

  } catch (error) {
    console.error('❌ Image generation error:', error.message);
    res.status(500).json({
      error: {
        message: 'Internal server error during image generation',
        type: 'server_error',
        details: error.message
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
          message: 'Input is required for moderation',
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
    // Return a safe bypass response if moderation fails
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

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📝 OpenAI Key: ${OPENAI_KEY ? '✓ Configured' : '✗ Missing!'}`);
  console.log(`🤖 Allowed Models: ${ALLOWED_MODELS.join(', ')}`);
  console.log(`🔧 Maintenance Mode: ${MAINTENANCE_MODE ? 'ON' : 'OFF'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('👋 SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
