const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// 使用 cors 中介軟體，允許所有來源的請求
app.use(cors());

// 建立一個 API 端點來獲取銷量
app.get('/fetch-sales', async (req, res) => {
    const { productUrl } = req.query;

    // 參數驗證：確保 productUrl 存在且是 K-MONSTAR 的網址
    if (!productUrl || !productUrl.startsWith('https://www.kmonstar.com.tw')) {
        return res.status(400).json({ error: '請提供一個有效的 K-MONSTAR 商品連結。' });
    }

    try {
        // 1. 使用 axios 抓取目標網頁的 HTML
        const { data } = await axios.get(productUrl);

        // 2. 使用 cheerio 載入 HTML
        const $ = cheerio.load(data);

        let productData = null;
        let totalSold = null;
        let productName = '';

        // 3. 在 <script> 標籤中尋找包含 "total_sold" 的那一段
        // 我們尋找包含 "var product = {" 的 script 標籤，這樣更精準
        $('script').each((i, el) => {
            const scriptContent = $(el).html();
            if (scriptContent.includes('"total_sold"')) {
                // 這裡的寫法是為了從 JS 程式碼中抽取出 JSON 物件
                // 找到 "var product = {" 開頭，到 "};" 結尾的部分
                const match = scriptContent.match(/var product = (\{[\s\S]*?\});/);
                if (match && match[1]) {
                    productData = JSON.parse(match[1]);
                    return false; // 找到就停止迴圈
                }
            }
        });

        // 4. 從解析出來的資料中取得銷量和名稱
        if (productData) {
            totalSold = productData.total_sold;
            productName = productData.title;
            res.json({
                productName,
                totalSold,
                lastUpdated: new Date().toLocaleTimeString('zh-TW')
            });
        } else {
            res.status(404).json({ error: '在頁面中找不到銷量數據。' });
        }

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: '抓取資料時發生錯誤。' });
    }
});

app.listen(PORT, () => {
    console.log(`伺服器正在 http://localhost:${PORT} 上運行`);
});