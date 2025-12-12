const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const path = require('path');
const app = express();

// 連接 Vercel Postgres
const pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    ssl: { rejectUnauthorized: false }
});

// 設定 Views
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 輔助函數
async function query(text, params) {
    return await pool.query(text, params);
}

// 🔥 重置資料庫
app.get('/reset-db', async (req, res) => {
    try {
        await query("DROP TABLE IF EXISTS transactions");
        await query("DROP TABLE IF EXISTS users");
        await query("DROP TABLE IF EXISTS activities");

        // 1. 活動表
        await query(`CREATE TABLE activities (
            id SERIAL PRIMARY KEY, 
            name TEXT NOT NULL,
            type TEXT DEFAULT 'bowling',
            cost_per_game NUMERIC DEFAULT 0,
            alert_threshold NUMERIC DEFAULT 200,
            created_at TIMESTAMP DEFAULT NOW()
        )`);

        // 2. 用戶表
        await query(`CREATE TABLE users (
            id SERIAL PRIMARY KEY, 
            activity_id INTEGER REFERENCES activities(id) ON DELETE CASCADE,
            name TEXT, 
            balance NUMERIC DEFAULT 0
        )`);

        // 3. 交易表
        await query(`CREATE TABLE transactions (
            id SERIAL PRIMARY KEY, 
            activity_id INTEGER REFERENCES activities(id) ON DELETE CASCADE,
            user_id INTEGER, 
            type TEXT, 
            amount NUMERIC, 
            description TEXT, 
            date TIMESTAMP
        )`);

        res.send("Database has been reset. <a href='/'>Go Home</a>");
    } catch (err) {
        console.error(err);
        res.status(500).send("Error resetting DB: " + err.message);
    }
});

// 1. 大堂 (Lobby)
app.get('/', async (req, res) => {
    try {
        const result = await query("SELECT * FROM activities ORDER BY created_at DESC");
        res.render('lobby', { activities: result.rows });
    } catch (err) {
        if (err.code === '42P01') return res.redirect('/reset-db');
        res.status(500).send("DB Error: " + err.message);
    }
});

// 2. 創建新活動
app.post('/create-activity', async (req, res) => {
    const { name, cost, type } = req.body;
    const activityType = type || 'bowling';
    if (name) {
        await query("INSERT INTO activities (name, cost_per_game, type) VALUES ($1, $2, $3)", 
            [name, parseFloat(cost) || 0, activityType]);
    }
    res.redirect('/');
});

// 3. 進入特定活動
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

// 4. 記數邏輯
app.post('/activity/:id/record', async (req, res) => {
    const activityId = req.params.id;
    const { games, selectedUsers, totalCost } = req.body; 

    try {
        const actRes = await query("SELECT * FROM activities WHERE id = $1", [activityId]);
        const activity = actRes.rows[0];

        // --- 模式 A: 保齡球 ---
        if (activity.type === 'bowling') {
            if (!games) return res.redirect(`/activity/${activityId}`);
            const costPerGame = parseFloat(activity.cost_per_game);

            for (const [key, countStr] of Object.entries(games)) {
                const userId = parseInt(key.replace('uid_', '')); 
                const gameCount = parseInt(countStr);

                if (!isNaN(gameCount) && gameCount > 0) {
                    const cost = gameCount * costPerGame;
                    await query("INSERT INTO transactions (activity_id, user_id, type, amount, description, date) VALUES ($1, $2, 'expense', $3, $4, NOW())", 
                        [activityId, userId, -cost, `打波 ${gameCount} 局`]);
                    await query("UPDATE users SET balance = balance - $1 WHERE id = $2", [cost, userId]);
                }
            }
        } 
        // --- 模式 B: Pickleball / 夾錢 ---
        else {
            let users = [];
            if (Array.isArray(selectedUsers)) users = selectedUsers;
            else if (selectedUsers) users = [selectedUsers];

            const cost = parseFloat(totalCost);
            
            if (users.length > 0 && cost > 0) {
                const perHeadCost = cost / users.length;
                
                for (const userId of users) {
                    await query("INSERT INTO transactions (activity_id, user_id, type, amount, description, date) VALUES ($1, $2, 'expense', $3, $4, NOW())", 
                        [activityId, userId, -perHeadCost, `夾場租 (共$${cost})`]);
                    await query("UPDATE users SET balance = balance - $1 WHERE id = $2", [perHeadCost, userId]);
                }
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

// 7. 更新設定 (已升級：支援改名)
app.post('/activity/:id/settings', async (req, res) => {
    const activityId = req.params.id;
    const { name, cost, threshold } = req.body;
    
    // SQL 加咗 name = $1
    await query("UPDATE activities SET name = $1, cost_per_game = $2, alert_threshold = $3 WHERE id = $4", 
        [name, cost, threshold, activityId]);
        
    res.redirect(`/activity/${activityId}?open=true`);
});

// 8. 歷史紀錄
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

// 10. 修改 Transaction (支援局數 或 直接金額)
app.post('/activity/:id/update-transaction', async (req, res) => {
    const activityId = req.params.id;
    const { id, newGameCount, newAmount } = req.body;

    try {
        const oldTransRes = await query("SELECT * FROM transactions WHERE id = $1", [id]);
        const oldTrans = oldTransRes.rows[0];
        if (!oldTrans) return res.redirect(`/activity/${activityId}/history`);

        // 1. 先還原舊數
        await query("UPDATE users SET balance = balance - $1 WHERE id = $2", 
            [parseFloat(oldTrans.amount), oldTrans.user_id]);

        let finalAmount = 0;
        let finalDesc = oldTrans.description;

        // 情況 A: 修改保齡球局數
        if (newGameCount) {
            const games = parseInt(newGameCount);
            const actRes = await query("SELECT cost_per_game FROM activities WHERE id = $1", [activityId]);
            const costPerGame = parseFloat(actRes.rows[0].cost_per_game);
            finalAmount = -(games * costPerGame);
            finalDesc = `打波 ${games} 局`;
        } 
        // 情況 B: 直接修改金額 (入錢 或 Pickleball)
        else if (newAmount) {
            const val = parseFloat(newAmount);
            if (oldTrans.type === 'deposit') {
                finalAmount = Math.abs(val); // 入錢一定是正數
            } else {
                finalAmount = -Math.abs(val); // 扣數一定是負數
            }
            // Description 唔改，照舊
        }

        // 2. 更新 Transaction 同 User Balance
        await query("UPDATE transactions SET amount = $1, description = $2 WHERE id = $3", 
            [finalAmount, finalDesc, id]);
        
        await query("UPDATE users SET balance = balance + $1 WHERE id = $2", 
            [finalAmount, oldTrans.user_id]);
        
        res.redirect(`/activity/${activityId}/history`);
    } catch (err) {
        console.error(err);
        res.redirect(`/activity/${activityId}/history`);
    }
});

// 11. 刪除 Transaction (通用)
app.post('/activity/:id/delete-transaction', async (req, res) => {
    const activityId = req.params.id;
    const { id } = req.body;
    try {
        const transRes = await query("SELECT * FROM transactions WHERE id = $1", [id]);
        const trans = transRes.rows[0];
        if (trans) {
            await query("UPDATE users SET balance = balance - $1 WHERE id = $2", 
                [parseFloat(trans.amount), trans.user_id]);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));