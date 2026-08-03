const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const path = require('path');
const { pipeline } = require('stream');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const AUTH_API_URL = process.env.AUTH_API_URL || "https://script.google.com/macros/s/AKfycbw-RDeNdYzo7dMnmMRUV2jLkUSCmIN5Fk87suroVvo_bYjyyO05HEKXUcPyf_RLQ_A/exec";
// URL Web App Google Sheet Mới Của Bạn:
const BACKUP_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyxpDyYr4IuQgWFTnQV6DDtrtWKDDjKiPYKjOSxgfL2PIDNCRNco5-v7OYux4wVFL-D/exec";

// 1. API Đăng Nhập
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

// 2. API Lấy Danh Sách Bản Sao Lưu Từ Google Sheet
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

// 3. API Lưu Bản Sao Lưu Vào Google Sheet
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

// 4. API Upload Chunk Tệp Lên Telegram Bot
app.post('/api/upload-chunk', upload.single('document'), async (req, res) => {
  try {
    const { token, chatId } = req.body;
    const file = req.file;

    if (!token || !chatId || !file) {
      return res.status(400).json({ success: false, message: "Thiếu dữ liệu upload" });
    }

    const datFileName = `data_chunk_${Date.now()}_${Math.floor(Math.random() * 10000)}.dat`;
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('document', file.buffer, datFileName);

    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: 'POST',
      body: formData
    });

    const tgData = await tgRes.json();
    if (tgData.ok && tgData.result.document) {
      res.json({ success: true, file_id: tgData.result.document.file_id });
    } else {
      res.status(400).json({ success: false, message: tgData.description || "Lỗi Telegram" });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 5. API Proxy Tải File từ Telegram
app.get('/api/file-proxy', async (req, res) => {
  try {
    const { token, fileId, filename } = req.query;
    if (!token || !fileId) return res.status(400).send("Thiếu thông số");

    const infoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const infoData = await infoRes.json();

    if (!infoData.ok) return res.status(400).send("Lỗi lấy thông tin file");

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

// 6. API Ghim CSDL Lên Telegram
app.post('/api/pin-db', async (req, res) => {
  try {
    const { token, chatId, mtb, dbData } = req.body;
    const blob = Buffer.from(JSON.stringify(dbData));

    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('document', blob, `database_${mtb}.json`);

    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: 'POST',
      body: formData
    });

    const tgData = await tgRes.json();
    if (tgData.ok && tgData.result.message_id) {
      await fetch(`https://api.telegram.org/bot${token}/pinChatMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: tgData.result.message_id,
          disable_notification: true
        })
      });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server chạy tại cổng ${PORT}`));
