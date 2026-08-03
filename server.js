const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const path = require('path');
const { pipeline } = require('stream');
const jwt = require('jsonwebtoken');

const app = express();

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_cloud_storage_key_2026';
const AUTH_API_URL = process.env.AUTH_API_URL || "https://script.google.com/macros/s/AKfycbw-RDeNdYzo7dMnmMRUV2jLkUSCmIN5Fk87suroVvo_bYjyyO05HEKXUcPyf_RLQ_A/exec";
const BACKUP_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyxpDyYr4IuQgWFTnQV6DDtrtWKDDjKiPYKjOSxgfL2PIDNCRNco5-v7OYux4wVFL-D/exec";

const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: 200 * 1024 * 1024 } 
});

app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ success: false, message: "Thiếu Session Token" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, message: "Session không hợp lệ" });
    req.user = user;
    next();
  });
};

app.post('/api/login', async (req, res) => {
  try {
    const response = await fetch(AUTH_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();

    if (data.success) {
      const sessionToken = jwt.sign({
        token: data.token || process.env.BOT_TOKEN || "",
        chatId: data.chatId || process.env.CHAT_ID || "",
        mtb: req.body.mtb
      }, JWT_SECRET, { expiresIn: '7d' });

      res.json({
        success: true,
        maxGb: data.maxGb || 5,
        mtb: req.body.mtb,
        sessionToken: sessionToken
      });
    } else {
      res.json(data);
    }
  } catch (err) {
    res.status(500).json({ success: false, message: "Lỗi hệ thống xác thực" });
  }
});

app.get('/api/backup', async (req, res) => {
  try {
    const { mtb } = req.query;
    const response = await fetch(`${BACKUP_SCRIPT_URL}?mtb=${encodeURIComponent(mtb)}&t=${Date.now()}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Lỗi tải bản sao lưu" });
  }
});

app.post('/api/save-backup', async (req, res) => {
  try {
    const response = await fetch(BACKUP_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/upload-chunk', authenticateToken, upload.single('document'), async (req, res) => {
  try {
    const { token, chatId } = req.user;
    if (!token || !chatId || !req.file) return res.status(400).json({ success: false, message: "Thiếu dữ liệu" });

    let attempts = 0;
    let tgData = null;

    while (attempts < 5) {
      const formData = new FormData();
      formData.append('chat_id', chatId);
      formData.append('document', req.file.buffer, { filename: req.file.originalname });

      const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: 'POST',
        body: formData
      });

      tgData = await tgRes.json();

      if (tgRes.status === 429 || (tgData && tgData.error_code === 429)) {
        const retryAfter = (tgData.parameters && tgData.parameters.retry_after) ? tgData.parameters.retry_after : 2;
        await sleep((retryAfter + 1) * 1000);
        attempts++;
      } else {
        break;
      }
    }

    if (tgData && tgData.ok && tgData.result.document) {
      res.json({ success: true, file_id: tgData.result.document.file_id });
    } else {
      res.status(400).json({ success: false, message: tgData ? tgData.description : "Lỗi Telegram API" });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Proxy truyền dữ liệu tối ưu băng thông và Stream trực tiếp
app.get('/api/file-proxy', authenticateToken, async (req, res) => {
  try {
    const { fileId, filename } = req.query;
    const { token } = req.user;

    if (!token || !fileId) return res.status(400).send("Thiếu thông số");

    const infoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const infoData = await infoRes.json();

    if (!infoData.ok) return res.status(400).send("Không lấy được File ID từ Telegram");

    const fileUrl = `https://api.telegram.org/file/bot${token}/${infoData.result.file_path}`;

    const fetchHeaders = {};
    if (req.headers.range) fetchHeaders['Range'] = req.headers.range;

    const fileStream = await fetch(fileUrl, { headers: fetchHeaders });

    if (!fileStream.ok) return res.status(fileStream.status).send("Lỗi Telegram CDN");

    let contentType = 'application/octet-stream';
    if (filename) {
      const ext = path.extname(filename).toLowerCase();
      const mimeTypes = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
        '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf', 
        '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8'
      };
      if (mimeTypes[ext]) contentType = mimeTypes[ext];
    }

    res.status(fileStream.status);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache tối ưu tốc độ

    if (fileStream.headers.get('content-range')) {
      res.setHeader('Content-Range', fileStream.headers.get('content-range'));
    }
    if (fileStream.headers.get('content-length')) {
      res.setHeader('Content-Length', fileStream.headers.get('content-length'));
    }

    res.setHeader('Content-Disposition', filename ? `inline; filename="${encodeURIComponent(filename)}"` : 'inline');

    // Pipe luồng dữ liệu trực tiếp ngắt kết nối khi Client Abort
    const streamPipeline = pipeline(fileStream.body, res, (err) => {
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error('Stream Error:', err.message);
      }
    });

    req.on('close', () => {
      if (fileStream.body && typeof fileStream.body.destroy === 'function') {
        fileStream.body.destroy();
      }
    });

  } catch (err) {
    res.status(500).send("Lỗi Stream dữ liệu");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
