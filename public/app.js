/* ─── API ────────────────────────────────────────────────────────── */
async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

/* ─── UTILS ─────────────────────────────────────────────────────── */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function todayDayNum() { return new Date().getDay(); }
function fmtTime(dt) {
  const d = new Date(dt);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function sleepDuration(sleep, wake) {
  const [sh,sm] = sleep.split(':').map(Number);
  const [wh,wm] = wake.split(':').map(Number);
  let mins = (wh*60+wm) - (sh*60+sm);
  if (mins < 0) mins += 1440;
  return `${Math.floor(mins/60)}ч ${mins%60 ? (mins%60)+'м' : ''}`.trim();
}
function timeToMins(t) { const [h,m] = t.split(':').map(Number); return h*60+m; }
function minsToTime(m) { return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`; }
function countdown(targetTime) {
  const [th,tm] = targetTime.split(':').map(Number);
  const now = new Date();
  let diff = (th*60+tm) - (now.getHours()*60+now.getMinutes());
  if (diff < 0) diff += 1440;
  const h = Math.floor(diff/60), m = diff%60;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}
const DAY_NAMES = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
const REST_DAYS = [0, 3, 6];
const TYPE_LABELS = { sleep: 'Сон', workout: 'Тренировка', food: 'Питание', work: 'Работа', rest: 'Отдых' };
const TRIGGERS = ['Стресс','Скука','После еды','После кофе','За компом','На улице','Компания'];

/* ─── STATE ─────────────────────────────────────────────────────── */
let activeTab = 'today';
let activeWorkout = null;       // running session state
let sleepCountdownInterval = null;
let activeWorkoutDay = todayDayNum();
let editHabitsMode = false;

/* ─── NAVIGATION ────────────────────────────────────────────────── */
function navigate(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  clearInterval(sleepCountdownInterval);
  renderTab(tab);
}

async function renderTab(tab) {
  const el = document.getElementById('tab-content');
  el.innerHTML = '<div class="loading-screen"><div class="spinner"></div></div>';
  try {
    if (tab === 'today') await renderToday(el);
    else if (tab === 'schedule') await renderSchedule(el);
    else if (tab === 'workout') await renderWorkout(el);
    else if (tab === 'smoke') await renderSmoke(el);
    else if (tab === 'stats') await renderStats(el);
  } catch(e) {
    el.innerHTML = `<div class="empty-state"><i class="ti ti-alert-circle"></i>Ошибка загрузки</div>`;
    console.error(e);
  }
}

/* ─── TODAY TAB ─────────────────────────────────────────────────── */
async function renderToday(el) {
  const dayNum = todayDayNum();
  const [habits, logs, settings, workouts] = await Promise.all([
    api('GET', '/api/habits'),
    api('GET', `/api/habits/logs?date=${todayStr()}`),
    api('GET', '/api/settings'),
    api('GET', '/api/workouts'),
  ]);

  const todayHabits = habits.filter(h => h.days.length === 0 || h.days.includes(dayNum));
  const logMap = {};
  logs.forEach(l => { logMap[l.habit_id] = l.status; });
  const doneCount = todayHabits.filter(h => logMap[h.id] === 'done').length;

  const todayWorkoutDay = workouts.find(w => w.day_num === dayNum);
  const isRest = REST_DAYS.includes(dayNum);

  let sessions = [];
  if (!isRest) {
    sessions = await api('GET', `/api/workouts/sessions?date=${todayStr()}&dayNum=${dayNum}`);
  }

  el.innerHTML = `
    ${renderPushBanner()}
    <div class="card">
      <div class="card-header">
        <span class="card-title">Привычки</span>
        <span style="font-size:13px;color:var(--text-3)">${doneCount} из ${todayHabits.length}</span>
        <button class="icon-btn" id="btn-edit-habits"><i class="ti ti-pencil"></i></button>
      </div>
      <div class="progress-bar"><div class="progress-fill" id="habit-progress" style="width:${todayHabits.length ? Math.round(doneCount/todayHabits.length*100) : 0}%"></div></div>
      <div class="habit-list" id="habit-list">
        ${renderHabitItems(todayHabits, logMap, editHabitsMode)}
      </div>
      <div id="habit-edit-panel" style="display:${editHabitsMode?'block':'none'}">
        <div class="add-btn-row">
          <button class="btn btn-secondary btn-sm" id="btn-add-habit"><i class="ti ti-plus"></i> Добавить привычку</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">Режим сна</span>
        <button class="icon-btn" id="btn-edit-sleep"><i class="ti ti-pencil"></i></button>
      </div>
      <div class="sleep-grid">
        <div class="sleep-cell"><span class="sleep-label">Отбой</span><span class="sleep-value">${settings.sleep_time||'23:00'}</span></div>
        <div class="sleep-cell"><span class="sleep-label">Подъём</span><span class="sleep-value">${settings.wake_time||'07:00'}</span></div>
        <div class="sleep-cell"><span class="sleep-label">Сон</span><span class="sleep-value">${sleepDuration(settings.sleep_time||'23:00', settings.wake_time||'07:00')}</span></div>
      </div>
      <div class="sleep-countdown">До отбоя: <strong id="sleep-cd">${countdown(settings.sleep_time||'23:00')}</strong></div>
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">${isRest ? 'Сегодня отдых' : `Тренировка — ${todayWorkoutDay?.name||''}`}</span>
      </div>
      ${isRest
        ? `<div class="rest-day"><p>Можно кардио:</p><div class="rest-options">
            ${(todayWorkoutDay?.exercises||[]).map(e=>`<div class="rest-option"><i class="ti ti-circle-dot" style="font-size:10px;margin-right:4px;color:var(--accent)"></i>${e.name}</div>`).join('')}
          </div></div>`
        : renderTodayWorkoutBlock(todayWorkoutDay?.exercises||[], sessions)
      }
    </div>
  `;

  startSleepCountdown(settings.sleep_time||'23:00');
  bindTodayEvents(habits, todayHabits, logMap, settings);
}

function renderPushBanner() {
  if (Notification.permission === 'granted' || Notification.permission === 'denied') return '';
  return `
    <div class="push-permission-banner" id="push-banner">
      <i class="ti ti-bell"></i>
      <div class="push-permission-text">
        <strong>Включить уведомления?</strong>
        Напомним про тренировку, сон и режим дня.
      </div>
      <button class="btn btn-primary btn-sm" id="btn-push-allow">Включить</button>
    </div>`;
}

function renderHabitItems(habits, logMap, editMode) {
  if (!habits.length) return '<div class="empty-state" style="padding:20px"><i class="ti ti-check"></i>Привычек нет</div>';
  return habits.map(h => {
    const status = logMap[h.id] || '';
    const checkClass = status === 'done' ? 'done' : status === 'skip' ? 'skip' : '';
    const checkIcon = status === 'done' ? '✓' : status === 'skip' ? '—' : '';
    const streakText = h.streak > 0 ? `🔥 ${h.streak}` : `0`;
    const streakClass = h.streak > 0 ? '' : 'zero';
    if (editMode) {
      const daysArr = h.days || [];
      return `
        <div class="habit-edit-row" data-id="${h.id}">
          <div style="flex:1">
            <div class="habit-edit-name">${h.name}</div>
            <div class="days-row">
              ${DAY_NAMES.map((d,i) => `<button class="day-chip ${daysArr.length===0&&i===0?'':''}${daysArr.includes(i)?'active':''}" data-habit="${h.id}" data-day="${i}">${d}</button>`).join('')}
            </div>
          </div>
          <button class="icon-btn" style="color:var(--red)" data-delete-habit="${h.id}"><i class="ti ti-trash"></i></button>
        </div>`;
    }
    return `
      <div class="habit-item">
        <button class="habit-check ${checkClass}" data-habit-id="${h.id}" data-status="${status}">${checkIcon}</button>
        <span class="habit-name">${h.name}</span>
        <span class="habit-streak ${streakClass}">${streakText}</span>
      </div>`;
  }).join('');
}

function renderTodayWorkoutBlock(exercises, sessions) {
  if (!exercises.length) return '<div class="card-body"><p style="color:var(--text-3);font-size:14px">Упражнений нет</p></div>';
  const sessionMap = {};
  sessions.forEach(s => { sessionMap[`${s.exercise_id}_${s.set_num}`] = s; });
  return `
    <div class="today-exercise-list">
      ${exercises.map(ex => {
        const doneSets = sessions.filter(s => s.exercise_id === ex.id).length;
        return `
          <div class="today-exercise">
            <span class="today-exercise-name">${ex.name}</span>
            <span class="today-exercise-meta">${ex.sets}×${ex.reps}</span>
            ${doneSets > 0 ? `<span class="badge badge-green">${doneSets}/${ex.sets}</span>` : ''}
          </div>`;
      }).join('')}
    </div>
    <div class="add-btn-row">
      <button class="btn btn-primary btn-full" id="btn-start-workout">
        <i class="ti ti-player-play"></i> Начать тренировку
      </button>
    </div>`;
}

function bindTodayEvents(allHabits, todayHabits, logMap, settings) {
  // Push banner
  document.getElementById('btn-push-allow')?.addEventListener('click', requestPushPermission);

  // Habit toggle
  document.querySelectorAll('[data-habit-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.habitId;
      const cur = btn.dataset.status;
      const next = cur === '' ? 'done' : cur === 'done' ? 'skip' : null;
      await api('POST', `/api/habits/${id}/log`, { date: todayStr(), status: next });
      navigate('today');
    });
  });

  // Edit habits toggle
  document.getElementById('btn-edit-habits')?.addEventListener('click', () => {
    editHabitsMode = !editHabitsMode;
    navigate('today');
  });

  // Add habit
  document.getElementById('btn-add-habit')?.addEventListener('click', () => openHabitForm());

  // Delete habit
  document.querySelectorAll('[data-delete-habit]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Удалить привычку?')) return;
      await api('DELETE', `/api/habits/${btn.dataset.deleteHabit}`);
      navigate('today');
    });
  });

  // Day chip toggle in edit mode
  document.querySelectorAll('.day-chip[data-habit]').forEach(chip => {
    chip.addEventListener('click', async () => {
      const habitId = chip.dataset.habit;
      const dayNum = parseInt(chip.dataset.day);
      const habit = allHabits.find(h => h.id == habitId);
      if (!habit) return;
      let days = [...(habit.days || [])];
      if (days.includes(dayNum)) days = days.filter(d => d !== dayNum);
      else days.push(dayNum);
      days.sort((a,b) => a-b);
      await api('PATCH', `/api/habits/${habitId}`, { days });
      navigate('today');
    });
  });

  // Edit sleep
  document.getElementById('btn-edit-sleep')?.addEventListener('click', () => openSleepForm(settings));

  // Start workout
  document.getElementById('btn-start-workout')?.addEventListener('click', async () => {
    const dayNum = todayDayNum();
    const workouts = await api('GET', '/api/workouts');
    const wd = workouts.find(w => w.day_num === dayNum);
    if (wd?.exercises?.length) startWorkoutSession(wd.exercises, dayNum);
  });
}

function startSleepCountdown(sleepTime) {
  const el = document.getElementById('sleep-cd');
  if (!el) return;
  clearInterval(sleepCountdownInterval);
  sleepCountdownInterval = setInterval(() => {
    if (el) el.textContent = countdown(sleepTime);
  }, 30000);
}

/* ─── HABIT FORM ────────────────────────────────────────────────── */
function openHabitForm() {
  document.getElementById('habit-form-content').innerHTML = `
    <div class="form-group">
      <label class="form-label">Название</label>
      <input class="form-input" id="new-habit-name" placeholder="Название привычки" autofocus>
    </div>
    <div class="form-group">
      <label class="form-label">Дни (пусто = каждый день)</label>
      <div class="days-row" id="new-habit-days">
        ${DAY_NAMES.map((d,i) => `<button class="day-chip" data-newday="${i}">${d}</button>`).join('')}
      </div>
    </div>
    <button class="btn btn-primary btn-full" id="btn-save-habit">Добавить</button>
  `;
  showOverlay('overlay-habit-form');

  document.querySelectorAll('[data-newday]').forEach(chip => {
    chip.addEventListener('click', () => chip.classList.toggle('active'));
  });

  document.getElementById('btn-save-habit').addEventListener('click', async () => {
    const name = document.getElementById('new-habit-name').value.trim();
    if (!name) return;
    const days = [...document.querySelectorAll('[data-newday].active')].map(c => parseInt(c.dataset.newday));
    await api('POST', '/api/habits', { name, days });
    hideOverlay('overlay-habit-form');
    navigate('today');
  });
}

/* ─── SLEEP FORM ────────────────────────────────────────────────── */
function openSleepForm(settings) {
  document.getElementById('sleep-form-content').innerHTML = `
    <div class="form-group">
      <label class="form-label">Отбой</label>
      <input class="form-input" type="time" id="sleep-time-input" value="${settings.sleep_time||'23:00'}">
    </div>
    <div class="form-group">
      <label class="form-label">Подъём</label>
      <input class="form-input" type="time" id="wake-time-input" value="${settings.wake_time||'07:00'}">
    </div>
    <button class="btn btn-primary btn-full" id="btn-save-sleep">Сохранить</button>
  `;
  showOverlay('overlay-sleep-form');

  document.getElementById('btn-save-sleep').addEventListener('click', async () => {
    const sleep_time = document.getElementById('sleep-time-input').value;
    const wake_time = document.getElementById('wake-time-input').value;
    await api('PUT', '/api/settings', { sleep_time, wake_time });
    hideOverlay('overlay-sleep-form');
    navigate('today');
  });
}

/* ─── ACTIVE WORKOUT SESSION ─────────────────────────────────────── */
function startWorkoutSession(exercises, dayNum) {
  activeWorkout = {
    exercises, dayNum,
    exIdx: 0, setIdx: 0,
    timer: null, timerInterval: null,
    date: todayStr(),
  };
  showOverlay('overlay-workout');
  renderWorkoutSession();
}

function renderWorkoutSession() {
  if (!activeWorkout) return;
  const { exercises, exIdx, setIdx } = activeWorkout;
  const ex = exercises[exIdx];
  const totalSets = ex.sets;
  const totalEx = exercises.length;
  const isResting = activeWorkout.timer !== null;

  const content = document.getElementById('workout-session-content');
  content.innerHTML = `
    <div class="workout-session">
      <div style="font-size:12px;color:var(--text-3);margin-bottom:4px">Упражнение ${exIdx+1} из ${totalEx}</div>
      <div class="ws-exercise">${ex.name}</div>
      <div class="ws-progress">Подход ${setIdx+1} из ${totalSets} • Цель: ${ex.reps}</div>
      ${isResting ? `
        <div class="ws-timer-label">Отдых</div>
        <div class="ws-timer" id="ws-timer">${activeWorkout.timer}</div>
        <button class="btn btn-secondary btn-sm" id="btn-skip-rest" style="margin-bottom:16px">Пропустить</button>
      ` : `
        <div class="ws-inputs">
          <div class="ws-input-group">
            <div class="ws-input-label">Повторений</div>
            <input class="ws-input" type="number" id="ws-reps" placeholder="${ex.reps}" inputmode="numeric">
          </div>
          <div class="ws-input-group">
            <div class="ws-input-label">Вес (кг)</div>
            <input class="ws-input" type="number" id="ws-weight" placeholder="0" inputmode="decimal" step="0.5">
          </div>
        </div>
        <button class="btn btn-primary btn-full" id="btn-set-done">
          <i class="ti ti-check"></i> Подход выполнен
        </button>
      `}
      <div style="margin-top:16px;width:100%;background:var(--border);border-radius:3px;height:4px">
        <div style="width:${Math.round((exIdx*totalSets+setIdx)/(totalEx*totalSets)*100)}%;background:var(--accent);height:4px;border-radius:3px;transition:width .3s"></div>
      </div>
    </div>
  `;

  document.getElementById('btn-set-done')?.addEventListener('click', async () => {
    const reps = parseInt(document.getElementById('ws-reps').value) || null;
    const weight = parseFloat(document.getElementById('ws-weight').value) || null;
    await api('POST', '/api/workouts/sessions', {
      date: activeWorkout.date,
      day_num: activeWorkout.dayNum,
      exercise_id: ex.id,
      set_num: activeWorkout.setIdx + 1,
      reps_done: reps,
      weight,
    });
    advanceSet();
  });

  document.getElementById('btn-skip-rest')?.addEventListener('click', skipRest);
}

function advanceSet() {
  const { exercises, exIdx, setIdx } = activeWorkout;
  const ex = exercises[exIdx];
  const nextSet = setIdx + 1;

  if (nextSet < ex.sets) {
    activeWorkout.setIdx = nextSet;
    startRestTimer();
  } else {
    const nextEx = exIdx + 1;
    if (nextEx < exercises.length) {
      activeWorkout.exIdx = nextEx;
      activeWorkout.setIdx = 0;
      startRestTimer();
    } else {
      // Workout complete
      clearInterval(activeWorkout.timerInterval);
      document.getElementById('workout-session-content').innerHTML = `
        <div class="workout-session">
          <div style="font-size:48px;margin-bottom:12px">🎉</div>
          <div class="ws-exercise">Тренировка завершена!</div>
          <div class="ws-progress" style="margin-bottom:24px">Отличная работа</div>
          <button class="btn btn-primary btn-full" id="btn-finish-workout">Готово</button>
        </div>`;
      document.getElementById('btn-finish-workout').addEventListener('click', () => {
        hideOverlay('overlay-workout');
        activeWorkout = null;
        navigate('today');
      });
    }
  }
}

function startRestTimer() {
  activeWorkout.timer = 90;
  renderWorkoutSession();

  activeWorkout.timerInterval = setInterval(() => {
    activeWorkout.timer--;
    const el = document.getElementById('ws-timer');
    if (el) el.textContent = activeWorkout.timer;
    if (activeWorkout.timer <= 0) skipRest();
  }, 1000);
}

function skipRest() {
  clearInterval(activeWorkout.timerInterval);
  activeWorkout.timer = null;
  renderWorkoutSession();
}

/* ─── SCHEDULE TAB ───────────────────────────────────────────────── */
async function renderSchedule(el) {
  const blocks = await api('GET', '/api/schedule');
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <span class="section-title" style="padding:0">Расписание дня</span>
      <button class="btn btn-primary btn-sm" id="btn-add-block"><i class="ti ti-plus"></i> Добавить</button>
    </div>
    <div class="schedule-list">
      ${blocks.map(b => `
        <div class="type-${b.type}">
          <div class="schedule-item" data-block-id="${b.id}">
            <span class="schedule-time">${b.time}</span>
            <span class="schedule-dot"></span>
            <span class="schedule-name">${b.name}</span>
            <button class="icon-btn" data-delete-block="${b.id}" style="color:var(--text-3)"><i class="ti ti-trash"></i></button>
          </div>
        </div>`).join('')}
    </div>`;

  document.getElementById('btn-add-block').addEventListener('click', () => openBlockForm(null, null));

  document.querySelectorAll('[data-block-id]').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete-block]')) return;
      const id = item.dataset.blockId;
      const block = blocks.find(b => b.id == id);
      if (block) openBlockForm(id, block);
    });
  });

  document.querySelectorAll('[data-delete-block]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Удалить блок?')) return;
      await api('DELETE', `/api/schedule/${btn.dataset.deleteBlock}`);
      navigate('schedule');
    });
  });
}

function openBlockForm(id, block) {
  document.getElementById('block-form-title').textContent = id ? 'Редактировать' : 'Новый блок';
  document.getElementById('block-form-content').innerHTML = `
    <div class="form-group">
      <label class="form-label">Время</label>
      <input class="form-input" type="time" id="block-time" value="${block?.time||'09:00'}">
    </div>
    <div class="form-group">
      <label class="form-label">Название</label>
      <input class="form-input" id="block-name" placeholder="Название блока" value="${block?.name||''}">
    </div>
    <div class="form-group">
      <label class="form-label">Тип</label>
      <select class="form-select" id="block-type">
        ${Object.entries(TYPE_LABELS).map(([v,l]) => `<option value="${v}" ${block?.type===v?'selected':''}>${l}</option>`).join('')}
      </select>
    </div>
    <button class="btn btn-primary btn-full" id="btn-save-block">${id ? 'Сохранить' : 'Добавить'}</button>
  `;
  showOverlay('overlay-block-form');

  document.getElementById('btn-save-block').addEventListener('click', async () => {
    const time = document.getElementById('block-time').value;
    const name = document.getElementById('block-name').value.trim();
    const type = document.getElementById('block-type').value;
    if (!name) return;
    if (id) await api('PUT', `/api/schedule/${id}`, { time, name, type });
    else await api('POST', '/api/schedule', { time, name, type });
    hideOverlay('overlay-block-form');
    navigate('schedule');
  });
}

/* ─── WORKOUT TAB ────────────────────────────────────────────────── */
async function renderWorkout(el) {
  const workouts = await api('GET', '/api/workouts');

  el.innerHTML = `
    <div class="day-tabs" id="day-tabs">
      ${workouts.map(w => {
        const isRest = REST_DAYS.includes(w.day_num);
        return `<button class="day-tab ${w.day_num===activeWorkoutDay?'active':''} ${isRest?'rest':''}" data-day="${w.day_num}">
          ${DAY_NAMES[w.day_num]}
        </button>`;
      }).join('')}
    </div>
    <div id="workout-day-content"></div>
  `;

  document.querySelectorAll('.day-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      activeWorkoutDay = parseInt(btn.dataset.day);
      document.querySelectorAll('.day-tab').forEach(b => b.classList.toggle('active', b.dataset.day == activeWorkoutDay));
      renderWorkoutDayContent(workouts.find(w => w.day_num === activeWorkoutDay), workouts);
    });
  });

  renderWorkoutDayContent(workouts.find(w => w.day_num === activeWorkoutDay), workouts);
}

async function renderWorkoutDayContent(wd, allWorkouts) {
  const el = document.getElementById('workout-day-content');
  if (!wd) return;

  let history = {};
  if (wd.exercises.length) {
    const sessions = await api('GET', `/api/workouts/sessions?dayNum=${wd.day_num}`);
    wd.exercises.forEach(ex => {
      const exSessions = sessions.filter(s => s.exercise_id === ex.id && s.date !== todayStr());
      if (exSessions.length) {
        const lastDate = exSessions[0].date;
        const lastSets = exSessions.filter(s => s.date === lastDate);
        const repsText = lastSets.map(s => s.reps_done !== null ? `${s.reps_done}×${s.weight||0}кг` : '—').join(', ');
        history[ex.id] = `${lastDate}: ${repsText}`;
      }
    });
  }

  el.innerHTML = `
    <div class="card">
      <div class="card-header">
        <span class="card-title" id="wd-name">${wd.name}</span>
        <button class="icon-btn" id="btn-edit-dayname"><i class="ti ti-pencil"></i></button>
      </div>
      <div id="exercise-list">
        ${wd.exercises.length ? wd.exercises.map(ex => `
          <div class="exercise-item">
            <div class="exercise-info">
              <div class="exercise-name">${ex.name}</div>
              <div class="exercise-meta">${ex.sets} подхода × ${ex.reps}</div>
              ${history[ex.id] ? `<div class="exercise-history"><i class="ti ti-history" style="font-size:11px"></i> ${history[ex.id]}</div>` : ''}
            </div>
            <button class="icon-btn" style="color:var(--text-3)" data-delete-ex="${ex.id}"><i class="ti ti-trash"></i></button>
          </div>`).join('')
        : '<div class="empty-state" style="padding:20px"><i class="ti ti-barbell"></i>Нет упражнений</div>'}
      </div>
      <div class="add-btn-row">
        <button class="btn btn-secondary btn-sm" id="btn-add-ex"><i class="ti ti-plus"></i> Упражнение</button>
      </div>
    </div>`;

  document.getElementById('btn-edit-dayname').addEventListener('click', () => {
    const cur = wd.name;
    const inp = prompt('Название дня:', cur);
    if (inp && inp !== cur) {
      api('PATCH', `/api/workouts/${wd.day_num}`, { name: inp }).then(() => renderWorkout(document.getElementById('tab-content')));
    }
  });

  document.querySelectorAll('[data-delete-ex]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Удалить упражнение?')) return;
      await api('DELETE', `/api/workouts/exercises/${btn.dataset.deleteEx}`);
      const wds = await api('GET', '/api/workouts');
      renderWorkoutDayContent(wds.find(w => w.day_num === wd.day_num), wds);
    });
  });

  document.getElementById('btn-add-ex').addEventListener('click', () => openAddExerciseForm(wd.day_num));
}

function openAddExerciseForm(dayNum) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="overlay-sheet overlay-sheet--sm">
      <div class="overlay-header">
        <span class="overlay-title">Новое упражнение</span>
        <button class="icon-btn" id="btn-ex-close"><i class="ti ti-x"></i></button>
      </div>
      <div class="overlay-body">
        <div class="form-group">
          <label class="form-label">Название</label>
          <input class="form-input" id="ex-name" placeholder="Название упражнения" autofocus>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div class="form-group">
            <label class="form-label">Подходы</label>
            <input class="form-input" type="number" id="ex-sets" value="3" inputmode="numeric">
          </div>
          <div class="form-group">
            <label class="form-label">Повторения</label>
            <input class="form-input" id="ex-reps" value="10">
          </div>
        </div>
        <button class="btn btn-primary btn-full" id="btn-save-ex">Добавить</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('#btn-ex-close').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#btn-save-ex').addEventListener('click', async () => {
    const name = overlay.querySelector('#ex-name').value.trim();
    if (!name) return;
    const sets = parseInt(overlay.querySelector('#ex-sets').value) || 3;
    const reps = overlay.querySelector('#ex-reps').value || '10';
    await api('POST', `/api/workouts/${dayNum}/exercises`, { name, sets, reps });
    overlay.remove();
    const wds = await api('GET', '/api/workouts');
    renderWorkoutDayContent(wds.find(w => w.day_num === dayNum), wds);
  });
}

/* ─── SMOKE TAB ──────────────────────────────────────────────────── */
let selectedTrigger = '';

async function renderSmoke(el) {
  const data = await api('GET', `/api/smoke?date=${todayStr()}`);
  const maxTrigger = data.triggers.length ? data.triggers[0].cnt : 1;

  el.innerHTML = `
    <div class="smoke-stats">
      <div class="smoke-stat-card">
        <div class="smoke-stat-value">${data.todayCount}</div>
        <div class="smoke-stat-label">Сегодня</div>
      </div>
      <div class="smoke-stat-card">
        <div class="smoke-stat-value">${data.avgDay}</div>
        <div class="smoke-stat-label">Ср. за 7 дней</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><span class="card-title">Записать затяжку</span></div>
      <div class="card-body">
        <div class="trigger-select" id="trigger-select">
          ${TRIGGERS.map(t => `<button class="trigger-chip ${selectedTrigger===t?'selected':''}" data-trigger="${t}">${t}</button>`).join('')}
          <button class="trigger-chip ${selectedTrigger&&!TRIGGERS.includes(selectedTrigger)?'selected':''}" data-trigger="__custom">Другое</button>
        </div>
        <div id="custom-trigger-wrap" style="display:${selectedTrigger&&!TRIGGERS.includes(selectedTrigger)?'block':'none'};margin-top:10px">
          <input class="form-input" id="custom-trigger" placeholder="Свой триггер" value="${!TRIGGERS.includes(selectedTrigger)?selectedTrigger:''}">
        </div>
        <button class="btn btn-primary btn-full" id="btn-log-smoke" style="margin-top:12px">
          <i class="ti ti-plus"></i> Записать
        </button>
      </div>
    </div>

    ${data.triggers.length ? `
    <div class="card">
      <div class="card-header"><span class="card-title">Топ триггеров (7 дней)</span></div>
      <div class="card-body">
        <div class="trigger-list">
          ${data.triggers.map(t => `
            <div class="trigger-bar-row">
              <span class="trigger-name">${t.trigger}</span>
              <div class="trigger-bar-wrap"><div class="trigger-bar-fill" style="width:${Math.round(t.cnt/maxTrigger*100)}%"></div></div>
              <span class="trigger-count">${t.cnt}</span>
            </div>`).join('')}
        </div>
      </div>
    </div>` : ''}

    ${data.logs.length ? `
    <div class="card">
      <div class="card-header"><span class="card-title">Сегодня</span></div>
      <div class="card-body">
        <div class="smoke-log-list">
          ${data.logs.map(l => `
            <div class="smoke-log-item">
              <span class="smoke-log-time">${fmtTime(l.datetime)}</span>
              <span class="smoke-log-trigger">${l.trigger||'—'}</span>
              <button class="icon-btn" style="color:var(--text-3)" data-delete-smoke="${l.id}"><i class="ti ti-trash"></i></button>
            </div>`).join('')}
        </div>
      </div>
    </div>` : ''}
  `;

  // Trigger chips
  document.querySelectorAll('.trigger-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const t = chip.dataset.trigger;
      if (t === '__custom') {
        selectedTrigger = document.getElementById('custom-trigger')?.value || '__custom';
        document.getElementById('custom-trigger-wrap').style.display = 'block';
        document.querySelectorAll('.trigger-chip').forEach(c => c.classList.remove('selected'));
        chip.classList.add('selected');
      } else {
        selectedTrigger = selectedTrigger === t ? '' : t;
        document.getElementById('custom-trigger-wrap').style.display = 'none';
        renderSmoke(el);
      }
    });
  });

  document.getElementById('custom-trigger')?.addEventListener('input', e => {
    selectedTrigger = e.target.value;
  });

  document.getElementById('btn-log-smoke').addEventListener('click', async () => {
    const trigger = selectedTrigger && selectedTrigger !== '__custom' ? selectedTrigger : null;
    await api('POST', '/api/smoke', { trigger });
    selectedTrigger = '';
    navigate('smoke');
  });

  document.querySelectorAll('[data-delete-smoke]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api('DELETE', `/api/smoke/${btn.dataset.deleteSmoke}`);
      navigate('smoke');
    });
  });
}

/* ─── STATS TAB ──────────────────────────────────────────────────── */
async function renderStats(el) {
  const stats = await api('GET', '/api/stats');

  el.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${stats.streak}</div>
        <div class="stat-label">Дней подряд</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.weekWorkouts}</div>
        <div class="stat-label">Тренировок за неделю</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.habitPercent7}%</div>
        <div class="stat-label">Привычек за 7 дней</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.smokeWeek}</div>
        <div class="stat-label">Сигарет за неделю</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><span class="card-title">Последние 30 дней</span></div>
      <div style="padding:10px 14px 6px;display:grid;grid-template-columns:repeat(7,1fr);gap:3px;text-align:center">
        ${DAY_NAMES.map(d => `<div style="font-size:10px;color:var(--text-3);padding-bottom:4px">${d}</div>`).join('')}
      </div>
      <div class="calendar-grid">
        ${renderCalendarGrid(stats.calendarDays)}
      </div>
      <div class="calendar-legend">
        <span><span class="legend-dot" style="background:var(--accent)"></span>Хорошо</span>
        <span><span class="legend-dot" style="background:var(--yellow)"></span>Частично</span>
        <span><span class="legend-dot" style="background:var(--border)"></span>Пусто</span>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><span class="card-title">Программа</span></div>
      <div class="card-body" style="display:flex;gap:16px">
        <div>
          <div style="font-size:12px;color:var(--text-3)">Старт</div>
          <div style="font-weight:600">${stats.startDate}</div>
        </div>
        <div>
          <div style="font-size:12px;color:var(--text-3)">День</div>
          <div style="font-weight:600;font-size:20px;color:var(--accent)">#${stats.dayCount}</div>
        </div>
      </div>
    </div>
  `;
}

function renderCalendarGrid(days) {
  // Pad start to align with correct weekday
  const first = new Date(days[0].date);
  const pad = first.getDay();
  let html = '<div></div>'.repeat(pad);
  html += days.map(d => `<div class="cal-day ${d.status}" title="${d.date}"></div>`).join('');
  return html;
}

/* ─── SETTINGS OVERLAY ───────────────────────────────────────────── */
async function openSettings() {
  const [pushSettings, settings] = await Promise.all([
    api('GET', '/api/push/settings'),
    api('GET', '/api/settings'),
  ]);

  document.getElementById('settings-content').innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Уведомления</div>
      ${Notification.permission !== 'granted'
        ? `<div style="font-size:13px;color:var(--text-3);margin-bottom:10px">Разрешение на уведомления не выдано</div>
           <button class="btn btn-primary btn-sm" id="btn-settings-push">Разрешить уведомления</button>`
        : `<div style="font-size:13px;color:var(--accent);margin-bottom:12px"><i class="ti ti-check"></i> Уведомления активны</div>`
      }
      <div style="margin-top:12px">
        ${pushSettings.map(p => `
          <div class="push-row">
            <span class="push-name">${p.name}</span>
            <input type="time" style="border:none;background:none;font-size:13px;color:var(--text-3);width:60px" value="${p.time}" data-push-time="${p.id}">
            <label class="toggle">
              <input type="checkbox" ${p.enabled?'checked':''} data-push-toggle="${p.id}">
              <div class="toggle-track"></div>
            </label>
          </div>`).join('')}
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Программа</div>
      <div class="form-group">
        <label class="form-label">Дата старта</label>
        <input class="form-input" type="date" id="start-date-input" value="${settings.start_date||''}">
      </div>
      <button class="btn btn-secondary btn-sm" id="btn-save-start-date">Сохранить</button>
    </div>
  `;
  showOverlay('overlay-settings');

  document.getElementById('btn-settings-push')?.addEventListener('click', requestPushPermission);

  document.getElementById('btn-save-start-date')?.addEventListener('click', async () => {
    const v = document.getElementById('start-date-input').value;
    if (v) { await api('PUT', '/api/settings', { start_date: v }); alert('Сохранено'); }
  });

  document.querySelectorAll('[data-push-toggle]').forEach(el => {
    el.addEventListener('change', async () => {
      await api('PUT', `/api/push/settings/${el.dataset.pushToggle}`, { enabled: el.checked });
    });
  });

  document.querySelectorAll('[data-push-time]').forEach(el => {
    el.addEventListener('change', async () => {
      await api('PUT', `/api/push/settings/${el.dataset.pushTime}`, { time: el.value });
    });
  });
}

/* ─── PUSH NOTIFICATIONS ─────────────────────────────────────────── */
async function requestPushPermission() {
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    await subscribeToPush();
    navigate(activeTab);
  }
}

async function subscribeToPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const { publicKey } = await api('GET', '/api/push/vapidkey');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
    const { endpoint, keys } = sub.toJSON();
    await api('POST', '/api/push/subscribe', { endpoint, keys });
  } catch (e) {
    console.error('Push subscribe error:', e);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return new Uint8Array([...rawData].map(c => c.charCodeAt(0)));
}

/* ─── OVERLAY HELPERS ────────────────────────────────────────────── */
function showOverlay(id) {
  document.getElementById(id).classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function hideOverlay(id) {
  document.getElementById(id).classList.add('hidden');
  document.body.style.overflow = '';
}

// Close overlays on backdrop click
document.querySelectorAll('.overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) {
      overlay.classList.add('hidden');
      document.body.style.overflow = '';
    }
  });
});

// Close buttons
document.getElementById('btn-settings-close').addEventListener('click', () => hideOverlay('overlay-settings'));
document.getElementById('btn-workout-close').addEventListener('click', () => {
  if (activeWorkout && !confirm('Прервать тренировку?')) return;
  clearInterval(activeWorkout?.timerInterval);
  activeWorkout = null;
  hideOverlay('overlay-workout');
});
document.getElementById('btn-habit-form-close').addEventListener('click', () => hideOverlay('overlay-habit-form'));
document.getElementById('btn-block-form-close').addEventListener('click', () => hideOverlay('overlay-block-form'));
document.getElementById('btn-sleep-form-close').addEventListener('click', () => hideOverlay('overlay-sleep-form'));

/* ─── INIT ───────────────────────────────────────────────────────── */
async function init() {
  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(console.error);
  }

  // Tab navigation
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.tab));
  });

  // Settings button
  document.getElementById('btn-settings').addEventListener('click', openSettings);

  // Auto-subscribe if already permitted
  if (Notification.permission === 'granted') {
    subscribeToPush();
  }

  navigate('today');
}

init();
