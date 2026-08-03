const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream');

const app = express();

// Khởi tạo thư mục tạm để lưu file, tránh lưu trực tiếp trên RAM (memoryStorage) gây sập Render
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

// Hàm hỗ trợ Sleep chống Rate Limit
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 1. API Đăng nhập
app.post('/api/login', async (req, res) => {
  try {
    const response = await fetch(AUTH_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, message: "Lỗi hệ thống xác thực" });
  }
});

// 2. API Lấy Bản Sao Lưu từ Sheet
app.get('/api/backup', async (req, res) => {
  try {
    const { mtb } = req.query;
    const response = await fetch(`${BACKUP_SCRIPT_URL}?mtb=${encodeURIComponent(mtb)}&t=${Date.now()}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Lỗi tải bản sao lưu từ Sheet" });
  }
});

// 3. API Lưu Bản Sao Lưu vào Sheet
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

// 4. API Upload Chunk (Chống Tràn RAM + Xử Lý Lỗi 429 Retry-After)
app.post('/api/upload-chunk', upload.single('document'), async (req, res) => {
  const filePath = req.file ? req.file.path : null;
  try {
    const { token, chatId } = req.body;
    if (!token || !chatId || !req.file) {
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return res.status(400).json({ success: false, message: "Thiếu dữ liệu upload" });
    }

    let attempts = 0;
    let tgData = null;

    while (attempts < 3) {
      const formData = new FormData();
      formData.append('chat_id', chatId);
      formData.append('document', fs.createReadStream(filePath), req.file.originalname);

      const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: 'POST',
        body: formData
      });

      tgData = await tgRes.json();

      // Nếu gặp lỗi Rate Limit 429
      if (tgRes.status === 429 || (tgData && tgData.error_code === 429)) {
        const retryAfter = (tgData.parameters && tgData.parameters.retry_after) ? tgData.parameters.retry_after : 3;
        console.warn(`[Rate Limit 429] Telegram yêu cầu đợi ${retryAfter} giây...`);
        await sleep((retryAfter + 1) * 1000);
        attempts++;
      } else {
        break; // Tải lên thành công hoặc lỗi khác
      }
    }

    // Xóa file tạm sau khi gửi xong
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);

    if (tgData && tgData.ok && tgData.result.document) {
      res.json({ success: true, file_id: tgData.result.document.file_id });
    } else {
      res.status(400).json({ success: false, message: tgData ? tgData.description : "Lỗi Telegram" });
    }

  } catch (err) {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. API Proxy Tải File Stream
app.get('/api/file-proxy', async (req, res) => {
  try {
    const { token, fileId, filename } = req.query;
    if (!token || !fileId) return res.status(400).send("Thiếu thông số");

    const infoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const infoData = await infoRes.json();

    if (!infoData.ok) return res.status(400).send("Lỗi lấy thông tin file từ Telegram");

    const fileUrl = `https://api.telegram.org/file/bot${token}/${infoData.result.file_path}`;
    const fileStream = await fetch(fileUrl);

    let contentType = 'application/octet-stream';
    if (filename) {
      const ext = path.extname(filename).toLowerCase();
      const mimeTypes = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
        '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm',
        '.mp3': 'audio/mpeg', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
        '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8'
      };
      if (mimeTypes[ext]) contentType = mimeTypes[ext];
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', filename ? `inline; filename="${encodeURIComponent(filename)}"` : 'inline');

    pipeline(fileStream.body, res, (err) => {
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error('Stream Error:', err);
      }
    });
  } catch (err) {
    res.status(500).send("Lỗi Stream dữ liệu");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server chạy mượt tại cổng ${PORT}`));
