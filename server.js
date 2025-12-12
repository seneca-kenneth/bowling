const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const path = require('path'); // 引入 path 模組 (修復 Vercel 路徑問題)
const app = express();

// 連接 Vercel Postgres
const pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    ssl: { rejectUnauthorized: false }
});

// 🔥 關鍵修復：明確告訴 Express views 資料夾在哪裡 🔥
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'))); // 同樣修復 public 資料夾路徑

// 輔助函數：執行 SQL Query
async function query(text, params) {
    return await pool.query(text, params);
}

// 🔥 重置資料庫路由 (初始化 Table 結構)
app.get('/reset-db', async (req, res) => {
    try {
        await query("DROP TABLE IF EXISTS transactions");
        await query("DROP TABLE IF EXISTS users");
        await query("DROP TABLE IF EXISTS settings"); 
        await query("DROP TABLE IF EXISTS activities");

        // 1. 活動表
        await query(`CREATE TABLE activities (
            id SERIAL PRIMARY KEY, 
            name TEXT NOT NULL,
            cost_per_game NUMERIC DEFAULT 0,
            alert_threshold NUMERIC DEFAULT 200,
            created_at TIMESTAMP DEFAULT NOW()
        )`);

        // 2. 用戶表 (關聯活動)
        await query(`CREATE TABLE users (
            id SERIAL PRIMARY KEY, 
            activity_id INTEGER REFERENCES activities(id) ON DELETE CASCADE,
            name TEXT, 
            balance NUMERIC DEFAULT 0
        )`);

        // 3. 交易表 (關聯活動)
        await query(`CREATE TABLE transactions (
            id SERIAL PRIMARY KEY, 
            activity_id INTEGER REFERENCES activities(id) ON DELETE CASCADE,
            user_id INTEGER, 
            type TEXT, 
            amount NUMERIC, 
            description TEXT, 
            date TIMESTAMP
        )`);

        res.send("Database has been reset and upgraded for Multi-Activity support. <a href='/'>Go Home</a>");
    } catch (err) {
        console.error(err);
        res.status(500).send("Error resetting DB: " + err.message);
    }
});

// 1. 大堂 (Lobby) - 列出所有活動
app.get('/', async (req, res) => {
    try {
        const result = await query("SELECT * FROM activities ORDER BY created_at DESC");
        res.render('lobby', { activities: result.rows });
    } catch (err) {
        // 如果表不存在 (例如第一次用)，提示去 reset
        if (err.code === '42P01') return res.redirect('/reset-db');
        res.status(500).send("DB Error: " + err.message);
    }
});

// 2. 創建新活動
app.post('/create-activity', async (req, res) => {
    const { name, cost } = req.body;
    if (name) {
        await query("INSERT INTO activities (name, cost_per_game) VALUES ($1, $2)", [name, parseFloat(cost) || 0]);
    }
    res.redirect('/');
});

// 3. 進入特定活動 (Dashboard)
app.get('/activity/:id', async (req, res) => {
    const activityId = req.params.id;
    try {
        const actRes = await query("SELECT * FROM activities WHERE id = $1", [activityId]);
        const activity = actRes.rows[0];
        if (!activity) return res.redirect('/');

        const costPerGame = parseFloat(activity.cost_per_game);
        const alertThreshold = parseFloat(activity.alert_threshold);
        const keepOpen = req.query.open === 'true';

        const usersRes = await query("SELECT * FROM users WHERE activity_id = $1 ORDER BY name ASC", [activityId]);
        const users = usersRes.rows.map(u => ({...u, balance: parseFloat(u.balance)}));
        
        const alertUsers = users.filter(u => u.balance < alertThreshold);

        res.render('index', { activity, users, costPerGame, alertThreshold, alertUsers, keepOpen });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading activity");
    }
});

// 4. 記數 (Record)
app.post('/activity/:id/record', async (req, res) => {
    const activityId = req.params.id;
    const { games } = req.body; 
    
    if (!games) return res.redirect(`/activity/${activityId}`);

    try {
        const actRes = await query("SELECT cost_per_game FROM activities WHERE id = $1", [activityId]);
        const costPerGame = parseFloat(actRes.rows[0].cost_per_game);

        for (const [key, countStr] of Object.entries(games)) {
            const userId = parseInt(key.replace('uid_', '')); 
            const gameCount = parseInt(countStr);

            if (!isNaN(gameCount) && gameCount > 0 && !isNaN(userId)) {
                const cost = gameCount * costPerGame;
                
                await query("INSERT INTO transactions (activity_id, user_id, type, amount, description, date) VALUES ($1, $2, 'expense', $3, $4, NOW())", 
                    [activityId, userId, -cost, `打波 ${gameCount} 局`]);
                
                await query("UPDATE users SET balance = balance - $1 WHERE id = $2", [cost, userId]);
            }
        }
        res.redirect(`/activity/${activityId}`);
    } catch (err) {
        console.error(err);
        res.redirect(`/activity/${activityId}`);
    }
});

// 5. 入錢
app.post('/activity/:id/deposit', async (req, res) => {
    const activityId = req.params.id;
    const { userId, amount } = req.body;
    const val = parseFloat(amount);
    if (val) {
        await query("INSERT INTO transactions (activity_id, user_id, type, amount, description, date) VALUES ($1, $2, 'deposit', $3, '入數', NOW())", [activityId, userId, val]);
        await query("UPDATE users SET balance = balance + $1 WHERE id = $2", [val, userId]);
    }
    res.redirect(`/activity/${activityId}?open=true`);
});

// 6. 加人
app.post('/activity/:id/add-user', async (req, res) => {
    const activityId = req.params.id;
    if(req.body.name) {
        await query("INSERT INTO users (activity_id, name, balance) VALUES ($1, $2, 0)", [activityId, req.body.name]);
    }
    res.redirect(`/activity/${activityId}?open=true`);
});

// 7. 更新設定 (價錢 & 提醒)
app.post('/activity/:id/settings', async (req, res) => {
    const activityId = req.params.id;
    const { cost, threshold } = req.body;
    await query("UPDATE activities SET cost_per_game = $1, alert_threshold = $2 WHERE id = $3", 
        [cost, threshold, activityId]);
    res.redirect(`/activity/${activityId}?open=true`);
});

// 8. 歷史紀錄頁
app.get('/activity/:id/history', async (req, res) => {
    const activityId = req.params.id;
    try {
        const sql = `
            SELECT t.id, t.amount, t.description, t.date, t.type, t.user_id, u.name 
            FROM transactions t 
            JOIN users u ON t.user_id = u.id 
            WHERE t.activity_id = $1
            ORDER BY t.date DESC 
            LIMIT 50`;
        const transRes = await query(sql, [activityId]);
        
        const transactions = transRes.rows.map(t => ({
            ...t,
            amount: parseFloat(t.amount),
            date: new Date(t.date).toISOString()
        }));

        const actRes = await query("SELECT * FROM activities WHERE id = $1", [activityId]);
        const activity = actRes.rows[0];

        res.render('history', { transactions, activity });
    } catch (err) {
        console.error(err);
        res.send("Error");
    }
});

// 9. 用戶管理頁
app.get('/activity/:id/users', async (req, res) => {
    const activityId = req.params.id;
    try {
        const actRes = await query("SELECT * FROM activities WHERE id = $1", [activityId]);
        const usersRes = await query("SELECT * FROM users WHERE activity_id = $1 ORDER BY name ASC", [activityId]);
        
        const activity = actRes.rows[0];
        const users = usersRes.rows.map(u => ({...u, balance: parseFloat(u.balance)}));

        res.render('users', { users, activity });
    } catch (err) {
        console.error(err);
        res.send("Error");
    }
});

// 10. 修改 Transaction
app.post('/activity/:id/update-transaction', async (req, res) => {
    const activityId = req.params.id;
    const { id, newGameCount } = req.body;
    const games = parseInt(newGameCount);

    try {
        const oldTransRes = await query("SELECT * FROM transactions WHERE id = $1", [id]);
        const oldTrans = oldTransRes.rows[0];
        if (!oldTrans || oldTrans.type !== 'expense') return res.redirect(`/activity/${activityId}/history`);

        const actRes = await query("SELECT cost_per_game FROM activities WHERE id = $1", [activityId]);
        const costPerGame = parseFloat(actRes.rows[0].cost_per_game);
        
        const newAmount = -(games * costPerGame); 
        const newDesc = `打波 ${games} 局`;
        const diff = newAmount - parseFloat(oldTrans.amount);

        await query("UPDATE users SET balance = balance + $1 WHERE id = $2", [diff, oldTrans.user_id]);
        await query("UPDATE transactions SET amount = $1, description = $2 WHERE id = $3", [newAmount, newDesc, id]);
        
        res.redirect(`/activity/${activityId}/history`);
    } catch (err) {
        console.error(err);
        res.redirect(`/activity/${activityId}/history`);
    }
});

// 11. 刪除 Transaction
app.post('/activity/:id/delete-transaction', async (req, res) => {
    const activityId = req.params.id;
    const { id } = req.body;
    try {
        const transRes = await query("SELECT * FROM transactions WHERE id = $1", [id]);
        const trans = transRes.rows[0];
        if (trans) {
            await query("UPDATE users SET balance = balance - $1 WHERE id = $2", [parseFloat(trans.amount), trans.user_id]);
            await query("DELETE FROM transactions WHERE id = $1", [id]);
        }
        res.redirect(`/activity/${activityId}/history`);
    } catch (err) {
        res.redirect(`/activity/${activityId}/history`);
    }
});

// 12. 修改 User
app.post('/activity/:id/edit-user', async (req, res) => {
    await query("UPDATE users SET name = $1 WHERE id = $2", [req.body.name, req.body.id]);
    res.redirect(`/activity/${req.params.id}/users`);
});

// 13. 刪除 User
app.post('/activity/:id/delete-user', async (req, res) => {
    await query("DELETE FROM users WHERE id = $1", [req.body.id]);
    res.redirect(`/activity/${req.params.id}/users`);
});

// 本地測試用 (Vercel 不需要 listen，但保留也無妨)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));

module.exports = app;