const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream');

const app = express();

// 1. Dùng diskStorage lưu tạm vào đĩa /tmp/ thay vì RAM (MemoryStorage)
const upload = multer({ dest: '/tmp/' });

app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const AUTH_API_URL = process.env.AUTH_API_URL || "https://script.google.com/macros/s/AKfycbw-RDeNdYzo7dMnmMRUV2jLkUSCmIN5Fk87suroVvo_bYjyyO05HEKXUcPyf_RLQ_A/exec";

// 🛑 ĐÃ CẬP NHẬT ĐƯỜNG DẪN APPS SCRIPT DỰ PHÒNG GOOGLE SHEET MỚI
const BACKUP_SCRIPT_URL = process.env.BACKUP_SCRIPT_URL || "https://script.google.com/macros/s/AKfycby1cykTfz4jerGHDsm8Udjco2EfZMbDYTQ8PTDjXXjyQmDRAejx1N5vA-jKpnmLupqlBw/exec";

// Lưu giữ ID của tin nhắn CSDL cố định để thực hiện sửa tin nhắn (Edit Message)
let pinnedDbMessageId = null;

// Hàm Bắt Lỗi 429 Rate Limit & Tự động Sleep (retry_after)
async function fetchTelegramWithRetry(url, options, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    const res = await fetch(url, options);
    const data = await res.json();

    if (res.status === 429 || (data && !data.ok && data.error_code === 429)) {
      const retryAfter = (data.parameters && data.parameters.retry_after) ? data.parameters.retry_after : 3;
      console.warn(`[Telegram Rate Limit 429] Cảnh báo gửi quá nhanh. Đang tạm dừng (sleep) ${retryAfter}s trước khi gửi lại...`);
      await new Promise(resolve => setTimeout(resolve, (retryAfter + 1) * 1000));
      continue; // Thử lại request
    }

    return data;
  }
  throw new Error("Vượt quá số lần thử lại Telegram API do Rate Limit.");
}

// 1. API Xác thực Đăng Nhập
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
    res.status(500).json({ success: false, message: "Lỗi xác thực từ Server" });
  }
});

// 2. API Lấy Bản Sao Lưu từ Google Sheet
app.get('/api/backup', async (req, res) => {
  try {
    const { mtb } = req.query;
    const response = await fetch(`${BACKUP_SCRIPT_URL}?mtb=${encodeURIComponent(mtb)}&t=${Date.now()}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Lỗi lấy bản sao lưu" });
  }
});

// 3. API Upload Chunk (Đã tối ưu RAM < 80MB & Tự động xóa file tạm fs.unlinkSync)
app.post('/api/upload-chunk', upload.single('document'), async (req, res) => {
  try {
    const { token, chatId } = req.body;
    const file = req.file;

    if (!token || !chatId || !file) {
      if (file && file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return res.status(400).json({ success: false, message: "Thiếu thông tin tải lên" });
    }

    const datFileName = `data_chunk_${Date.now()}_${Math.floor(Math.random() * 10000)}.dat`;
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('document', fs.createReadStream(file.path), datFileName);

    const tgData = await fetchTelegramWithRetry(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: 'POST',
      body: formData
    });

    if (file && file.path && fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }

    if (tgData.ok && tgData.result.document) {
      res.json({ success: true, file_id: tgData.result.document.file_id });
    } else {
      res.status(400).json({ success: false, message: tgData.description || "Lỗi tải lên Telegram" });
    }
  } catch (err) {
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. API Proxy Tải File từ Telegram
app.get('/api/file-proxy', async (req, res) => {
  try {
    const { token, fileId, filename } = req.query;
    if (!token || !fileId) return res.status(400).send("Thiếu tham số");

    const infoData = await fetchTelegramWithRetry(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);

    if (!infoData.ok) return res.status(400).send("Không lấy được link file");

    const fileUrl = `https://api.telegram.org/file/bot${token}/${infoData.result.file_path}`;
    const fileStream = await fetch(fileUrl);

    let contentType = 'application/octet-stream';
    if (filename) {
      const ext = path.extname(filename).toLowerCase();
      const mimeTypes = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
        '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
        '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8'
      };
      if (mimeTypes[ext]) contentType = mimeTypes[ext];
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', filename ? `inline; filename="${encodeURIComponent(filename)}"` : 'inline');

    pipeline(fileStream.body, res, (err) => {
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error('Lỗi đường ống truyền tải Stream:', err);
      }
    });
  } catch (err) {
    res.status(500).send("Lỗi tải luồng dữ liệu file");
  }
});

// 5. API Lưu CSDL lên Telegram (Chỉnh sửa tin nhắn cố định - Edit Message)
app.post('/api/pin-db', async (req, res) => {
  try {
    const { token, chatId, mtb, dbData, msgId } = req.body;
    const blob = Buffer.from(JSON.stringify(dbData));
    const targetMsgId = msgId || pinnedDbMessageId;

    if (targetMsgId) {
      const formData = new FormData();
      formData.append('chat_id', chatId);
      formData.append('message_id', targetMsgId);
      formData.append('media', JSON.stringify({
        type: 'document',
        media: `attach://database_${mtb}.json`
      }));
      formData.append(`database_${mtb}.json`, blob, `database_${mtb}.json`);

      const editRes = await fetchTelegramWithRetry(`https://api.telegram.org/bot${token}/editMessageMedia`, {
        method: 'POST',
        body: formData
      });

      if (editRes.ok) {
        return res.json({ success: true, msgId: targetMsgId, updated: true });
      }
    }

    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('document', blob, `database_${mtb}.json`);

    const tgData = await fetchTelegramWithRetry(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: 'POST',
      body: formData
    });

    if (tgData.ok && tgData.result.message_id) {
      pinnedDbMessageId = tgData.result.message_id;
      res.json({ success: true, msgId: pinnedDbMessageId, updated: false });
    } else {
      res.status(400).json({ success: false });
    }
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// 6. API Xuất Sao Lưu Cloud Sheet
app.post('/api/save-backup', async (req, res) => {
  try {
    await fetch(BACKUP_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server Render đang chạy tại port ${PORT}`));
