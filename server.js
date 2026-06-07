require('dotenv').config();
const express = require('express');
const webpush = require('web-push');
const cron = require('node-cron');
const path = require('path');
const { db, init } = require('./db');

// ─── UTILS ───────────────────────────────────────────────────────
function todayStr() { return new Date().toISOString().split('T')[0]; }

async function calculateStreak() {
  const allHabits = await db.all('SELECT id, days FROM habits');
  const today = new Date();
  let streak = 0;
  for (let i = 0; i < 366; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const dayNum = d.getDay();
    const applicable = allHabits.filter(h => { const days = JSON.parse(h.days); return days.length === 0 || days.includes(dayNum); });
    if (!applicable.length) continue;
    const ids = applicable.map(h => h.id);
    const row = await db.get(`SELECT COUNT(*) as cnt FROM habit_logs WHERE date=? AND status='done' AND habit_id IN (${ids.map(()=>'?').join(',')})`, dateStr, ...ids);
    const pct = row.cnt / applicable.length;
    if (i === 0 && pct < 0.5) continue;
    if (pct >= 0.5) streak++; else break;
  }
  return streak;
}

async function calcHabitPct(numDays) {
  const allHabits = await db.all('SELECT id, days FROM habits');
  const today = new Date();
  let total = 0, done = 0;
  for (let i = 0; i < numDays; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const dayNum = d.getDay();
    const applicable = allHabits.filter(h => { const days = JSON.parse(h.days); return days.length === 0 || days.includes(dayNum); });
    if (!applicable.length) continue;
    total += applicable.length;
    const ids = applicable.map(h => h.id);
    const row = await db.get(`SELECT COUNT(*) as cnt FROM habit_logs WHERE date=? AND status='done' AND habit_id IN (${ids.map(()=>'?').join(',')})`, dateStr, ...ids);
    done += row.cnt;
  }
  return total > 0 ? Math.round(done / total * 100) : 0;
}

async function getCalendarDays() {
  const allHabits = await db.all('SELECT id, days FROM habits');
  const today = new Date();
  const todayStr2 = today.toISOString().split('T')[0];
  const result = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    if (dateStr > todayStr2) { result.push({ date: dateStr, status: 'future' }); continue; }
    const dayNum = d.getDay();
    const applicable = allHabits.filter(h => { const days = JSON.parse(h.days); return days.length === 0 || days.includes(dayNum); });
    if (!applicable.length) { result.push({ date: dateStr, status: 'gray' }); continue; }
    const ids = applicable.map(h => h.id);
    const row = await db.get(`SELECT COUNT(*) as cnt FROM habit_logs WHERE date=? AND status='done' AND habit_id IN (${ids.map(()=>'?').join(',')})`, dateStr, ...ids);
    const pct = row.cnt / applicable.length;
    result.push({ date: dateStr, status: pct >= 0.5 ? 'green' : pct > 0 ? 'yellow' : 'gray' });
  }
  return result;
}

async function habitStreak(habitId, daysArr) {
  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 366; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const dayNum = d.getDay();
    if (daysArr.length > 0 && !daysArr.includes(dayNum)) continue;
    const log = await db.get('SELECT status FROM habit_logs WHERE habit_id=? AND date=?', habitId, dateStr);
    if (i === 0 && (!log || log.status !== 'done')) continue;
    if (log && log.status === 'done') streak++; else break;
  }
  return streak;
}

// ─── SETUP ───────────────────────────────────────────────────────
async function setupVapid() {
  let row = await db.get("SELECT value FROM settings WHERE key = ?", 'vapid_public');
  if (!row) {
    const keys = webpush.generateVAPIDKeys();
    await db.run('INSERT INTO settings (key, value) VALUES (?,?)', 'vapid_public', JSON.stringify(keys.publicKey));
    await db.run('INSERT INTO settings (key, value) VALUES (?,?)', 'vapid_private', JSON.stringify(keys.privateKey));
    console.log('VAPID keys generated');
  }
  const pub = JSON.parse((await db.get("SELECT value FROM settings WHERE key=?", 'vapid_public')).value);
  const priv = JSON.parse((await db.get("SELECT value FROM settings WHERE key=?", 'vapid_private')).value);
  webpush.setVapidDetails('mailto:volff1207@gmail.com', pub, priv);
  return pub;
}

// ─── MAIN ────────────────────────────────────────────────────────
async function start() {
  await init();
  const vapidPublicKey = await setupVapid();

  // Push cron (каждую минуту)
  cron.schedule('* * * * *', async () => {
    const t = new Date(); const ts = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
    const triggered = await db.all('SELECT * FROM push_settings WHERE enabled=1 AND time=?', ts);
    if (!triggered.length) return;
    const subs = await db.all('SELECT * FROM push_subscriptions');
    for (const sub of subs) {
      const subscription = { endpoint: sub.endpoint, keys: JSON.parse(sub.keys) };
      for (const s of triggered) {
        try { await webpush.sendNotification(subscription, JSON.stringify({ title: 'Life Tracker', body: s.name, url: '/' })); }
        catch (err) { if (err.statusCode === 410 || err.statusCode === 404) await db.run('DELETE FROM push_subscriptions WHERE endpoint=?', sub.endpoint); }
      }
    }
  });

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // ─── HABITS ────────────────────────────────────────────────────
  app.get('/api/habits', async (req, res) => {
    try {
      const habits = await db.all('SELECT * FROM habits ORDER BY id');
      const result = await Promise.all(habits.map(async h => {
        const days = JSON.parse(h.days);
        return { ...h, days, streak: await habitStreak(h.id, days) };
      }));
      res.json(result);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/habits', async (req, res) => {
    try {
      const { name, days = [] } = req.body;
      const r = await db.run('INSERT INTO habits (name, days) VALUES (?,?)', name, JSON.stringify(days));
      res.json({ id: r.lastInsertRowid, name, days, streak: 0 });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/habits/:id', async (req, res) => {
    try {
      const { name, days } = req.body;
      const sets = []; const vals = [];
      if (name !== undefined) { sets.push('name=?'); vals.push(name); }
      if (days !== undefined) { sets.push('days=?'); vals.push(JSON.stringify(days)); }
      if (!sets.length) return res.json({ ok: true });
      await db.run(`UPDATE habits SET ${sets.join(',')} WHERE id=?`, ...vals, req.params.id);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/habits/:id', async (req, res) => {
    try { await db.run('DELETE FROM habits WHERE id=?', req.params.id); res.json({ ok: true }); }
    catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/habits/logs', async (req, res) => {
    try { res.json(await db.all('SELECT * FROM habit_logs WHERE date=?', req.query.date || todayStr())); }
    catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/habits/:id/log', async (req, res) => {
    try {
      const { date, status } = req.body;
      const d = date || todayStr();
      if (!status) await db.run('DELETE FROM habit_logs WHERE habit_id=? AND date=?', req.params.id, d);
      else await db.run('INSERT OR REPLACE INTO habit_logs (habit_id, date, status) VALUES (?,?,?)', req.params.id, d, status);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── SCHEDULE ──────────────────────────────────────────────────
  app.get('/api/schedule', async (req, res) => {
    try { res.json(await db.all('SELECT * FROM schedule_blocks ORDER BY time')); }
    catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/schedule', async (req, res) => {
    try {
      const { time, name, type = 'work' } = req.body;
      const r = await db.run('INSERT INTO schedule_blocks (time, name, type) VALUES (?,?,?)', time, name, type);
      res.json({ id: r.lastInsertRowid, time, name, type });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/schedule/:id', async (req, res) => {
    try {
      const { time, name, type } = req.body;
      await db.run('UPDATE schedule_blocks SET time=?,name=?,type=? WHERE id=?', time, name, type, req.params.id);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/schedule/:id', async (req, res) => {
    try { await db.run('DELETE FROM schedule_blocks WHERE id=?', req.params.id); res.json({ ok: true }); }
    catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── WORKOUTS ──────────────────────────────────────────────────
  app.get('/api/workouts', async (req, res) => {
    try {
      const days = await db.all('SELECT * FROM workout_days ORDER BY day_num');
      const result = await Promise.all(days.map(async day => ({
        ...day,
        exercises: await db.all('SELECT * FROM exercises WHERE workout_day_id=? ORDER BY position', day.id)
      })));
      res.json(result);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.patch('/api/workouts/:dayNum', async (req, res) => {
    try { await db.run('UPDATE workout_days SET name=? WHERE day_num=?', req.body.name, req.params.dayNum); res.json({ ok: true }); }
    catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/workouts/:dayNum/exercises', async (req, res) => {
    try {
      const { name, sets = 3, reps = '10' } = req.body;
      const day = await db.get('SELECT id FROM workout_days WHERE day_num=?', req.params.dayNum);
      if (!day) return res.status(404).json({ error: 'Day not found' });
      const maxPos = await db.get('SELECT MAX(position) as mp FROM exercises WHERE workout_day_id=?', day.id);
      const pos = (maxPos?.mp ?? -1) + 1;
      const r = await db.run('INSERT INTO exercises (workout_day_id, name, sets, reps, position) VALUES (?,?,?,?,?)', day.id, name, sets, reps, pos);
      res.json({ id: r.lastInsertRowid, name, sets, reps, position: pos });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/workouts/exercises/:id', async (req, res) => {
    try { await db.run('DELETE FROM exercises WHERE id=?', req.params.id); res.json({ ok: true }); }
    catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/workouts/sessions', async (req, res) => {
    try {
      const { date, dayNum, exerciseId } = req.query;
      let q = 'SELECT * FROM workout_sessions WHERE 1=1'; const p = [];
      if (date) { q += ' AND date=?'; p.push(date); }
      if (dayNum !== undefined) { q += ' AND day_num=?'; p.push(dayNum); }
      if (exerciseId) { q += ' AND exercise_id=?'; p.push(exerciseId); }
      q += ' ORDER BY date DESC, set_num ASC';
      res.json(await db.all(q, ...p));
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/workouts/sessions', async (req, res) => {
    try {
      const { date, day_num, exercise_id, set_num, reps_done, weight } = req.body;
      const r = await db.run('INSERT INTO workout_sessions (date, day_num, exercise_id, set_num, reps_done, weight) VALUES (?,?,?,?,?,?)',
        date || todayStr(), day_num, exercise_id, set_num, reps_done ?? null, weight ?? null);
      res.json({ id: r.lastInsertRowid });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/workouts/sessions/:id', async (req, res) => {
    try { await db.run('DELETE FROM workout_sessions WHERE id=?', req.params.id); res.json({ ok: true }); }
    catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── SMOKE ─────────────────────────────────────────────────────
  app.get('/api/smoke', async (req, res) => {
    try {
      const d = req.query.date || todayStr();
      const logs = await db.all("SELECT * FROM smoke_logs WHERE date(datetime)=? ORDER BY datetime DESC", d);
      const sevenAgo = new Date(); sevenAgo.setDate(sevenAgo.getDate() - 6);
      const sevenAgoStr = sevenAgo.toISOString().split('T')[0];
      const weekRow = await db.get("SELECT COUNT(*) as cnt FROM smoke_logs WHERE date(datetime)>=?", sevenAgoStr);
      const weekCount = weekRow.cnt;
      const triggers = await db.all("SELECT trigger, COUNT(*) as cnt FROM smoke_logs WHERE date(datetime)>=? AND trigger IS NOT NULL GROUP BY trigger ORDER BY cnt DESC LIMIT 5", sevenAgoStr);
      res.json({ logs, todayCount: logs.length, weekCount, avgDay: Math.round(weekCount / 7 * 10) / 10, triggers });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/smoke', async (req, res) => {
    try { const r = await db.run("INSERT INTO smoke_logs (trigger) VALUES (?)", req.body.trigger || null); res.json({ id: r.lastInsertRowid }); }
    catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/smoke/:id', async (req, res) => {
    try { await db.run('DELETE FROM smoke_logs WHERE id=?', req.params.id); res.json({ ok: true }); }
    catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── STATS ─────────────────────────────────────────────────────
  app.get('/api/stats', async (req, res) => {
    try {
      const today = new Date(); const todayStr2 = today.toISOString().split('T')[0];
      const weekStart = new Date(today); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const sevenAgo = new Date(today); sevenAgo.setDate(sevenAgo.getDate() - 6);
      const weekWorkouts = (await db.get("SELECT COUNT(DISTINCT date) as cnt FROM workout_sessions WHERE date>=?", weekStart.toISOString().split('T')[0])).cnt;
      const smokeWeek = (await db.get("SELECT COUNT(*) as cnt FROM smoke_logs WHERE date(datetime)>=?", sevenAgo.toISOString().split('T')[0])).cnt;
      const startRow = await db.get("SELECT value FROM settings WHERE key='start_date'");
      const startDate = startRow ? JSON.parse(startRow.value) : todayStr2;
      const dayCount = Math.max(1, Math.floor((new Date(todayStr2) - new Date(startDate)) / 86400000) + 1);
      res.json({ streak: await calculateStreak(), weekWorkouts, habitPercent7: await calcHabitPct(7), smokeWeek, calendarDays: await getCalendarDays(), startDate, dayCount });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── SETTINGS ──────────────────────────────────────────────────
  app.get('/api/settings', async (req, res) => {
    try {
      const rows = await db.all('SELECT key, value FROM settings');
      const s = {}; rows.forEach(r => { s[r.key] = JSON.parse(r.value); });
      res.json(s);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/settings', async (req, res) => {
    try {
      for (const [k, v] of Object.entries(req.body)) await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', k, JSON.stringify(v));
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── PUSH ──────────────────────────────────────────────────────
  app.get('/api/push/vapidkey', (req, res) => res.json({ publicKey: vapidPublicKey }));

  app.post('/api/push/subscribe', async (req, res) => {
    try {
      const { endpoint, keys } = req.body;
      await db.run('INSERT OR REPLACE INTO push_subscriptions (endpoint, keys) VALUES (?,?)', endpoint, JSON.stringify(keys));
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/push/subscribe', async (req, res) => {
    try { await db.run('DELETE FROM push_subscriptions WHERE endpoint=?', req.body.endpoint); res.json({ ok: true }); }
    catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/push/settings', async (req, res) => {
    try { res.json(await db.all('SELECT * FROM push_settings ORDER BY time')); }
    catch(e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/push/settings/:id', async (req, res) => {
    try {
      const { name, time, enabled } = req.body;
      const sets = []; const vals = [];
      if (name !== undefined) { sets.push('name=?'); vals.push(name); }
      if (time !== undefined) { sets.push('time=?'); vals.push(time); }
      if (enabled !== undefined) { sets.push('enabled=?'); vals.push(enabled ? 1 : 0); }
      if (!sets.length) return res.json({ ok: true });
      await db.run(`UPDATE push_settings SET ${sets.join(',')} WHERE id=?`, ...vals, req.params.id);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ─── START ─────────────────────────────────────────────────────
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\nLife Tracker: http://localhost:${PORT}\n`);
    const { networkInterfaces } = require('os');
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const iface of ifaces) {
        if (iface.family === 'IPv4' && !iface.internal) console.log(`Телефон (Wi-Fi): http://${iface.address}:${PORT}`);
      }
    }
  });
}

start().catch(err => { console.error('Ошибка запуска:', err); process.exit(1); });
