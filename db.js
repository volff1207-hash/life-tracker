const { createClient } = require('@libsql/client');

// Локально: TURSO_DB_URL=file:./db.sqlite (или не задан — дефолт)
// На Render: TURSO_DB_URL=libsql://... + TURSO_DB_TOKEN=...
function getClient() {
  const url = process.env.TURSO_DB_URL || 'file:./db.sqlite';
  const authToken = process.env.TURSO_DB_TOKEN || undefined;
  return createClient({ url, authToken });
}

let _client;
function client() {
  if (!_client) _client = getClient();
  return _client;
}

// Тонкая async-обёртка для удобного использования в server.js
const db = {
  async exec(sql) {
    await client().executeMultiple(sql);
  },
  async run(sql, ...args) {
    const rs = await client().execute({ sql, args });
    return { lastInsertRowid: Number(rs.lastInsertRowid), changes: rs.rowsAffected };
  },
  async get(sql, ...args) {
    const rs = await client().execute({ sql, args });
    return rs.rows[0] ?? undefined;
  },
  async all(sql, ...args) {
    const rs = await client().execute({ sql, args });
    return Array.from(rs.rows);
  },
};

async function init() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      days TEXT NOT NULL DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS habit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      habit_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      status TEXT NOT NULL,
      UNIQUE(habit_id, date)
    );
    CREATE TABLE IF NOT EXISTS schedule_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'work'
    );
    CREATE TABLE IF NOT EXISTS workout_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day_num INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workout_day_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sets INTEGER DEFAULT 3,
      reps TEXT DEFAULT '10',
      position INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS workout_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      day_num INTEGER NOT NULL,
      exercise_id INTEGER NOT NULL,
      set_num INTEGER NOT NULL,
      reps_done INTEGER,
      weight REAL
    );
    CREATE TABLE IF NOT EXISTS smoke_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      datetime TEXT DEFAULT (datetime('now', 'localtime')),
      trigger TEXT
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL UNIQUE,
      keys TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      time TEXT NOT NULL,
      enabled INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const seeded = await db.get("SELECT value FROM settings WHERE key = ?", 'seeded');
  if (!seeded) await seedDefaults();
}

async function seedDefaults() {
  for (const h of [
    ['Лёг в 23:00', '[]'], ['Встал в 07:00', '[]'], ['Стакан воды утром', '[]'],
    ['Тренировка по плану', '[1,2,4,5]'], ['Без энергетиков', '[]'],
    ['Белок в каждом приёме', '[]'], ['Умылся утром/вечером', '[]'],
    ['Шампунь от перхоти', '[1,4,6]'], ['Телефон за 30 мин до сна', '[]'],
  ]) await db.run('INSERT INTO habits (name, days) VALUES (?, ?)', ...h);

  for (const b of [
    ['07:00', 'Подъём — стакан воды до телефона', 'sleep'],
    ['07:15', 'Тренировка / кардио 25–40 мин', 'workout'],
    ['08:00', 'Завтрак с белком', 'food'],
    ['09:00', 'Продуктивный блок #1 — 25 мин', 'work'],
    ['13:00', 'Обед', 'food'],
    ['14:00', 'Продуктивный блок #2', 'work'],
    ['18:00', 'Свободное время / прогулка', 'rest'],
    ['20:00', 'Ужин лёгкий', 'food'],
    ['22:30', 'Телефон в сторону', 'sleep'],
    ['23:00', 'Сон', 'sleep'],
  ]) await db.run('INSERT INTO schedule_blocks (time, name, type) VALUES (?, ?, ?)', ...b);

  for (const d of [
    [0,'Отдых/Кардио'],[1,'День A (Толчок)'],[2,'День B (Тяга)'],
    [3,'Отдых/Кардио'],[4,'День A (Толчок)'],[5,'День B (Тяга)'],[6,'Отдых/Кардио'],
  ]) await db.run('INSERT INTO workout_days (day_num, name) VALUES (?, ?)', ...d);

  const getDayId = async n => (await db.get('SELECT id FROM workout_days WHERE day_num = ?', n)).id;

  const exA = [
    ['Отжимания широким',3,'max'],['Отжимания узким',3,'10'],
    ['Жим гантелей лёжа 8кг',3,'12'],['Разводка гантелей 6кг',3,'12'],
    ['Планка',3,'30 сек'],['Скакалка интервалы',1,'10 мин'],
  ];
  const exB = [
    ['Подтягивания',3,'max'],['Тяга гантели 8кг',3,'12'],
    ['Сгибание рук 6кг',3,'12'],['Скручивания',3,'20'],
    ['Подъём ног',3,'15'],['Скакалка интервалы',1,'10 мин'],
  ];
  const exRest = [
    ['Ходьба 30–40 мин или скакалка 10 мин',1,'1'],['Растяжка',1,'10 мин'],
  ];

  for (const n of [1, 4]) { const id = await getDayId(n); for (const [i,e] of exA.entries()) await db.run('INSERT INTO exercises (workout_day_id, name, sets, reps, position) VALUES (?,?,?,?,?)', id, e[0], e[1], e[2], i); }
  for (const n of [2, 5]) { const id = await getDayId(n); for (const [i,e] of exB.entries()) await db.run('INSERT INTO exercises (workout_day_id, name, sets, reps, position) VALUES (?,?,?,?,?)', id, e[0], e[1], e[2], i); }
  for (const n of [0, 3, 6]) { const id = await getDayId(n); for (const [i,e] of exRest.entries()) await db.run('INSERT INTO exercises (workout_day_id, name, sets, reps, position) VALUES (?,?,?,?,?)', id, e[0], e[1], e[2], i); }

  for (const p of [
    ['Доброе утро! Вода и тренировка','07:00',1],
    ['Время продуктивного блока','09:00',1],
    ['Обед — не забудь белок','13:00',1],
    ['Убери телефон, скоро спать','22:30',1],
    ['Пора спать','23:00',1],
  ]) await db.run('INSERT INTO push_settings (name, time, enabled) VALUES (?,?,?)', ...p);

  const today = new Date().toISOString().split('T')[0];
  for (const [k,v] of [
    ['sleep_time','"23:00"'],['wake_time','"07:00"'],
    ['start_date', JSON.stringify(today)],['seeded','"1"'],
  ]) await db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)', k, v);
}

module.exports = { db, init };
