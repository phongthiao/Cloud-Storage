const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.json());

// CONFIGURATION
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || 'YOUR_CHAT_ID_HERE';
const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB mỗi chunk để tránh giới hạn API

// Hàm hỗ trợ Sleep (Dùng cho Retry)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hàm gọi API Telegram có cơ chế Retry khi gặp lỗi Rate Limit (429) hoặc Network Issue
 */
async function fetchWithRetry(fn, maxRetries = 5, delay = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const status = error.response?.status;
      const retryAfter = error.response?.data?.parameters?.retry_after;
      
      console.warn(`[Lần thử ${attempt}/${maxRetries}] Lỗi: ${error.message}`);

      if (attempt === maxRetries) {
        throw new Error(`Đã vượt quá số lần thử lại. Nguyên nhân: ${error.message}`);
      }

      // Nếu bị giới hạn Rate Limit từ Telegram
      const waitTime = retryAfter ? retryAfter * 1000 : delay * attempt;
      console.log(`Đang chờ ${waitTime}ms trước khi thử lại...`);
      await sleep(waitTime);
    }
  }
}

/**
 * 1. UPLOAD FILE (Tách nhỏ thành các Chunk và tải lên Telegram)
 */
async function uploadLargeFile(filePath) {
  const stats = fs.statSync(filePath);
  const totalSize = stats.size;
  const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
  const fileManifest = [];

  console.log(`Bắt đầu Upload File: ${filePath} (${(totalSize / (1024 * 1024)).toFixed(2)} MB), tổng số chunks: ${totalChunks}`);

  for (let index = 0; index < totalChunks; index++) {
    const start = index * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE - 1, totalSize - 1);
    
    console.log(`Đang xử lý Chunk ${index + 1}/${totalChunks} (Bytes ${start} - ${end})...`);

    // Tạo stream cho từng phần chunk
    const chunkStream = fs.createReadStream(filePath, { start, end });

    const uploadTask = async () => {
      const formData = new FormData();
      formData.append('chat_id', TELEGRAM_CHAT_ID);
      formData.append('document', chunkStream, {
        filename: `${path.basename(filePath)}.part${index}`
      });

      const response = await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`,
        formData,
        { headers: formData.getHeaders(), timeout: 120000 }
      );

      return response.data.result.document.file_id;
    };

    // Thực hiện Upload với Retry
    const fileId = await fetchWithRetry(uploadTask);
    fileManifest.push({ index, fileId, size: end - start + 1 });
  }

  console.log('Upload hoàn tất toàn bộ các chunk!');
  return {
    fileName: path.basename(filePath),
    totalSize,
    totalChunks,
    chunks: fileManifest
  };
}

/**
 * 2. DOWNLOAD & STREAM FILE (Ghép tuần tự các Chunk trả về Client)
 */
app.get('/download', async (req, res) => {
  try {
    // metadata: Dữ liệu manifest đã lưu khi upload
    // Ví dụ nhận qua query/body hoặc database
    const metadata = JSON.parse(req.query.metadata);

    // Bắt buộc Set đúng Header để Trình duyệt nhận đúng dung lượng & mở xem trực tiếp
    res.setHeader('Content-Type', 'video/mp4'); // Hoặc mime-type tương ứng
    res.setHeader('Content-Length', metadata.totalSize);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(metadata.fileName)}"`);

    console.log(`Bắt đầu tải và stream file: ${metadata.fileName} (${metadata.totalSize} bytes)`);

    // Đảm bảo ghép từng chunk THEO ĐÚNG THỨ TỰ (0 -> n)
    for (const chunkInfo of metadata.chunks) {
      console.log(`Đang tải Chunk ${chunkInfo.index + 1}/${metadata.totalChunks}...`);

      // 1. Lấy File Path từ Telegram
      const getFileTask = async () => {
        const res = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile`, {
          params: { file_id: chunkInfo.fileId }
        });
        return res.data.result.file_path;
      };
      const telegramFilePath = await fetchWithRetry(getFileTask);

      // 2. Tải Stream dữ liệu của Chunk đó
      const downloadTask = async () => {
        return await axios.get(
          `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${telegramFilePath}`,
          { responseType: 'stream', timeout: 120000 }
        );
      };
      const chunkResponse = await fetchWithRetry(downloadTask);

      // 3. Ghi Chunk vào res Stream và chờ ghi xong tuyệt đối mới sang Chunk tiếp theo
      await new Promise((resolve, reject) => {
        chunkResponse.data.pipe(res, { end: false });
        
        chunkResponse.data.on('end', () => {
          resolve();
        });

        chunkResponse.data.on('error', (err) => {
          reject(err);
        });

        res.on('error', (err) => {
          reject(err);
        });
      });
    }

    // Kết thúc Stream sau khi TẤT CẢ các Chunk đã được gửi xong 100%
    console.log('Tải về và kết xuất dữ liệu hoàn tất!');
    res.end();

  } catch (error) {
    console.error('Lỗi trong quá trình Download/Stream:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Quá trình tải file bị lỗi hoặc gián đoạn.', detail: error.message });
    } else {
      res.destroy(); // Đóng socket nếu đang truyền giữa chừng bị lỗi
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
