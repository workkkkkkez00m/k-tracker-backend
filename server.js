const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const cron = require('node-cron');
const { Connection, Request, TYPES } = require('tedious'); // 引入 tedious

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json()); 

// --- 資料庫連線設定 (從 Render 的環境變數讀取) ---
const dbConfig = {
    server: process.env.DB_HOST,
    authentication: {
        type: 'default',
        options: {
            userName: process.env.DB_USER,
            password: process.env.DB_PASSWORD
        }
    },
    options: {
        database: process.env.DB_DATABASE,
        encrypt: true, // Azure SQL 需要加密連線
        rowCollectionOnDone: true // 這個選項讓我們更容易處理回傳的資料
    }
};

// --- 執行 SQL 查詢的輔助函式 ---
function executeQuery(query, params = []) {
    return new Promise((resolve, reject) => {
        const connection = new Connection(dbConfig);

        connection.on('connect', (err) => {
            if (err) {
                console.error("資料庫連線失敗:", err);
                return reject(err);
            }

            const request = new Request(query, (err, rowCount, rows) => {
                connection.close();
                if (err) {
                    return reject(err);
                }
                const result = rows.map(row => {
                    const item = {};
                    row.forEach(col => {
                        item[col.metadata.colName] = col.value;
                    });
                    return item;
                });
                resolve(result);
            });

            params.forEach(p => request.addParameter(p.name, p.type, p.value));

            connection.execSql(request);
        });

        connection.on('error', err => {
            console.error("資料庫連線出現錯誤:", err);
            reject(err);
        });

        connection.connect();
    });
}

// ===================================================
// ===         核心爬蟲邏輯 (重構為獨立函式)         ===
// ===================================================
async function fetchAndParseSales(url) {
    try {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'max-age=0'
        };
        const response = await axios.get(url, { headers });
        const $ = cheerio.load(response.data);

        let productData = null;
        let scriptWithData = null;

        $('script').each((i, el) => {
            const scriptContent = $(el).html();
            if (scriptContent.includes('var product =') && scriptContent.includes('"total_sold"')) {
                scriptWithData = scriptContent;
                return false;
            }
        });

        if (scriptWithData) {
            const match = scriptWithData.match(/var product = (\{[\s\S]*?\});/);
            if (match && match[1]) {
                productData = JSON.parse(match[1]);
                return {
                    productName: productData.title,
                    totalSold: productData.total_sold
                };
            }
        }
        return null; // 找不到資料則返回 null
    } catch (error) {
        console.error(`抓取 ${url} 失敗:`, error.message);
        return null; // 發生錯誤也返回 null
    }
}

// ===================================================
// ===                 API 端點                    ===
// ===================================================
// --- 舊的即時查詢 API  ---
app.get('/fetch-sales', async (req, res) => {
    const { productUrl } = req.query;
    if (!productUrl) return res.status(400).json({ error: '請提供商品網址' });
    
    const data = await fetchAndParseSales(productUrl);
    if (data) {
        res.json(data);
    } else {
        res.status(404).json({ error: '找不到銷量數據或抓取失敗' });
    }
});

// --- 【新】獲取所有正在追蹤的商品列表 ---
app.get('/api/products', async (req, res) => {
    try {
        const products = await executeQuery('SELECT * FROM products ORDER BY created_at DESC');
        res.json(products);
    } catch (error) {
        res.status(500).json({ error: '讀取追蹤列表失敗' });
    }
});

// --- 【新】新增追蹤任務的 API ---
app.post('/api/track', async (req, res) => {
    const { url, multiple_pattern, product_name } = req.body;
    if (!url || !multiple_pattern || !product_name) {
        return res.status(400).json({ error: '缺少 url, product_name 或 multiple_pattern 參數' });
    }

    try {
        const sql = `
            INSERT INTO products (url, product_name, multiple_pattern) 
            VALUES (@url, @product_name, @multiple_pattern);
        `;
        const params = [
            { name: 'url', type: TYPES.NVarChar, value: url },
            { name: 'product_name', type: TYPES.NVarChar, value: product_name },
            { name: 'multiple_pattern', type: TYPES.Int, value: multiple_pattern }
        ];
        await executeQuery(sql, params);
        res.status(201).json({ message: '商品已加入追蹤列表' });
    } catch (error) {
        // 處理網址重複的錯誤
        if (error.message && error.message.includes('Violation of UNIQUE KEY constraint')) {
            return res.status(409).json({ error: '此商品網址已經在追蹤列表中' });
        }
        console.error('新增追蹤任務失敗:', error);
        res.status(500).json({ error: '資料庫操作失敗' });
    }
});

// --- 【新】查詢歷史數據與分析的 API ---
app.get('/api/products/:id', async (req, res) => {
    try {
        const productResult = await executeQuery('SELECT * FROM products WHERE id = @id', [{ name: 'id', type: TYPES.Int, value: req.params.id }]);
        if (productResult.length === 0) {
            return res.status(404).json({ error: '在追蹤列表中找不到該商品' });
        }
        const product = productResult[0];

        const logsResult = await executeQuery('SELECT * FROM sales_logs WHERE product_id = @id ORDER BY timestamp ASC', [{ name: 'id', type: TYPES.Int, value: req.params.id }]);

        // --- 核心推論邏輯 ---
        let previousSold = 0;
        const analysis = logsResult.map(log => {
            const delta = log.total_sold - previousSold;
            const sets = delta > 0 ? Math.floor(delta / product.multiple_pattern) : 0;
            const remainder = delta > 0 ? delta % product.multiple_pattern : 0;
            previousSold = log.total_sold;
            return {
                timestamp: log.timestamp,
                total_sold: log.total_sold,
                delta_sold: delta,
                estimated_sets: sets,
                remainder_sales: remainder
            };
        });

        res.json({ product, analysis });
    } catch (error) {
        console.error('查詢分析數據失敗:', error);
        res.status(500).json({ error: '資料庫操作失敗' });
    }
});

// ===================================================
// ===         自動排程器 (Cron Job)               ===
// ===================================================
// cron 語法: '分鐘 小時 日 月 週'
// '*/30 * * * *' 代表 "每 30 分鐘"
cron.schedule('*/30 * * * *', async () => {
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    console.log(`[${now}] 排程啟動：開始抓取所有追蹤商品的最新銷量...`);
    
    try {
        const productsToTrack = await executeQuery('SELECT * FROM products');

        for (const product of productsToTrack) {
            console.log(` -> 正在處理: ${product.product_name}`);
            const salesData = await fetchAndParseSales(product.url);

            if (salesData && salesData.totalSold !== null) {
                const sql = 'INSERT INTO sales_logs (product_id, timestamp, total_sold) VALUES (@product_id, @timestamp, @total_sold)';
                const params = [
                    { name: 'product_id', type: TYPES.Int, value: product.id },
                    { name: 'timestamp', type: TYPES.DateTimeOffset, value: new Date() },
                    { name: 'total_sold', type: TYPES.Int, value: salesData.totalSold }
                ];
                await executeQuery(sql, params);
                console.log(`    - 成功儲存銷量: ${salesData.totalSold}`);
            } else {
                console.log(`    - 抓取銷量失敗，跳過。`);
            }
        }
        console.log('排程結束。');

    } catch (error) {
        console.error('排程任務執行失敗:', error);
    }
});


app.listen(PORT, () => {
    console.log(`伺服器已啟動，正在監聽 PORT: ${PORT}`);
});