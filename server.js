/* --------------------------- server.js (Complete with Moderations) --------------------------- */
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { createServer } from 'http';
import { unlinkSync, readdirSync, statSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/* ---------- Config ---------- */
const PORT = process.env.PORT || 10000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const OPENAI_KEY = process.env.OPENAI_API_KEY;

const MAX_TOKENS_OUT = 4000;
const DEFAULT_TEMP = 0.7;

// Create uploads directory
const uploadDir = join(__dirname, 'uploads');
if (!existsSync(uploadDir)) {
  mkdirSync(uploadDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 3
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'application/pdf',
      'text/plain'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not supported: ${file.mimetype}`), false);
    }
  }
});

/* ---------- Express setup ---------- */
const app = express();

// CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

/* ---------- Serve uploaded files ---------- */
app.use('/uploads', express.static(uploadDir));

/* ---------- Routes ---------- */
app.get('/', (req, res) => {
  res.json({
    message: 'Chat AI Prime API',
    version: '2.0.0',
    endpoints: {
      chat: 'POST /v1/chat/completions',
      moderations: 'POST /v1/moderations',
      completions: 'POST /v1/completions',
      upload: 'POST /upload',
      health: 'GET /health',
      models: 'GET /v1/models'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'Chat AI Prime API',
    environment: NODE_ENV
  });
});

/* ---------- File Upload ---------- */
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    
    // Extract text from text files
    let extractedText = '';
    if (req.file.mimetype.includes('text/plain')) {
      const fs = await import('fs/promises');
      const filePath = join(uploadDir, req.file.filename);
      extractedText = await fs.readFile(filePath, 'utf-8');
    }

    res.json({
      success: true,
      url: fileUrl,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      extractedText: extractedText.substring(0, 2000),
      fullTextAvailable: extractedText.length > 2000
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      error: 'Upload failed', 
      message: error.message 
    });
  }
});

/* ---------- Chat Completions ---------- */
app.post('/v1/chat/completions', upload.array('files', 3), async (req, res) => {
  try {
    if (!OPENAI_KEY) {
      return res.status(500).json({
        error: 'Server configuration error',
        message: 'OpenAI API key not configured'
      });
    }

    const body = req.body;
    const files = req.files || [];
    
    // Process files
    let fileContext = '';
    if (files.length > 0) {
      fileContext = files.map(file => {
        let info = `[File: ${file.originalname}, Type: ${file.mimetype}, Size: ${file.size} bytes]`;
        
        // For images, note that OCR is not available
        if (file.mimetype.startsWith('image/')) {
          info += '\n[Image file - visual content]';
        }
        
        return info;
      }).join('\n\n');
    }

    // Prepare messages
    const messages = body.messages || [];
    if (fileContext && messages.length > 0) {
      const lastUserIndex = messages.length - 1;
      if (typeof messages[lastUserIndex].content === 'string') {
        messages[lastUserIndex].content += `\n\n${fileContext}`;
      }
    }

    // Call OpenAI using native fetch
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: body.model || 'gpt-3.5-turbo',
        messages: messages,
        temperature: body.temperature || DEFAULT_TEMP,
        max_tokens: Math.min(body.max_tokens || 1000, MAX_TOKENS_OUT),
        stream: false
      })
    });

    const result = await response.json();

    // Clean up files after 30 seconds
    setTimeout(() => {
      files.forEach(file => {
        try {
          unlinkSync(join(uploadDir, file.filename));
        } catch (e) {
          console.error('Failed to delete file:', e);
        }
      });
    }, 30000);

    res.status(response.status).json(result);

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

/* ---------- Moderations Endpoint ---------- */
app.post('/v1/moderations', async (req, res) => {
  try {
    if (!OPENAI_KEY) {
      // If no OpenAI key, return safe bypass
      return res.json({
        bypassed: true,
        message: 'Moderation temporarily unavailable — continuing safely.'
      });
    }

    const body = req.body;

    // Call OpenAI Moderation API
    const response = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify(body)
    });

    if (response.ok) {
      const result = await response.json();
      res.json(result);
    } else {
      // If moderation fails, return safe bypass
      res.json({
        bypassed: true,
        message: 'Moderation temporarily unavailable — continuing safely.'
      });
    }

  } catch (error) {
    console.error('Moderation error:', error);
    // Always return safe response on error
    res.json({
      bypassed: true,
      message: 'Moderation temporarily unavailable — continuing safely.'
    });
  }
});

/* ---------- Completions Endpoint (Legacy) ---------- */
app.post('/v1/completions', async (req, res) => {
  try {
    if (!OPENAI_KEY) {
      return res.status(500).json({
        error: 'Server configuration error',
        message: 'OpenAI API key not configured'
      });
    }

    const body = req.body;

    // Call OpenAI Completions API
    const response = await fetch('https://api.openai.com/v1/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify({
        model: body.model || 'text-davinci-003',
        prompt: body.prompt || '',
        temperature: body.temperature || DEFAULT_TEMP,
        max_tokens: Math.min(body.max_tokens || 1000, MAX_TOKENS_OUT)
      })
    });

    const result = await response.json();
    res.status(response.status).json(result);

  } catch (error) {
    console.error('Completions error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

/* ---------- Get Models Endpoint ---------- */
app.get('/v1/models', async (req, res) => {
  try {
    if (!OPENAI_KEY) {
      // Return default models if no API key
      return res.json({
        data: [
          { id: 'gpt-4', object: 'model' },
          { id: 'gpt-4-vision-preview', object: 'model' },
          { id: 'gpt-3.5-turbo', object: 'model' },
          { id: 'text-davinci-003', object: 'model' }
        ]
      });
    }

    const response = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`
      }
    });

    if (response.ok) {
      const result = await response.json();
      res.json(result);
    } else {
      // Fallback to default models
      res.json({
        data: [
          { id: 'gpt-4', object: 'model' },
          { id: 'gpt-4-vision-preview', object: 'model' },
          { id: 'gpt-3.5-turbo', object: 'model' },
          { id: 'text-davinci-003', object: 'model' }
        ]
      });
    }

  } catch (error) {
    console.error('Models error:', error);
    res.json({
      data: [
        { id: 'gpt-4', object: 'model' },
        { id: 'gpt-4-vision-preview', object: 'model' },
        { id: 'gpt-3.5-turbo', object: 'model' },
        { id: 'text-davinci-003', object: 'model' }
      ]
    });
  }
});

/* ---------- File Cleanup ---------- */
setInterval(() => {
  const now = Date.now();
  const maxAge = 1 * 60 * 60 * 1000; // 1 hour
  
  readdirSync(uploadDir).forEach(file => {
    const filePath = join(uploadDir, file);
    try {
      const stats = statSync(filePath);
      if (now - stats.mtimeMs > maxAge) {
        unlinkSync(filePath);
        console.log(`Cleaned up: ${file}`);
      }
    } catch (e) {
      console.error(`Failed to clean up ${file}:`, e);
    }
  });
}, 30 * 60 * 1000); // Run every 30 minutes

/* ---------- Error Handling ---------- */
app.use((err, req, res, next) => {
  console.error(err.stack);
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        error: 'File too large',
        message: 'File size must be less than 10MB'
      });
    }
  }
  
  res.status(500).json({
    error: 'Internal server error',
    message: NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

/* ---------- 404 Handler ---------- */
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: `Cannot ${req.method} ${req.url}`
  });
});

/* ---------- Start Server ---------- */
const server = createServer(app);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
🚀 Chat AI Prime Server Started!
📍 Environment: ${NODE_ENV}
📡 Port: ${PORT}
🌍 URL: http://0.0.0.0:${PORT}
📁 Uploads: ${uploadDir}
✅ Health: http://localhost:${PORT}/health
📋 Endpoints:
   - POST /v1/chat/completions
   - POST /v1/moderations
   - POST /v1/completions
   - POST /upload
   - GET /v1/models
   - GET /health
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
