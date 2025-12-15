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

// 5. Record Logic (🔥 UPDATE: Bowling Pool vs Cash Logic)
app.post('/activity/:id/record', async (req, res) => {
    const activityId = req.params.id;
    const { games, usePool, selectedUsers, totalCost, guests } = req.body; // 🔥 接收 usePool
    
    const recordTime = new Date(); 
    const cost = parseFloat(totalCost);

    try {
        if (isNaN(cost) || cost <= 0) {
            console.log("Validation Error: Invalid Total Cost");
            return res.redirect(`/activity/${activityId}`);
        }

        const actRes = await query("SELECT * FROM activities WHERE id = $1", [activityId]);
        const activity = actRes.rows[0];

        if (activity.type === 'bowling') {
            if (!games) return res.redirect(`/activity/${activityId}`);
            
            let totalGamesPlayed = 0;
            let userGameMap = {};

            // 統計局數 (不管有無夾 pool 都要計入分母)
            for (const [key, countStr] of Object.entries(games)) {
                const count = parseInt(countStr) || 0;
                if (count > 0) {
                    const userId = parseInt(key.replace('uid_', ''));
                    userGameMap[userId] = count;
                    totalGamesPlayed += count;
                }
            }

            if (totalGamesPlayed === 0) return res.redirect(`/activity/${activityId}`);

            const costPerGame = cost / totalGamesPlayed;

            // 寫入資料庫
            for (const [userIdStr, count] of Object.entries(userGameMap)) {
                const userId = parseInt(userIdStr);
                const myCost = count * costPerGame;
                
                // 檢查是否夾 Pool (usePool[uid_1] == 'on')
                // 如果 checkbox 無剔，body 入面就唔會有 usePool[uid_1]
                const isPooling = usePool && usePool[`uid_${userId}`] === 'on';

                if (isPooling) {
                    // ✅ 夾 Pool -> 正常扣數
                    const desc = `打波 ${count} 局 (共$${cost.toFixed(1)})`;
                    await query("INSERT INTO transactions (activity_id, user_id, type, amount, description, date) VALUES ($1, $2, 'expense', $3, $4, $5)", 
                        [activityId, userId, -myCost, desc, recordTime]);
                    await query("UPDATE users SET balance = balance - $1 WHERE id = $2", [myCost, userId]);
                } else {
                    // 💵 俾 Cash -> 紀錄 $0，但在描述備註
                    const desc = `打波 ${count} 局 (現金自付: $${myCost.toFixed(1)})`;
                    await query("INSERT INTO transactions (activity_id, user_id, type, amount, description, date) VALUES ($1, $2, 'expense', 0, $3, $4)", 
                        [activityId, userId, desc, recordTime]);
                    // 不更新 balance
                }
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
        console.error("DB Error in /record:", err);
        res.redirect(`/activity/${activityId}`);
    }
});

// 6. Deposit
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
        [name, parseFloat(cost)||0, parseFloat(threshold)||200, activityId]);
    res.redirect(`/activity/${activityId}?open=true`);
});

// 9. History Page (Grouped)
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
        
        // Grouping
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
            activity: actRes.rows[0]
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
        const users = usersRes.rows.map(u => ({...u, balance: parseFloat(u.balance)}));
        res.render('users', { users, activity: actRes.rows[0] });
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

// 12. Update Group Total (Auto Recalc)
app.post('/activity/:id/update-group-total', async (req, res) => {
    const activityId = req.params.id;
    const { timestamp, newTotal } = req.body;
    const totalCost = parseFloat(newTotal);

    try {
        const siblingsRes = await query(`
            SELECT * FROM transactions 
            WHERE activity_id = $1 AND date = $2 AND type != 'void'`, 
            [activityId, timestamp]
        );
        const records = siblingsRes.rows;

        if (records.length === 0 || isNaN(totalCost) || totalCost <= 0) {
            return res.redirect(`/activity/${activityId}/history`);
        }

        const isBowling = records[0].description.includes('打波');
        const isPickle = records[0].description.includes('夾場租');

        // Wipe old
        for (const t of records) {
            await query("UPDATE users SET balance = balance - $1 WHERE id = $2", [parseFloat(t.amount), t.user_id]);
            await query("DELETE FROM transactions WHERE id = $1", [t.id]);
        }

        // Recalculate
        if (isPickle) {
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
        } else if (isBowling) {
            let totalGames = 0;
            let userGamesMap = {};
            records.forEach(r => {
                const gameMatch = r.description.match(/打波 (\d+) 局/);
                const guestMatch = r.description.match(/Guest: (\d+)局/);
                const gMember = gameMatch ? parseInt(gameMatch[1]) : 0;
                const gGuest = guestMatch ? parseInt(guestMatch[1]) : 0;
                userGamesMap[r.user_id] = { m: gMember, g: gGuest };
                totalGames += (gMember + gGuest);
            });
            const costPerGame = totalCost / totalGames;
            for (const r of records) {
                const counts = userGamesMap[r.user_id];
                const myCost = counts.m * costPerGame;
                let desc = `打波 ${counts.m} 局`;
                if(counts.g > 0) desc += ` [Guest: ${counts.g}局]`;
                desc += ` (共$${totalCost})`;
                await query("INSERT INTO transactions (activity_id, user_id, type, amount, description, date) VALUES ($1, $2, 'expense', $3, $4, $5)", 
                    [activityId, r.user_id, -myCost, desc, timestamp]);
                await query("UPDATE users SET balance = balance - $1 WHERE id = $2", [myCost, r.user_id]);
            }
        }
        res.redirect(`/activity/${activityId}/history`);
    } catch (err) {
        console.error(err);
        res.redirect(`/activity/${activityId}/history`);
    }
});

// 13. Soft Delete (Recalc remaining)
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

            const match = targetTrans.description.match(/共\$(\d+(\.\d+)?)/);
            if (match) {
                const totalCost = parseFloat(match[1]);
                const siblingsRes = await query(`
                    SELECT * FROM transactions WHERE activity_id = $1 AND date = $2 AND id != $3 AND type != 'void'`, 
                    [activityId, targetTrans.date, id]);
                const siblings = siblingsRes.rows;

                if (siblings.length > 0) {
                    let totalHeads = 0;
                    let siblingHeadsMap = {};
                    siblings.forEach(sib => {
                        const guestMatch = sib.description.match(/\[(\d+)訪客\]/);
                        const g = guestMatch ? parseInt(guestMatch[1]) : 0;
                        const heads = 1 + g;
                        siblingHeadsMap[sib.id] = heads;
                        totalHeads += heads;
                    });

                    if (totalHeads > 0) {
                        const newPerHeadCost = totalCost / totalHeads;
                        for (const sibling of siblings) {
                            const myHeads = siblingHeadsMap[sibling.id];
                            const newAmount = -(newPerHeadCost * myHeads);
                            const oldAmount = parseFloat(sibling.amount);
                            const diff = newAmount - oldAmount;
                            await query("UPDATE transactions SET amount = $1 WHERE id = $2", [newAmount, sibling.id]);
                            await query("UPDATE users SET balance = balance + $1 WHERE id = $2", [diff, sibling.user_id]);
                        }
                    }
                }
            }
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