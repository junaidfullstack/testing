/* --------------------------- server.js (Render Optimized) --------------------------- */
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { createServer } from 'http';
import { request as undiciRequest } from 'undici';
import { v4 as uuidv4 } from 'uuid';
import { createWriteStream, unlinkSync, readdirSync, statSync, existsSync, mkdirSync, promises as fs } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import * as xlsx from 'xlsx';
import Tesseract from 'tesseract.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/* ---------- Config ---------- */
const PORT = process.env.PORT || 10000; // Render uses 10000
const NODE_ENV = process.env.NODE_ENV || 'production';
const MAINTENANCE_MODE = process.env.MAINTENANCE_MODE === 'true';
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ORGANIZATION = process.env.OPENAI_ORGANIZATION;

const MAX_INPUT_CHARS = Number(process.env.MAX_INPUT_CHARS || 8000);
const MAX_TOKENS_OUT = Number(process.env.MAX_TOKENS_OUT || 4000);
const DEFAULT_TEMP = Number(process.env.DEFAULT_TEMP || 0.7);

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
    fileSize: 10 * 1024 * 1024, // 10MB limit for Render free tier
    files: 3 // Max 3 files
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
      cb(new Error(`File type ${file.mimetype} not allowed. Supported: images, PDF, text`), false);
    }
  }
});

/* ---------- Express setup ---------- */
const app = express();

// Security and CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

/* ---------- Serve uploaded files ---------- */
app.use('/uploads', express.static(uploadDir, {
  maxAge: '1h',
  setHeaders: (res, path) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}));

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
      if (response.statusCode === 429) {
        console.log('⚠️ Rate limit hit, waiting...');
        await new Promise(r => setTimeout(r, delay * (i + 1) * 2));
        continue;
      }
      return response;
    } catch (err) {
      console.error(`🔁 Retry ${i + 1}/${retries}:`, err.message);
      if (i < retries - 1)
        await new Promise(r => setTimeout(r, delay * (i + 1)));
      else throw err;
    }
  }
}

function selectModelBasedOnRequest(reqBody) {
  const { model, messages, files } = reqBody;
  
  if (model) return model;
  
  const hasImages = messages?.some(msg => 
    Array.isArray(msg.content) && 
    msg.content.some(content => content.type === 'image_url')
  ) || files?.some(file => file.mimetype?.startsWith('image/'));
  
  if (hasImages) {
    return 'gpt-4-vision-preview';
  }
  
  const totalChars = messages?.reduce((sum, msg) => 
    sum + (typeof msg.content === 'string' ? msg.content.length : 0), 0) || 0;
  
  if (totalChars > 8000) {
    return 'gpt-4';
  }
  
  return 'gpt-3.5-turbo';
}

/* ---------- File Processing Functions ---------- */
async function extractTextFromPDF(filePath) {
  try {
    const dataBuffer = await fs.readFile(filePath);
    const data = await pdfParse(dataBuffer);
    return data.text || '[No text found in PDF]';
  } catch (error) {
    console.error('PDF extraction error:', error);
    return '[Failed to extract PDF text]';
  }
}

async function extractTextFromImage(filePath) {
  try {
    const { data: { text } } = await Tesseract.recognize(filePath, 'eng', {
      logger: m => console.log(m)
    });
    return text || '[No text found in image]';
  } catch (error) {
    console.error('OCR error:', error);
    return '[Failed to extract text from image]';
  }
}

async function extractTextFromWord(filePath) {
  try {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || '[No text found in Word document]';
  } catch (error) {
    console.error('Word extraction error:', error);
    return '[Failed to extract Word text]';
  }
}

async function extractTextFromExcel(filePath) {
  try {
    const workbook = xlsx.readFile(filePath);
    let text = '';
    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      text += xlsx.utils.sheet_to_csv(sheet) + '\n';
    });
    return text || '[No data found in Excel file]';
  } catch (error) {
    console.error('Excel extraction error:', error);
    return '[Failed to extract Excel data]';
  }
}

async function processFiles(files) {
  const processedFiles = [];
  
  for (const file of files) {
    try {
      const filePath = join(uploadDir, file.filename);
      let extractedText = '';
      
      if (file.mimetype.startsWith('image/')) {
        extractedText = await extractTextFromImage(filePath);
      } else if (file.mimetype.includes('pdf')) {
        extractedText = await extractTextFromPDF(filePath);
      } else if (file.mimetype.includes('word')) {
        extractedText = await extractTextFromWord(filePath);
      } else if (file.mimetype.includes('excel')) {
        extractedText = await extractTextFromExcel(filePath);
      } else if (file.mimetype.includes('text/plain')) {
        extractedText = await fs.readFile(filePath, 'utf-8');
      }
      
      processedFiles.push({
        fileName: file.originalname,
        fileUrl: `/uploads/${file.filename}`,
        mimeType: file.mimetype,
        extractedText: extractedText.substring(0, 2000),
        hasMoreText: extractedText.length > 2000
      });
    } catch (error) {
      console.error(`Error processing file ${file.originalname}:`, error);
      processedFiles.push({
        fileName: file.originalname,
        error: 'Failed to process file'
      });
    }
  }
  
  return processedFiles;
}

/* ---------- Routes ---------- */
app.get('/', (req, res) => {
  res.json({
    message: 'Chat AI Prime API',
    version: '2.0.0',
    endpoints: {
      chat: 'POST /v1/chat/completions',
      upload: 'POST /upload',
      health: 'GET /health',
      models: 'GET /v1/models'
    },
    environment: NODE_ENV,
    timestamp: new Date().toISOString()
  });
});

/* ---------- File Upload Endpoint ---------- */
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    
    let extractedText = '';
    const filePath = join(uploadDir, req.file.filename);
    
    if (req.file.mimetype.startsWith('image/')) {
      extractedText = await extractTextFromImage(filePath);
    } else if (req.file.mimetype.includes('pdf')) {
      extractedText = await extractTextFromPDF(filePath);
    } else if (req.file.mimetype.includes('text/plain')) {
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

/* ---------- Chat Completions with File Support ---------- */
app.post('/v1/chat/completions', upload.array('files', 3), async (req, res) => {
  try {
    if (!OPENAI_KEY) {
      return res.status(500).json({
        error: 'Server configuration error',
        message: 'OpenAI API key not configured'
      });
    }

    const body = JSON.parse(JSON.stringify(req.body));
    const files = req.files || [];
    
    // Select appropriate model
    const selectedModel = selectModelBasedOnRequest({
      ...body,
      files
    });
    
    // Process files if any
    let fileContext = '';
    if (files.length > 0) {
      const processedFiles = await processFiles(files);
      
      fileContext = processedFiles.map(file => 
        `[File: ${file.fileName}]\n${file.extractedText || 'No text extracted'}`
      ).join('\n\n');
      
      // For vision model
      if (selectedModel === 'gpt-4-vision-preview') {
        const imageFiles = files.filter(f => f.mimetype.startsWith('image/'));
        if (imageFiles.length > 0) {
          const lastUserMessageIndex = body.messages?.findLastIndex(msg => msg.role === 'user');
          if (lastUserMessageIndex !== -1) {
            const userMessage = body.messages[lastUserMessageIndex];
            if (typeof userMessage.content === 'string') {
              body.messages[lastUserMessageIndex].content = [
                { 
                  type: 'text', 
                  text: userMessage.content + (fileContext ? `\n\n${fileContext}` : '') 
                },
                ...imageFiles.map(file => ({
                  type: 'image_url',
                  image_url: {
                    url: `${req.protocol}://${req.get('host')}/uploads/${file.filename}`
                  }
                }))
              ];
            }
          }
        }
      } else {
        if (body.messages?.length > 0) {
          const lastUserMessageIndex = body.messages.findLastIndex(msg => msg.role === 'user');
          if (lastUserMessageIndex !== -1) {
            body.messages[lastUserMessageIndex].content += 
              (fileContext ? `\n\nFiles attached:\n${fileContext}` : '');
          }
        }
      }
    }
    
    // Prepare request
    body.model = selectedModel;
    body.messages = truncateMessages(body.messages || []);
    body.max_tokens = Math.min(body.max_tokens || 1000, MAX_TOKENS_OUT);
    body.temperature = body.temperature || DEFAULT_TEMP;
    
    // Check cache
    const key = cacheKey(body);
    if (cache.has(key)) {
      console.log('⚡ Cache hit');
      const cached = cache.get(key);
      return res.json({
        ...cached,
        cached: true,
        model_used: selectedModel
      });
    }

    // Call OpenAI
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`
      },
      body: JSON.stringify(body)
    };
    
    if (OPENAI_ORGANIZATION) {
      options.headers['OpenAI-Organization'] = OPENAI_ORGANIZATION;
    }

    const response = await callOpenAIWithRetry(
      'https://api.openai.com/v1/chat/completions',
      options
    );

    const chunks = [];
    for await (const c of response.body) chunks.push(c);
    const fullBuf = Buffer.concat(chunks);
    const txt = fullBuf.toString('utf-8');

    // Cache response
    if (response.statusCode === 200 && !body.stream && fullBuf.length < 100 * 1024) {
      try {
        const parsed = JSON.parse(txt);
        cache.set(key, parsed);
        if (cache.size > 500) {
          const firstKey = cache.keys().next().value;
          if (firstKey) cache.delete(firstKey);
        }
      } catch (e) {
        console.error('Cache parse error:', e);
      }
    }

    // Clean up files after 1 minute (async)
    setTimeout(() => {
      files.forEach(file => {
        try {
          unlinkSync(join(uploadDir, file.filename));
        } catch (e) {
          console.error('Failed to delete file:', e);
        }
      });
    }, 60000);

    // Send response
    res.status(response.statusCode);
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/json');
    res.setHeader('X-Model-Used', selectedModel);
    res.send(fullBuf);
    
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

/* ---------- Health Check ---------- */
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'Chat AI Prime API',
    version: '2.0.0',
    environment: NODE_ENV,
    cacheSize: cache.size,
    uploadDirSize: readdirSync(uploadDir).length
  });
});

/* ---------- Get Available Models ---------- */
app.get('/v1/models', async (req, res) => {
  try {
    if (!OPENAI_KEY) {
      return res.status(200).json({
        data: [
          { id: 'gpt-4', object: 'model' },
          { id: 'gpt-4-vision-preview', object: 'model' },
          { id: 'gpt-3.5-turbo', object: 'model' }
        ]
      });
    }

    const options = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`
      }
    };

    const response = await callOpenAIWithRetry(
      'https://api.openai.com/v1/models',
      options
    );

    const chunks = [];
    for await (const c of response.body) chunks.push(c);
    const fullBuf = Buffer.concat(chunks);
    
    res.status(response.statusCode);
    res.setHeader('Content-Type', response.headers['content-type'] || 'application/json');
    res.send(fullBuf);
    
  } catch (e) {
    console.error('Models error:', e);
    res.status(200).json({
      data: [
        { id: 'gpt-4', object: 'model' },
        { id: 'gpt-4-vision-preview', object: 'model' },
        { id: 'gpt-3.5-turbo', object: 'model' }
      ]
    });
  }
});

/* ---------- File Cleanup Job ---------- */
setInterval(() => {
  const now = Date.now();
  const maxAge = 1 * 60 * 60 * 1000; // 1 hour
  
  readdirSync(uploadDir).forEach(file => {
    const filePath = join(uploadDir, file);
    try {
      const stats = statSync(filePath);
      if (now - stats.mtimeMs > maxAge) {
        unlinkSync(filePath);
        console.log(`🧹 Cleaned up old file: ${file}`);
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
🤖 Supported models: GPT-4, GPT-4 Vision, GPT-3.5-Turbo
💾 Cache enabled: ${cache.size} entries
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