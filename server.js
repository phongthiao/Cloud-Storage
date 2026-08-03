const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const { pipeline } = require('stream');

const app = express();

// Cấu hình Multer lưu đĩa tạm thời
const upload = multer({ dest: '/tmp/' });

app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// HẰNG SỐ & BIẾN TOÀN CỤC
const AUTH_API_URL = process.env.AUTH_API_URL || "https://script.google.com/macros/s/AKfycbw-RDeNdYzo7dMnmMRUV2jLkUSCmIN5Fk87suroVvo_bYjyyO05HEKXUcPyf_RLQ_A/exec";
const BACKUP_SCRIPT_URL = process.env.BACKUP_SCRIPT_URL || "https://script.google.com/macros/s/AKfycb0EdS-qSOA2PpemKa2sdZ4QghxdikvXreCvuWwAfK_Q-nIGDg-9No0qLHfiLb3kyWFbQ/exec";

let pinnedDbMessageId = null;

// Hàm An Toàn Xóa File Tạm
function safeUnlink(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlink(filePath, (err) => {
      if (err) console.error(`[FS Unlink Error] Không thể xóa file tạm ${filePath}:`, err);
    });
  }
}

// Hàm Bắt Lỗi 429 Rate Limit & Tự động Retry với AxIoS
async function requestTelegramWithRetry(url, method = 'GET', data = null, headers = {}, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await axios({
        url,
        method,
        data,
        headers,
        validateStatus: () => true // Không ném Exception nếu status >= 400
      });

      const resData = response.data;

      if (response.status === 429 || (resData && !resData.ok && resData.error_code === 429)) {
        const retryAfter = (resData.parameters && resData.parameters.retry_after) ? resData.parameters.retry_after : 3;
        console.warn(`[Telegram Rate Limit 429] Tạm dừng (sleep) ${retryAfter}s trước khi gửi lại...`);
        await new Promise(resolve => setTimeout(resolve, (retryAfter + 1) * 1000));
        continue;
      }

      return resData;
    } catch (err) {
      if (attempt === maxRetries - 1) throw err;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  throw new Error("Vượt quá số lần thử lại Telegram API do Rate Limit.");
}

// 1. API Xác thực Đăng Nhập
app.post('/api/login', async (req, res, next) => {
  try {
    const response = await axios.post(AUTH_API_URL, req.body, {
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }
    });
    res.json(response.data);
  } catch (err) {
    next(err);
  }
});

// 2. API Lấy Bản Sao Lưu từ Google Sheet
app.get('/api/backup', async (req, res, next) => {
  try {
    const { mtb } = req.query;
    if (!mtb) return res.status(400).json({ error: "Thiếu mã thiết bị (mtb)" });

    const response = await axios.get(`${BACKUP_SCRIPT_URL}?mtb=${encodeURIComponent(mtb)}&t=${Date.now()}`);
    res.json(response.data);
  } catch (err) {
    next(err);
  }
});

// 3. API Upload Chunk (Tối ưu RAM & Xóa Đĩa Tạm Chuẩn)
app.post('/api/upload-chunk', upload.single('document'), async (req, res) => {
  const file = req.file;
  
  try {
    const { token, chatId } = req.body;

    if (!token || !chatId || !file) {
      if (file) safeUnlink(file.path);
      return res.status(400).json({ success: false, message: "Thiếu thông tin tải lên" });
    }

    const datFileName = `data_chunk_${Date.now()}_${Math.floor(Math.random() * 10000)}.dat`;
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('document', fs.createReadStream(file.path), datFileName);

    const tgData = await requestTelegramWithRetry(
      `https://api.telegram.org/bot${token}/sendDocument`,
      'POST',
      formData,
      formData.getHeaders()
    );

    safeUnlink(file.path);

    if (tgData && tgData.ok && tgData.result && tgData.result.document) {
      return res.json({ success: true, file_id: tgData.result.document.file_id });
    } else {
      return res.status(400).json({ 
        success: false, 
        message: (tgData && tgData.description) ? tgData.description : "Lỗi tải lên Telegram" 
      });
    }
  } catch (err) {
    if (file) safeUnlink(file.path);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// 4. API Proxy Tải File từ Telegram (Luồng Stream Direct Pipeline)
app.get('/api/file-proxy', async (req, res, next) => {
  try {
    const { token, fileId, filename } = req.query;
    if (!token || !fileId) return res.status(400).send("Thiếu tham số");

    const infoData = await requestTelegramWithRetry(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);

    if (!infoData || !infoData.ok) return res.status(400).send("Không lấy được link file từ Telegram");

    const fileUrl = `https://api.telegram.org/file/bot${token}/${infoData.result.file_path}`;
    
    const streamResponse = await axios({
      method: 'GET',
      url: fileUrl,
      responseType: 'stream'
    });

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

    pipeline(streamResponse.data, res, (err) => {
      if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        console.error('Lỗi đường ống truyền tải Stream Proxy:', err);
      }
    });
  } catch (err) {
    next(err);
  }
});

// 5. API Lưu CSDL lên Telegram (Chỉnh sửa tin nhắn cố định - Edit Message)
app.post('/api/pin-db', async (req, res, next) => {
  try {
    const { token, chatId, mtb, dbData, msgId } = req.body;
    if (!token || !chatId || !mtb) return res.status(400).json({ success: false, message: "Thiếu dữ liệu" });

    const blob = Buffer.from(JSON.stringify(dbData || []));
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

      const editRes = await requestTelegramWithRetry(
        `https://api.telegram.org/bot${token}/editMessageMedia`,
        'POST',
        formData,
        formData.getHeaders()
      );

      if (editRes && editRes.ok) {
        return res.json({ success: true, msgId: targetMsgId, updated: true });
      }
    }

    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('document', blob, `database_${mtb}.json`);

    const tgData = await requestTelegramWithRetry(
      `https://api.telegram.org/bot${token}/sendDocument`,
      'POST',
      formData,
      formData.getHeaders()
    );

    if (tgData && tgData.ok && tgData.result && tgData.result.message_id) {
      pinnedDbMessageId = tgData.result.message_id;
      return res.json({ success: true, msgId: pinnedDbMessageId, updated: false });
    }

    return res.status(400).json({ success: false, message: "Không thể lưu CSDL lên Telegram" });
  } catch (err) {
    next(err);
  }
});

// 6. API Xuất Sao Lưu Cloud Sheeet
app.post('/api/save-backup', async (req, res, next) => {
  try {
    await axios.post(BACKUP_SCRIPT_URL, req.body, {
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// MIDDLEWARE XỬ LÝ LỖI TẬP TRUNG (GLOBAL ERROR HANDLER)
app.use((err, req, res, next) => {
  console.error('[Unhandled Server Error]:', err.stack || err.message);
  res.status(500).json({
    success: false,
    message: err.message || "Lỗi máy chủ nội bộ"
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server Render đang chạy tại port ${PORT}`));
