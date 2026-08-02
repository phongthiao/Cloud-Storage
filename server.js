const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Đọc URL cấu hình bảo mật từ Biến môi trường trên Render
const AUTH_API_URL = process.env.AUTH_API_URL || "https://script.google.com/macros/s/AKfycbw-RDeNdYzo7dMnmMRUV2jLkUSCmIN5Fk87suroVvo_bYjyyO05HEKXUcPyf_RLQ_A/exec";
const BACKUP_SCRIPT_URL = process.env.BACKUP_SCRIPT_URL || "https://script.google.com/macros/s/AKfycbyMkD7y_bCC4l27JZgn5bzmWpch_ZTH208YzapDTw6nMIC4CXD9lUJJ2ccq3wqcsmhLeA/exec";

// 1. API Xác thực Đăng Nhập[cite: 5]
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

// 2. API Lấy Bản Sao Lưu[cite: 5]
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

// 3. API Upload Chunk (Đã Mã Hóa Ngụy Trang Đuôi Thành .dat)[cite: 5]
app.post('/api/upload-chunk', upload.single('document'), async (req, res) => {
  try {
    const { token, chatId } = req.body;
    const file = req.file;

    if (!token || !chatId || !file) {
      return res.status(400).json({ success: false, message: "Thiếu thông tin tải lên" });
    }

    // Ép đổi tên mảnh file thành định dạng .dat mã hóa khi tải lên Telegram
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
      res.status(400).json({ success: false, message: tgData.description || "Lỗi tải lên Telegram" });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. API Proxy Tải File / Ghép File từ Telegram (Đã sửa lỗi ép tải xuống, hỗ trợ hiển thị trực quan inline)
app.get('/api/file-proxy', async (req, res) => {
  try {
    const { token, fileId, filename } = req.query;
    if (!token || !fileId) return res.status(400).send("Thiếu tham số");

    const infoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const infoData = await infoRes.json();

    if (!infoData.ok) return res.status(400).send("Không lấy được link file");

    const fileUrl = `https://api.telegram.org/file/bot${token}/${infoData.result.file_path}`;
    const fileStream = await fetch(fileUrl);

    // Xác định kiểu MIME dựa trên phần mở rộng file (nếu có tên file truyền vào)
    let contentType = 'application/octet-stream';
    if (filename) {
      const ext = path.extname(filename).toLowerCase();
      const mimeTypes = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
        '.json': 'application/json; charset=utf-8'
      };
      if (mimeTypes[ext]) {
        contentType = mimeTypes[ext];
      }
    }

    // Thiết lập header cho phép hiển thị trực tiếp (inline) thay vì ép buộc tải về (attachment)
    res.setHeader('Content-Type', contentType);
    if (filename) {
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
    } else {
      res.setHeader('Content-Disposition', 'inline');
    }

    fileStream.body.pipe(res);
  } catch (err) {
    res.status(500).send("Lỗi tải luồng dữ liệu file");
  }
});

// 5. API Ghim CSDL lên Telegram[cite: 5]
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

// 6. API Xuất Sao Lưu Cloud Drive[cite: 5]
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
