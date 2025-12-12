const express = require('express');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const path = require('path');
const app = express();

const pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    ssl: { rejectUnauthorized: false }
});

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

async function query(text, params) {
    return await pool.query(text, params);
}

// 1. Reset DB
app.get('/reset-db', async (req, res) => {
    try {
        await query("DROP TABLE IF EXISTS transactions");
        await query("DROP TABLE IF EXISTS users");
        await query("DROP TABLE IF EXISTS activities");

        await query(`CREATE TABLE activities (
            id SERIAL PRIMARY KEY, 
            name TEXT NOT NULL,
            type TEXT DEFAULT 'bowling',
            cost_per_game NUMERIC DEFAULT 0,
            alert_threshold NUMERIC DEFAULT 200,
            created_at TIMESTAMP DEFAULT NOW()
        )`);

        await query(`CREATE TABLE users (
            id SERIAL PRIMARY KEY, 
            activity_id INTEGER REFERENCES activities(id) ON DELETE CASCADE,
            name TEXT, 
            balance NUMERIC DEFAULT 0
        )`);

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

// 2. Lobby
app.get('/', async (req, res) => {
    try {
        const result = await query("SELECT * FROM activities ORDER BY created_at DESC");
        res.render('lobby', { activities: result.rows });
    } catch (err) {
        if (err.code === '42P01') return res.redirect('/reset-db');
        res.status(500).send("DB Error: " + err.message);
    }
});

// 3. Create Activity
app.post('/create-activity', async (req, res) => {
    const { name, cost, type } = req.body;
    const activityType = type || 'bowling';
    if (name) {
        await query("INSERT INTO activities (name, cost_per_game, type) VALUES ($1, $2, $3)", 
            [name, parseFloat(cost) || 0, activityType]);
    }
    res.redirect('/');
});

// 4. Activity Dashboard
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

// 5. Record Logic
app.post('/activity/:id/record', async (req, res) => {
    const activityId = req.params.id;
    const { games, selectedUsers, totalCost, guests } = req.body; 
    
    const recordTime = new Date(); 

    try {
        const actRes = await query("SELECT * FROM activities WHERE id = $1", [activityId]);
        const activity = actRes.rows[0];

        if (activity.type === 'bowling') {
            if (!games) return res.redirect(`/activity/${activityId}`);
            const costPerGame = parseFloat(activity.cost_per_game);

            for (const [key, countStr] of Object.entries(games)) {
                const userId = parseInt(key.replace('uid_', '')); 
                const gameCount = parseInt(countStr);

                if (!isNaN(gameCount) && gameCount > 0) {
                    const cost = gameCount * costPerGame;
                    await query("INSERT INTO transactions (activity_id, user_id, type, amount, description, date) VALUES ($1, $2, 'expense', $3, $4, $5)", 
                        [activityId, userId, -cost, `打波 ${gameCount} 局`, recordTime]);
                    await query("UPDATE users SET balance = balance - $1 WHERE id = $2", [cost, userId]);
                }
            }
        } else {
            let userIds = [];
            if (Array.isArray(selectedUsers)) userIds = selectedUsers;
            else if (selectedUsers) userIds = [selectedUsers];

            const cost = parseFloat(totalCost);
            
            let totalHeads = 0;
            let userHeadsMap = {};

            userIds.forEach(uid => {
                let myGuest = 0;
                if (guests && guests[`uid_${uid}`]) {
                    myGuest = parseInt(guests[`uid_${uid}`]);
                }
                const myTotal = 1 + myGuest; 
                userHeadsMap[uid] = myTotal;
                totalHeads += myTotal;
            });
            
            if (totalHeads > 0 && cost > 0) {
                const perHeadCost = cost / totalHeads;
                
                for (const userId of userIds) {
                    const myHeads = userHeadsMap[userId];
                    const myCost = perHeadCost * myHeads;

                    let desc = `夾場租 (共$${cost})`;
                    if (myHeads > 1) {
                        desc += ` [${myHeads-1}訪客]`;
                    }

                    await query("INSERT INTO transactions (activity_id, user_id, type, amount, description, date) VALUES ($1, $2, 'expense', $3, $4, $5)", 
                        [activityId, userId, -myCost, desc, recordTime]);
                    await query("UPDATE users SET balance = balance - $1 WHERE id = $2", [myCost, userId]);
                }
            }
        }

        res.redirect(`/activity/${activityId}`);
    } catch (err) {
        console.error(err);
        res.redirect(`/activity/${activityId}`);
    }
});

// 6. Deposit
app.post('/activity/:id/deposit', async (req, res) => {
    const activityId = req.params.id;
    const { userId, amount } = req.body;
    const val = parseFloat(amount);
    if (val) {
        await query("INSERT INTO transactions (activity_id, user_id, type, amount, description, date) VALUES ($1, $2, 'deposit', $3, '入數', NOW())", [activityId, userId, val]);
        await query("UPDATE users SET balance = balance + $1 WHERE id = $2", [val, userId]);
    }
    res.redirect(`/activity/${activityId}/users`);
});

// 7. Add User
app.post('/activity/:id/add-user', async (req, res) => {
    const activityId = req.params.id;
    if(req.body.name) {
        await query("INSERT INTO users (activity_id, name, balance) VALUES ($1, $2, 0)", [activityId, req.body.name]);
    }
    res.redirect(`/activity/${activityId}/users`);
});

// 8. Settings
app.post('/activity/:id/settings', async (req, res) => {
    const activityId = req.params.id;
    const { name, cost, threshold } = req.body;
    await query("UPDATE activities SET name = $1, cost_per_game = $2, alert_threshold = $3 WHERE id = $4", 
        [name, cost, threshold, activityId]);
    res.redirect(`/activity/${activityId}?open=true`);
});

// 9. History Page
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
        const usersRes = await query("SELECT * FROM users WHERE activity_id = $1 ORDER BY name ASC", [activityId]);

        res.render('history', { 
            transactions, 
            activity: actRes.rows[0],
            users: usersRes.rows 
        });
    } catch (err) {
        console.error(err);
        res.send("Error");
    }
});

// 10. Users Page
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

// 11. Share Page
app.get('/activity/:id/share', async (req, res) => {
    const activityId = req.params.id;
    try {
        const actRes = await query("SELECT * FROM activities WHERE id = $1", [activityId]);
        const activity = actRes.rows[0];
        if (!activity) return res.send("Activity not found");

        const usersRes = await query("SELECT * FROM users WHERE activity_id = $1 ORDER BY name ASC", [activityId]);
        const users = usersRes.rows.map(u => ({...u, balance: parseFloat(u.balance)}));

        const transRes = await query(`
            SELECT t.amount, t.description, t.date, t.type, u.name 
            FROM transactions t 
            JOIN users u ON t.user_id = u.id 
            WHERE t.activity_id = $1 
            ORDER BY t.date DESC LIMIT 20`, [activityId]);
            
        const transactions = transRes.rows.map(t => ({
            ...t,
            amount: parseFloat(t.amount),
            date: new Date(t.date).toISOString()
        }));

        res.render('share', { activity, users, transactions });
    } catch (err) {
        console.error(err);
        res.send("Error");
    }
});

// 12. API: Get Group (🔥 FIX: Removed description from WHERE clause)
app.get('/activity/:id/transaction/:transId/group', async (req, res) => {
    const { id, transId } = req.params;
    try {
        const targetRes = await query("SELECT * FROM transactions WHERE id = $1", [transId]);
        const target = targetRes.rows[0];
        if (!target) return res.json([]);

        // 🔥 使用 Date 物件直接查詢，不依賴 Description
        const siblingsRes = await query(`
            SELECT user_id, description FROM transactions 
            WHERE activity_id = $1 AND date = $2`, 
            [id, target.date]
        );
        
        const result = siblingsRes.rows.map(row => {
            const match = row.description.match(/\[(\d+)訪客\]/);
            const guests = match ? parseInt(match[1]) : 0;
            return { user_id: row.user_id, guests: guests };
        });

        res.json(result);
    } catch (err) {
        console.error(err);
        res.json([]);
    }
});

// 13. Update Transaction (🔥 FIX: Removed description from WHERE clause)
app.post('/activity/:id/update-transaction', async (req, res) => {
    const activityId = req.params.id;
    const { id, newGameCount, newAmount, selectedUsers, guests } = req.body;

    try {
        const oldTransRes = await query("SELECT * FROM transactions WHERE id = $1", [id]);
        const oldTrans = oldTransRes.rows[0];
        if (!oldTrans) return res.redirect(`/activity/${activityId}/history`);

        if (selectedUsers) {
            // --- Pickleball Logic ---
            let userIds = Array.isArray(selectedUsers) ? selectedUsers : [selectedUsers];
            
            // 1. 找出同組交易 (只用 Time + ActivityID)
            const siblingsRes = await query(`
                SELECT * FROM transactions 
                WHERE activity_id = $1 AND date = $2`, 
                [activityId, oldTrans.date]
            );
            
            // 2. 刪除舊數
            for (const t of siblingsRes.rows) {
                await query("UPDATE users SET balance = balance - $1 WHERE id = $2", [parseFloat(t.amount), t.user_id]);
                await query("DELETE FROM transactions WHERE id = $1", [t.id]);
            }

            // 3. 計算新總數
            let totalCost = 0;
            if (newAmount) {
                totalCost = parseFloat(newAmount);
            } else {
                const match = oldTrans.description.match(/共\$(\d+(\.\d+)?)/);
                if (match) {
                    totalCost = parseFloat(match[1]);
                } else {
                    totalCost = siblingsRes.rows.reduce((sum, t) => sum + Math.abs(parseFloat(t.amount)), 0);
                }
            }

            // 4. 計算新分配 (Weighted)
            let totalHeads = 0;
            let userHeadsMap = {};

            userIds.forEach(uid => {
                let myGuest = 0;
                if (guests && guests[`uid_${uid}`]) {
                    myGuest = parseInt(guests[`uid_${uid}`]);
                }
                const myTotal = 1 + myGuest; 
                userHeadsMap[uid] = myTotal;
                totalHeads += myTotal;
            });

            // 5. 寫入新數 (保持舊時間)
            if (totalHeads > 0 && totalCost > 0) {
                const perHeadCost = totalCost / totalHeads;
                const sameDate = oldTrans.date; 

                for (const uid of userIds) {
                    const myHeads = userHeadsMap[uid];
                    const myCost = perHeadCost * myHeads;

                    let desc = `夾場租 (共$${totalCost})`;
                    if (myHeads > 1) {
                        desc += ` [${myHeads-1}訪客]`;
                    }

                    await query("INSERT INTO transactions (activity_id, user_id, type, amount, description, date) VALUES ($1, $2, 'expense', $3, $4, $5)", 
                        [activityId, uid, -myCost, desc, sameDate]);
                    await query("UPDATE users SET balance = balance - $1 WHERE id = $2", [myCost, uid]);
                }
            }

        } else {
            // --- Normal Update ---
            await query("UPDATE users SET balance = balance - $1 WHERE id = $2", [parseFloat(oldTrans.amount), oldTrans.user_id]);

            let finalAmount = 0;
            let finalDesc = oldTrans.description;

            if (newGameCount) {
                const games = parseInt(newGameCount);
                const actRes = await query("SELECT cost_per_game FROM activities WHERE id = $1", [activityId]);
                const costPerGame = parseFloat(actRes.rows[0].cost_per_game);
                finalAmount = -(games * costPerGame);
                finalDesc = `打波 ${games} 局`;
            } else if (newAmount) {
                const val = parseFloat(newAmount);
                if (oldTrans.type === 'deposit') {
                    finalAmount = Math.abs(val);
                } else {
                    finalAmount = -Math.abs(val);
                }
            }

            await query("UPDATE transactions SET amount = $1, description = $2 WHERE id = $3", [finalAmount, finalDesc, id]);
            await query("UPDATE users SET balance = balance + $1 WHERE id = $2", [finalAmount, oldTrans.user_id]);
        }
        
        res.redirect(`/activity/${activityId}/history`);
    } catch (err) {
        console.error(err);
        res.redirect(`/activity/${activityId}/history`);
    }
});

// 14. Delete Transaction (🔥 UPDATE: 軟刪除 - 保留紀錄但金額歸零)
app.post('/activity/:id/delete-transaction', async (req, res) => {
    const activityId = req.params.id;
    const { id } = req.body;
    try {
        const transRes = await query("SELECT * FROM transactions WHERE id = $1", [id]);
        const targetTrans = transRes.rows[0];

        if (targetTrans) {
            // 1. 先還原該用戶的餘額 (退錢)
            await query("UPDATE users SET balance = balance - $1 WHERE id = $2", 
                [parseFloat(targetTrans.amount), targetTrans.user_id]);

            // 2. 處理 Pickleball 連帶重算
            const match = targetTrans.description.match(/共\$(\d+(\.\d+)?)/);
            if (match) {
                const totalCost = parseFloat(match[1]);
                const recordDate = new Date(targetTrans.date).toISOString(); 

                // 找出同組的其他交易 (排除自己，也排除已經 Void 咗嘅紀錄)
                const siblingsRes = await query(`
                    SELECT * FROM transactions 
                    WHERE activity_id = $1 
                    AND description = $2 
                    AND date = $3 
                    AND id != $4
                    AND type != 'void'`, 
                    [activityId, targetTrans.description, recordDate, id]
                );
                const siblings = siblingsRes.rows;

                if (siblings.length > 0) {
                    const newCount = siblings.length; // 剩下的人數
                    // (注意：因為被刪除者退出了，所以總金額由剩下的人平分)
                    const newPerHeadCost = totalCost / newCount;
                    const newAmount = -newPerHeadCost;

                    for (const sibling of siblings) {
                        const oldAmount = parseFloat(sibling.amount);
                        await query("UPDATE users SET balance = balance - $1 WHERE id = $2", [oldAmount, sibling.user_id]);
                        await query("UPDATE users SET balance = balance + $1 WHERE id = $2", [newAmount, sibling.user_id]);
                        await query("UPDATE transactions SET amount = $1 WHERE id = $2", [newAmount, sibling.id]);
                    }
                }
            }

            // 3. 🔥 關鍵修改：不刪除紀錄，而是標記為「已刪除」並歸零
            const newDesc = `[已刪除] ${targetTrans.description}`;
            await query("UPDATE transactions SET type = 'void', amount = 0, description = $1 WHERE id = $2", 
                [newDesc, id]);
        }
        res.redirect(`/activity/${activityId}/history`);
    } catch (err) {
        console.error(err);
        res.redirect(`/activity/${activityId}/history`);
    }
});

app.post('/activity/:id/edit-user', async (req, res) => {
    await query("UPDATE users SET name = $1 WHERE id = $2", [req.body.name, req.body.id]);
    res.redirect(`/activity/${req.params.id}/users`);
});

app.post('/activity/:id/delete-user', async (req, res) => {
    await query("DELETE FROM users WHERE id = $1", [req.body.id]);
    res.redirect(`/activity/${req.params.id}/users`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));