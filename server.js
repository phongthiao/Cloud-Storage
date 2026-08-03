const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream');
const cron = require('node-cron');

const app = express();

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `chunk_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.dat`)
});
const upload = multer({ storage: storage, limits: { fileSize: 200 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const AUTH_API_URL = process.env.AUTH_API_URL || "https://script.google.com/macros/s/AKfycbw-RDeNdYzo7dMnmMRUV2jLkUSCmIN5Fk87suroVvo_bYjyyO05HEKXUcPyf_RLQ_A/exec";
const BACKUP_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyxpDyYr4IuQgWFTnQV6DDtrtWKDDjKiPYKjOSxgfL2PIDNCRNco5-v7OYux4wVFL-D/exec";

let SYSTEM_BOT_TOKEN = process.env.BOT_TOKEN || "";
let SYSTEM_CHAT_ID = process.env.CHAT_ID || "";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

cron.schedule('*/30 * * * *', () => {
  fs.readdir(uploadDir, (err, files) => {
    if (err) return;
    const now = Date.now();
    files.forEach(file => {
      const filePath = path.join(uploadDir, file);
      fs.stat(filePath, (err, stats) => {
        if (!err && now - stats.mtimeMs > 3600000) {
          fs.unlink(filePath, () => {});
        }
      });
    });
  });
});

app.post('/api/login', async (req, res) => {
  try {
    const response = await fetch(AUTH_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();

    if (data.success) {
      SYSTEM_BOT_TOKEN = data.token;
      SYSTEM_CHAT_ID = data.chatId;

      res.json({
        success: true,
        maxGb: data.maxGb || 5,
        mtb: req.body.mtb
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

app.post('/api/upload-chunk', upload.single('document'), async (req, res) => {
  const filePath = req.file ? req.file.path : null;
  try {
    const token = SYSTEM_BOT_TOKEN;
    const chatId = SYSTEM_CHAT_ID;

    if (!token || !chatId || !req.file) {
      return res.status(400).json({ success: false, message: "Thiếu dữ liệu upload hoặc Server chưa đăng nhập" });
    }

    let attempts = 0;
    let tgData = null;

    while (attempts < 5) {
      const formData = new FormData();
      formData.append('chat_id', chatId);
      formData.append('document', fs.createReadStream(filePath), req.file.originalname);

      const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: 'POST',
        body: formData
      });

      tgData = await tgRes.json();

      if (tgRes.status === 429 || (tgData && tgData.error_code === 429)) {
        const retryAfter = (tgData.parameters && tgData.parameters.retry_after) ? tgData.parameters.retry_after : 3;
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
  } finally {
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    }
  }
});

// Proxy lấy Chunk từ Telegram với Retry nội bộ
app.get('/api/file-proxy', async (req, res) => {
  try {
    const { fileId, filename } = req.query;
    const token = SYSTEM_BOT_TOKEN;

    if (!token || !fileId) return res.status(400).send("Thiếu thông số hoặc chưa đăng nhập");

    let infoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    let infoData = await infoRes.json();

    if (!infoData.ok) return res.status(400).send("Lỗi lấy thông tin file từ Telegram");

    const fileUrl = `https://api.telegram.org/file/bot${token}/${infoData.result.file_path}`;

    const fetchHeaders = {};
    if (req.headers.range) {
      fetchHeaders['Range'] = req.headers.range;
    }

    const fileStream = await fetch(fileUrl, { headers: fetchHeaders });

    if (!fileStream.ok) {
      return res.status(fileStream.status).send("Không thể kết nối Telegram CDN");
    }

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

    if (fileStream.headers.get('content-range')) {
      res.setHeader('Content-Range', fileStream.headers.get('content-range'));
    }
    if (fileStream.headers.get('content-length')) {
      res.setHeader('Content-Length', fileStream.headers.get('content-length'));
    }

    res.setHeader('Content-Disposition', filename ? `inline; filename="${encodeURIComponent(filename)}"` : 'inline');

    pipeline(fileStream.body, res, (err) => {
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error('Stream Proxy Error:', err);
      }
    });
  } catch (err) {
    res.status(500).send("Lỗi Stream dữ liệu");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
