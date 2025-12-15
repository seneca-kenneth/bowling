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
    await query("INSERT INTO activities (name, cost_per_game, type) VALUES ($1, $2, $3)", 
        [name, parseFloat(cost) || 0, activityType]);
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

// 5. Record Logic (🔥 UPDATE: Better Description Format)
app.post('/activity/:id/record', async (req, res) => {
    const activityId = req.params.id;
    const { games, guestGames, selectedUsers, totalCost, guests } = req.body; 
    
    const recordTime = new Date(); 
    const cost = parseFloat(totalCost); 

    try {
        if (isNaN(cost) || cost <= 0) return res.redirect(`/activity/${activityId}`);

        const actRes = await query("SELECT * FROM activities WHERE id = $1", [activityId]);
        const activity = actRes.rows[0];

        if (activity.type === 'bowling') {
            const guestCount = parseInt(guestGames) || 0;
            
            if (!games && guestCount === 0) return res.redirect(`/activity/${activityId}`);
            
            let totalGamesPlayed = guestCount;
            let userGameMap = {};

            if (games) {
                for (const [key, countStr] of Object.entries(games)) {
                    const count = parseInt(countStr) || 0;
                    if (count > 0) {
                        const userId = parseInt(key.replace('uid_', ''));
                        userGameMap[userId] = count;
                        totalGamesPlayed += count;
                    }
                }
            }

            if (totalGamesPlayed === 0) return res.redirect(`/activity/${activityId}`);

            const costPerGame = cost / totalGamesPlayed;

            // 寫入
            for (const [userIdStr, count] of Object.entries(userGameMap)) {
                const userId = parseInt(userIdStr);
                const myCost = count * costPerGame;
                
                // 🔥 Description 格式: "打波 3 局 [Guest: 2] (共$100.0)"
                // 這樣方便之後 Regex 讀取
                let desc = `打波 ${count} 局`;
                if (guestCount > 0) desc += ` [Guest: ${guestCount}]`; 
                desc += ` (共$${cost.toFixed(1)})`;

                await query("INSERT INTO transactions (activity_id, user_id, type, amount, description, date) VALUES ($1, $2, 'expense', $3, $4, $5)", 
                    [activityId, userId, -myCost, desc, recordTime]);
                
                await query("UPDATE users SET balance = balance - $1 WHERE id = $2", [myCost, userId]);
            }

        } else {
            // ... (Pickleball logic 保持不變) ...
            let userIds = [];
            if (Array.isArray(selectedUsers)) userIds = selectedUsers;
            else if (selectedUsers) userIds = [selectedUsers];
            
            if (userIds.length === 0) return res.redirect(`/activity/${activityId}`);

            let totalHeads = 0;
            let userHeadsMap = {};

            userIds.forEach(uid => {
                let myGuest = 0;
                if (guests && guests[`uid_${uid}`]) {
                    myGuest = parseInt(guests[`uid_${uid}`]) || 0;
                }
                const myTotal = 1 + myGuest; 
                userHeadsMap[uid] = myTotal;
                totalHeads += myTotal;
            });
            
            if (totalHeads > 0) {
                const perHeadCost = cost / totalHeads;
                for (const userId of userIds) {
                    const myHeads = userHeadsMap[userId];
                    const myCost = perHeadCost * myHeads;
                    let desc = `夾場租 (共$${cost})`;
                    if (myHeads > 1) desc += ` [${myHeads-1}訪客]`;
                    await query("INSERT INTO transactions (activity_id, user_id, type, amount, description, date) VALUES ($1, $2, 'expense', $3, $4, $5)", 
                        [activityId, userId, -myCost, desc, recordTime]);
                    await query("UPDATE users SET balance = balance - $1 WHERE id = $2", [myCost, userId]);
                }
            }
        }

        res.redirect(`/activity/${activityId}`);
    } catch (err) {
        console.error("DB Error in /record:", err);
        res.redirect(`/activity/${activityId}`);
    }
});

// 6. Deposit (Keep same)
app.post('/activity/:id/deposit', async (req, res) => {
    const activityId = req.params.id;
    const { userId, amount } = req.body;
    const val = parseFloat(amount) || 0;
    if (val > 0) {
        await query("INSERT INTO transactions (activity_id, user_id, type, amount, description, date) VALUES ($1, $2, 'deposit', $3, '入數', NOW())", [activityId, userId, val]);
        await query("UPDATE users SET balance = balance + $1 WHERE id = $2", [val, userId]);
    }
    res.redirect(`/activity/${activityId}/users`);
});

// 7. Add User (Keep same)
app.post('/activity/:id/add-user', async (req, res) => {
    const activityId = req.params.id;
    if(req.body.name) {
        await query("INSERT INTO users (activity_id, name, balance) VALUES ($1, $2, 0)", [activityId, req.body.name]);
    }
    res.redirect(`/activity/${activityId}/users`);
});

// 8. Settings (Keep same)
app.post('/activity/:id/settings', async (req, res) => {
    const activityId = req.params.id;
    const { name, cost, threshold } = req.body;
    await query("UPDATE activities SET name = $1, cost_per_game = $2, alert_threshold = $3 WHERE id = $4", 
        [name, parseFloat(cost)||0, parseFloat(threshold)||200, activityId]);
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
            ORDER BY t.date DESC`;
        const transRes = await query(sql, [activityId]);
        const actRes = await query("SELECT * FROM activities WHERE id = $1", [activityId]);
        const usersRes = await query("SELECT * FROM users WHERE activity_id = $1 ORDER BY name ASC", [activityId]); // For dropdowns
        
        const groups = {};
        transRes.rows.forEach(t => {
            const dateKey = new Date(t.date).toISOString(); 
            if (!groups[dateKey]) {
                groups[dateKey] = {
                    date: t.date,
                    timestamp: dateKey,
                    total: 0,
                    type: t.type, 
                    records: [],
                    isBowling: t.description.includes('打波'),
                    isPickle: t.description.includes('夾場租')
                };
            }
            if (t.type === 'expense') groups[dateKey].total += Math.abs(parseFloat(t.amount));
            else if (t.type === 'deposit') groups[dateKey].total += parseFloat(t.amount);

            groups[dateKey].records.push({ ...t, amount: parseFloat(t.amount) });
        });

        const groupArray = Object.values(groups).sort((a, b) => b.date - a.date);

        res.render('history', { 
            groupedTransactions: groupArray,
            activity: actRes.rows[0],
            users: usersRes.rows // Pass users for edit modal
        });
    } catch (err) {
        console.error(err);
        res.send("Error");
    }
});

// 10. Users Page (Keep same)
app.get('/activity/:id/users', async (req, res) => {
    const activityId = req.params.id;
    try {
        const actRes = await query("SELECT * FROM activities WHERE id = $1", [activityId]);
        const usersRes = await query("SELECT * FROM users WHERE activity_id = $1 ORDER BY name ASC", [activityId]);
        const users = usersRes.rows.map(u => ({...u, balance: parseFloat(u.balance)}));
        res.render('users', { users, activity: actRes.rows[0] });
    } catch (err) {
        console.error(err);
        res.send("Error");
    }
});

// 11. Share Page (Keep same)
app.get('/activity/:id/share', async (req, res) => {
    const activityId = req.params.id;
    try {
        const actRes = await query("SELECT * FROM activities WHERE id = $1", [activityId]);
        if (!actRes.rows[0]) return res.send("Activity not found");
        const usersRes = await query("SELECT * FROM users WHERE activity_id = $1 ORDER BY name ASC", [activityId]);
        const users = usersRes.rows.map(u => ({...u, balance: parseFloat(u.balance)}));
        const transRes = await query(`
            SELECT t.amount, t.description, t.date, t.type, u.name 
            FROM transactions t JOIN users u ON t.user_id = u.id 
            WHERE t.activity_id = $1 ORDER BY t.date DESC LIMIT 20`, [activityId]);
        const transactions = transRes.rows.map(t => ({...t, amount: parseFloat(t.amount), date: new Date(t.date).toISOString()}));
        res.render('share', { activity: actRes.rows[0], users, transactions });
    } catch (err) {
        console.error(err);
        res.send("Error");
    }
});

// 🔥 NEW API: Get Session Details (For Edit Modal)
app.get('/activity/:id/session/:timestamp/details', async (req, res) => {
    const { id, timestamp } = req.params;
    try {
        const result = await query(`
            SELECT user_id, description, amount FROM transactions 
            WHERE activity_id = $1 AND date = $2 AND type != 'void'`, 
            [id, timestamp]
        );
        
        let totalCost = 0;
        let guestGames = 0;
        let userGames = {};

        // Parse data
        result.rows.forEach(r => {
            totalCost += Math.abs(parseFloat(r.amount));
            
            // Bowling Parse: "打波 3 局 [Guest: 2] (共$100.0)"
            const gameMatch = r.description.match(/打波 (\d+) 局/);
            if (gameMatch) userGames[r.user_id] = parseInt(gameMatch[1]);

            // Guest Count is redundant in all descriptions, just pick one (max)
            const guestMatch = r.description.match(/\[Guest: (\d+)\]/);
            if (guestMatch) {
                guestGames = Math.max(guestGames, parseInt(guestMatch[1]));
            }
        });

        res.json({ totalCost, guestGames, userGames });
    } catch (err) {
        console.error(err);
        res.json({ error: true });
    }
});

// 🔥 NEW: Update Bowling Session (Complex Recalc)
app.post('/activity/:id/update-bowling-session', async (req, res) => {
    const activityId = req.params.id;
    const { timestamp, totalCost, guestGames, userGames } = req.body;
    const cost = parseFloat(totalCost);
    const guestCount = parseInt(guestGames) || 0;

    try {
        // 1. Wipe Old
        const oldRecords = await query("SELECT * FROM transactions WHERE activity_id = $1 AND date = $2 AND type != 'void'", [activityId, timestamp]);
        for (const t of oldRecords.rows) {
            await query("UPDATE users SET balance = balance - $1 WHERE id = $2", [parseFloat(t.amount), t.user_id]);
            await query("DELETE FROM transactions WHERE id = $1", [t.id]);
        }

        // 2. Recalculate
        let totalGamesPlayed = guestCount;
        let userGameMap = {};

        if (userGames) {
            for (const [userId, countStr] of Object.entries(userGames)) {
                const count = parseInt(countStr) || 0;
                if (count > 0) {
                    userGameMap[userId] = count;
                    totalGamesPlayed += count;
                }
            }
        }

        if (totalGamesPlayed > 0 && cost > 0) {
            const costPerGame = cost / totalGamesPlayed;

            for (const [userIdStr, count] of Object.entries(userGameMap)) {
                const userId = parseInt(userIdStr);
                const myCost = count * costPerGame;
                
                let desc = `打波 ${count} 局`;
                if (guestCount > 0) desc += ` [Guest: ${guestCount}]`; 
                desc += ` (共$${cost.toFixed(1)})`;

                await query("INSERT INTO transactions (activity_id, user_id, type, amount, description, date) VALUES ($1, $2, 'expense', $3, $4, $5)", 
                    [activityId, userId, -myCost, desc, timestamp]);
                await query("UPDATE users SET balance = balance - $1 WHERE id = $2", [myCost, userId]);
            }
        }

        res.redirect(`/activity/${activityId}/history`);
    } catch (err) {
        console.error(err);
        res.redirect(`/activity/${activityId}/history`);
    }
});

// 12. Update Group Total (Pickleball Only now - Simple weighted recalc)
app.post('/activity/:id/update-group-total', async (req, res) => {
    // ... (Keep existing Logic for Pickleball)
    // 為了節省篇幅，請保留原有 Step 12 的 Pickleball 部分
    // Bowling 已經由 update-bowling-session 接手
    const activityId = req.params.id;
    const { timestamp, newTotal } = req.body;
    const totalCost = parseFloat(newTotal);

    try {
        const siblingsRes = await query(`SELECT * FROM transactions WHERE activity_id = $1 AND date = $2 AND type != 'void'`, [activityId, timestamp]);
        const records = siblingsRes.rows;
        if (records.length === 0) return res.redirect(`/activity/${activityId}/history`);

        // Wipe old
        for (const t of records) {
            await query("UPDATE users SET balance = balance - $1 WHERE id = $2", [parseFloat(t.amount), t.user_id]);
            await query("DELETE FROM transactions WHERE id = $1", [t.id]);
        }

        // Recalc (Assuming Pickleball logic here for simplicity as Bowling uses the other route)
        let totalHeads = 0;
        let userHeadsMap = {};
        records.forEach(r => {
            const guestMatch = r.description.match(/\[(\d+)訪客\]/);
            const g = guestMatch ? parseInt(guestMatch[1]) : 0;
            const heads = 1 + g;
            userHeadsMap[r.user_id] = heads;
            totalHeads += heads;
        });
        const perHeadCost = totalCost / totalHeads;
        for (const r of records) {
            const myHeads = userHeadsMap[r.user_id];
            const myCost = perHeadCost * myHeads;
            let desc = `夾場租 (共$${totalCost})`;
            if (myHeads > 1) desc += ` [${myHeads-1}訪客]`;
            await query("INSERT INTO transactions (activity_id, user_id, type, amount, description, date) VALUES ($1, $2, 'expense', $3, $4, $5)", 
                [activityId, r.user_id, -myCost, desc, timestamp]);
            await query("UPDATE users SET balance = balance - $1 WHERE id = $2", [myCost, r.user_id]);
        }
        res.redirect(`/activity/${activityId}/history`);
    } catch (err) {
        console.error(err);
        res.redirect(`/activity/${activityId}/history`);
    }
});

// 13. Soft Delete
app.post('/activity/:id/delete-transaction', async (req, res) => {
    const activityId = req.params.id;
    const { id } = req.body;
    try {
        const transRes = await query("SELECT * FROM transactions WHERE id = $1", [id]);
        const targetTrans = transRes.rows[0];
        if (targetTrans) {
            await query("UPDATE users SET balance = balance - $1 WHERE id = $2", [parseFloat(targetTrans.amount), targetTrans.user_id]);
            const newDesc = `[已刪除] ${targetTrans.description}`;
            await query("UPDATE transactions SET type = 'void', amount = 0, description = $1 WHERE id = $2", [newDesc, id]);
        }
        res.redirect(`/activity/${activityId}/history`);
    } catch (err) {
        console.error(err);
        res.redirect(`/activity/${activityId}/history`);
    }
});

app.post('/activity/:id/edit-user', async (req, res) => { await query("UPDATE users SET name = $1 WHERE id = $2", [req.body.name, req.body.id]); res.redirect(`/activity/${req.params.id}/users`); });
app.post('/activity/:id/delete-user', async (req, res) => { await query("DELETE FROM users WHERE id = $1", [req.body.id]); res.redirect(`/activity/${req.params.id}/users`); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`App running on port ${PORT}`));