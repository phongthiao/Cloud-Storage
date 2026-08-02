const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Phục vụ tệp tĩnh giao diện ở thư mục public
app.use(express.static(path.join(__dirname, 'public')));

// Đọc cấu hình từ Biến môi trường (Environment Variables)
const DATA_CLOUD_URL = process.env.DATA_CLOUD_URL || "https://docs.google.com/spreadsheets/d/e/2PACX-1vS7iLGeDWa7Yarmlwyt51YQkyvTAFQYO591BxiFnGR_QFCAqIP-OSUH_mzEZcZZOQ_9EJX-5sXKjOCd/pub?output=csv";
const BACKUP_SCRIPT_URL = process.env.BACKUP_SCRIPT_URL || "https://script.google.com/macros/s/AKfycbyMkD7y_bCC4l27JZgn5bzmWpch_ZTH208YzapDTw6nMIC4CXD9lUJJ2ccq3wqcsmhLeA/exec";

// Hàm xử lý CSV chuẩn
function parseCSV(text) {
  const lines = text.split(/\r\n|\n/);
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const row = [];
    let insideQuote = false;
    let entry = '';
    for (let j = 0; j < lines[i].length; j++) {
      const char = lines[i][j];
      if (char === '"') {
        insideQuote = !insideQuote;
      } else if (char === ',' && !insideQuote) {
        row.push(entry.trim());
        entry = '';
      } else {
        entry += char;
      }
    }
    row.push(entry.trim());
    result.push(row);
  }
  return result;
}

// 1. API Xác thực đăng nhập
app.post('/api/login', async (req, res) => {
  const { mtb, mk } = req.body;
  if (!mtb || !mk) {
    return res.status(400).json({ success: false, message: "Thành phần đăng nhập không hợp lệ!" });
  }

  try {
    const response = await axios.get(`${DATA_CLOUD_URL}&t=${Date.now()}`);
    const rows = parseCSV(response.data);

    let userFound = null;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.length >= 2) {
        const csvMTB = row[0].replace(/^"/, '').replace(/"$/, '').trim().toUpperCase();
        const csvMK = row[1].replace(/^"/, '').replace(/"$/, '').trim();

        if (csvMTB === mtb.toUpperCase() && csvMK === mk) {
          userFound = {
            mtb: csvMTB,
            token: row[2] ? row[2].replace(/^"/, '').replace(/"$/, '').trim() : '',
            chatId: row[3] ? row[3].replace(/^"/, '').replace(/"$/, '').trim() : '',
            maxGb: (row[4] && !isNaN(parseFloat(row[4]))) ? parseFloat(row[4].trim()) : 100
          };
          break;
        }
      }
    }

    if (userFound) {
      return res.json({ success: true, user: userFound });
    } else {
      return res.status(401).json({ success: false, message: "Sai Mã thiết bị hoặc Mật khẩu!" });
    }
  } catch (error) {
    console.error("Lỗi xác thực:", error.message);
    return res.status(500).json({ success: false, message: "Lỗi kết nối máy chủ dữ liệu!" });
  }
});

// 2. API Proxy đọc danh sách Bản sao lưu từ Apps Script
app.get('/api/backups', async (req, res) => {
  const { mtb } = req.query;
  if (!mtb) return res.status(400).json({ error: "Thiếu tham số MTB" });

  try {
    const response = await axios.get(`${BACKUP_SCRIPT_URL}?mtb=${encodeURIComponent(mtb)}&t=${Date.now()}`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: "Lỗi lấy bản sao lưu" });
  }
});

// 3. API Proxy ghi Bản sao lưu lên Apps Script
app.post('/api/backups', async (req, res) => {
  try {
    await axios.post(BACKUP_SCRIPT_URL, req.body, {
      headers: { 'Content-Type': 'application/json' }
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Lỗi ghi bản sao lưu" });
  }
});

// 4. API Proxy tải file mảnh từ Telegram
app.get('/api/telegram-proxy', async (req, res) => {
  const { token, file_id } = req.query;
  if (!token || !file_id) return res.status(400).send("Thiếu thông tin file_id hoặc token!");

  try {
    // Bước a: Lấy file_path từ Telegram API
    const fileRes = await axios.get(`https://api.telegram.org/bot${token}/getFile?file_id=${file_id}`);
    if (!fileRes.data.ok || !fileRes.data.result.file_path) {
      return res.status(404).send("Không lấy được thông tin file từ Telegram");
    }

    const filePath = fileRes.data.result.file_path;
    const directUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;

    // Bước b: Stream dữ liệu file trực tiếp về client
    const streamRes = await axios({
      method: 'get',
      url: directUrl,
      responseType: 'stream'
    });

    res.setHeader('Content-Type', streamRes.headers['content-type'] || 'application/octet-stream');
    streamRes.data.pipe(res);
  } catch (error) {
    console.error("Telegram Proxy Error:", error.message);
    res.status(500).send("Lỗi tải tệp qua Proxy");
  }
});

// Phục vụ SPA Route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server đang vận hành tại cổng ${PORT}`);
});
