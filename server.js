const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Lấy thông tin nhạy cảm từ Environment Variables trên Render
const AUTH_API_URL = process.env.AUTH_API_URL;
const BACKUP_SCRIPT_URL = process.env.BACKUP_SCRIPT_URL;

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
    res.status(500).json({ success: false, message: "Lỗi kết nối Server Xác Thực" });
  }
});

// 2. API Khôi Phục Dữ Liệu Sau Lưu
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

// 3. API Upload Chunk (Đã Mã Hóa Tên Thành .dat)
app.post('/api/upload-chunk', upload.single('document'), async (req, res) => {
  try {
    const { token, chatId } = req.body;
    const file = req.file;

    if (!token || !chatId || !file) {
      return res.status(400).json({ success: false, message: "Thiếu dữ liệu" });
    }

    // Ép tên file thành dạng mã hóa .dat ẩn danh cho Telegram
    const datFileName = `data_chunk_${Date.now()}_${Math.floor(Math.random() * 10000)}.dat`;

    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('document', file.buffer, datFileName);

    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: 'POST',
      body: formData
    });

    const tgData = await tgRes.json();
    if (tgData.ok) {
      res.json({ success: true, file_id: tgData.result.document.file_id });
    } else {
      res.status(400).json({ success: false, message: tgData.description });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. API Tải File từ Telegram về Trình Duyệt (Giải quyết CORS & Stream Data)
app.get('/api/file-proxy', async (req, res) => {
  try {
    const { token, fileId } = req.query;
    
    // Lấy thông tin đường dẫn file từ Telegram API
    const infoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
    const infoData = await infoRes.json();

    if (!infoData.ok) return res.status(400).send("Không tìm thấy file");

    // Truyền luồng dữ liệu file về trực tiếp cho Client
    const fileUrl = `https://api.telegram.org/file/bot${token}/${infoData.result.file_path}`;
    const fileStream = await fetch(fileUrl);
    
    fileStream.body.pipe(res);
  } catch (err) {
    res.status(500).send("Lỗi tải file");
  }
});

// 5. API Lưu Sao Lưu Mới
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
app.listen(PORT, () => console.log(`Server đang chạy tại cổng ${PORT}`));
