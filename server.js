const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const { Connection, Request, TYPES } = require('tedious'); // 引入 tedious

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json()); // 啟用 JSON body 解析，讓後端能讀取前端傳來的資料

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

// --- 舊的即時查詢 API (基礎功能，維持不變) ---
app.get('/fetch-sales', async (req, res) => {
    // ... 這部分的爬蟲邏輯完全不用動，請沿用我們之前最終修正好的版本 ...
    // ... 它會抓取網頁並解析出 productName 和 totalSold ...
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

// --- 排程器 (Scheduler) 和其他 API (例如獲取所有追蹤商品列表) 的邏輯未來會加在這裡 ---


app.listen(PORT, () => {
    console.log(`伺服器已啟動，正在監聽 PORT: ${PORT}`);
});