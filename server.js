const express = require('express');
// --- 新增的偵錯日誌 ---
console.log("--- [DEBUG] DATABASE CONNECTION INFO ---");
console.log("DB_HOST:", process.env.DB_HOST);
console.log("DB_DATABASE:", process.env.DB_DATABASE);
console.log("DB_USER:", process.env.DB_USER);
console.log("DB_PASSWORD is set:", !!process.env.DB_PASSWORD); 
console.log("--------------------------------------");
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const cron = require('node-cron');
const { Connection, Request, TYPES } = require('tedious'); // 引入 tedious

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
    origin: '*', // 允許來自任何來源的請求
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // 允許所有標準的 HTTP 方法
    allowedHeaders: ['Content-Type', 'Authorization'] // 允許的標頭
}));
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
        encrypt: true,
        trustServerCertificate: true,
        rowCollectionOnDone: true
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
            const startMarker = 'var product = ';
            const startIndex = scriptWithData.indexOf(startMarker);
            const objectStartIndex = scriptWithData.indexOf('{', startIndex);

            if (objectStartIndex !== -1) {
                let braceCount = 1;
                let objectEndIndex = -1;
                for (let i = objectStartIndex + 1; i < scriptWithData.length; i++) {
                    if (scriptWithData[i] === '{') braceCount++;
                    if (scriptWithData[i] === '}') braceCount--;
                    if (braceCount === 0) {
                        objectEndIndex = i;
                        break;
                    }
                }

                if (objectEndIndex !== -1) {
                    const jsonString = scriptWithData.substring(objectStartIndex, objectEndIndex + 1);
                    try {
                        const productData = JSON.parse(jsonString);
                        return {
                            productName: productData.title,
                            totalSold: productData.total_sold
                        };
                    } catch (e) {
                        console.error(`最終 JSON 解析失敗於 ${url}:`, e.message);
                        return null; // 解析失敗
                    }
                }
            }
        }
        return null; // 找不到腳本
    } catch (error) {
        console.error(`抓取 ${url} 失敗:`, error.message);
        return null; // 抓取失敗
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
        console.log(`[LOG] /api/products - Found ${products.length} products in DB.`);
        res.json(products);
    } catch (error) {
        res.status(500).json({ error: '讀取追蹤列表失敗' });
    }
});

// --- 【偵錯版】新增追蹤任務的 API ---
app.post('/api/track', async (req, res) => {
    const { url, multiple_pattern } = req.body;
    if (!url || !multiple_pattern) {
        return res.status(400).json({ error: '缺少 url 或 multiple_pattern 參數' });
    }
    
    try {
        console.log("[DEBUG] /api/track - 收到請求，URL:", url);
        const initialData = await fetchAndParseSales(url);
        if (!initialData) {
            return res.status(404).json({ error: '無法從此網址抓取到商品資訊' });
        }
        console.log("[DEBUG] /api/track - 1. 成功抓取到初始資料:", initialData);

        // 步驟 2A: 執行單純的 INSERT
        const insertProductSql = `
            INSERT INTO products (url, product_name, multiple_pattern) 
            VALUES (@url, @product_name, @multiple_pattern);
        `;
        const productParams = [
            { name: 'url', type: TYPES.NVarChar, value: url },
            { name: 'product_name', type: TYPES.NVarChar, value: initialData.productName },
            { name: 'multiple_pattern', type: TYPES.Int, value: multiple_pattern }
        ];
        await executeQuery(insertProductSql, productParams);
        console.log("[DEBUG] /api/track - 2. 'products' 表寫入完成。");

        // 步驟 2B: 立刻用 url 把剛才的資料查詢回來，以取得 ID
        const selectSql = "SELECT id FROM products WHERE url = @url;";
        const selectParams = [{ name: 'url', type: TYPES.NVarChar, value: url }];
        const newProductResult = await executeQuery(selectSql, selectParams);
        
        if (!newProductResult || newProductResult.length === 0) {
            throw new Error("寫入新商品後，無法查詢到其 ID");
        }
        const newProductId = newProductResult[0].id;
        console.log(`[DEBUG] /api/track - 3. 成功查詢到新 Product ID: ${newProductId}`);

        // 步驟 3: 將初始銷量存入 sales_logs 表
        const insertLogSql = 'INSERT INTO sales_logs (product_id, "timestamp", total_sold) VALUES (@product_id, @timestamp, @total_sold)';
        const logParams = [
            { name: 'product_id', type: TYPES.Int, value: newProductId },
            { name: 'timestamp', type: TYPES.DateTimeOffset, value: new Date() },
            { name: 'total_sold', type: TYPES.Int, value: initialData.totalSold }
        ];
        await executeQuery(insertLogSql, logParams);
        console.log("[DEBUG] /api/track - 4. 'sales_logs' 表寫入成功！");
        
        res.status(201).json({ message: '商品已加入追蹤，並已記錄初始銷量' });

    } catch (error) {
        console.error("[CRITICAL ERROR] 在 /api/track 流程中捕捉到嚴重錯誤:", error);
        if (error.message && error.message.includes('Violation of UNIQUE KEY constraint')) {
            return res.status(409).json({ error: '此商品網址已經在追蹤列表中' });
        }
        res.status(500).json({ error: '伺服器內部錯誤，請查看後端日誌' });
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


const host = '0.0.0.0';
app.listen(PORT, host, () => {
    console.log(`伺服器已啟動，正在監聽 http://${host}:${PORT}`);
});