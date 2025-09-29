const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random()*1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 } // максимум 5 MB
});


const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

//DB 
const DB_PATH = path.join(__dirname, 'db.sqlite');
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    due_date TEXT,
    created_at TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT,
    mime TEXT,
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
  )`);
});


function runAsync(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
function allAsync(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}
function getAsync(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

//REST API 

// GET /tasks?status=...
app.get('/tasks', async (req, res) => {
  try {
    const status = req.query.status;
    let rows;
    if (status) {
      rows = await allAsync('SELECT * FROM tasks WHERE status = ? ORDER BY due_date IS NULL, due_date ASC', [status]);
    } else {
      rows = await allAsync('SELECT * FROM tasks ORDER BY due_date IS NULL, due_date ASC');
    }
    for (const t of rows) {
      const files = await allAsync('SELECT id, filename, original_name, mime FROM files WHERE task_id = ?', [t.id]);
      t.files = files.map(f => ({ id: f.id, url: '/uploads/' + f.filename, name: f.original_name, mime: f.mime }));
    }
    res.status(200).json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /tasks/:id
app.get('/tasks/:id', async (req, res) => {
  try {
    const row = await getAsync('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'not_found' });
    const files = await allAsync('SELECT id, filename, original_name, mime FROM files WHERE task_id = ?', [row.id]);
    row.files = files.map(f => ({ id: f.id, url: '/uploads/' + f.filename, name: f.original_name, mime: f.mime }));
    res.status(200).json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// POST /tasks
app.post('/tasks', upload.array('files'), async (req, res) => {
  try {
    const isForm = req.is('multipart/form-data') || req.files;
    let payload = isForm ? req.body : req.body;

    const title = (payload.title || '').trim();
    if (!title) return res.status(400).json({ error: 'title_required' });
    const description = payload.description || '';
    const status = payload.status || 'pending';
    const due_date = payload.due_date || null;

    const now = new Date().toISOString();
    const result = await runAsync('INSERT INTO tasks (title, description, status, due_date, created_at) VALUES (?, ?, ?, ?, ?)', [title, description, status, due_date, now]);
    const taskId = result.lastID;

    if (req.files && req.files.length) {
      const stmtPromises = req.files.map(f => runAsync('INSERT INTO files (task_id, filename, original_name, mime) VALUES (?, ?, ?, ?)', [taskId, f.filename, f.originalname, f.mimetype]));
      await Promise.all(stmtPromises);
    }

    const created = await getAsync('SELECT * FROM tasks WHERE id = ?', [taskId]);
    const files = await allAsync('SELECT id, filename, original_name, mime FROM files WHERE task_id = ?', [taskId]);
    created.files = files.map(f => ({ id: f.id, url: '/uploads/' + f.filename, name: f.original_name, mime: f.mime }));

    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// PUT /tasks/:id
app.put('/tasks/:id', upload.array('files'), async (req, res) => {
  try {
    const id = req.params.id;
    const exists = await getAsync('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!exists) return res.status(404).json({ error: 'not_found' });

    const isForm = req.is('multipart/form-data') || req.files;
    const payload = isForm ? req.body : req.body;

    const fields = [];
    const params = [];
    if (payload.title !== undefined) { fields.push('title = ?'); params.push(payload.title); }
    if (payload.description !== undefined) { fields.push('description = ?'); params.push(payload.description); }
    if (payload.status !== undefined) { fields.push('status = ?'); params.push(payload.status); }
    if (payload.due_date !== undefined) { fields.push('due_date = ?'); params.push(payload.due_date || null); }

    if (fields.length) {
      params.push(id);
      await runAsync(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`, params);
    }

    if (req.files && req.files.length) {
      const stmtPromises = req.files.map(f => runAsync('INSERT INTO files (task_id, filename, original_name, mime) VALUES (?, ?, ?, ?)', [id, f.filename, f.originalname, f.mimetype]));
      await Promise.all(stmtPromises);
    }

    const updated = await getAsync('SELECT * FROM tasks WHERE id = ?', [id]);
    const files = await allAsync('SELECT id, filename, original_name, mime FROM files WHERE task_id = ?', [id]);
    updated.files = files.map(f => ({ id: f.id, url: '/uploads/' + f.filename, name: f.original_name, mime: f.mime }));

    res.status(200).json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /tasks/:id
app.delete('/tasks/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const exists = await getAsync('SELECT * FROM tasks WHERE id = ?', [id]);
    if (!exists) return res.status(404).json({ error: 'not_found' });

    const files = await allAsync('SELECT filename FROM files WHERE task_id = ?', [id]);
    for (const f of files) {
      const p = path.join(UPLOAD_DIR, f.filename);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    await runAsync('DELETE FROM files WHERE task_id = ?', [id]);
    await runAsync('DELETE FROM tasks WHERE id = ?', [id]);

    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /files/:id
app.delete('/files/:id', async (req, res) => {
  try {
    const f = await getAsync('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!f) return res.status(404).json({ error: 'not_found' });
    const p = path.join(UPLOAD_DIR, f.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    await runAsync('DELETE FROM files WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Удаление файла по id
app.delete('/files/:id', (req, res) => {
  const id = req.params.id;
  db.get('SELECT * FROM files WHERE id = ?', [id], (err, file) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!file) return res.status(404).json({ error: 'File not found' });

    // удалить запись из базы
    db.run('DELETE FROM files WHERE id = ?', [id], err2 => {
      if (err2) return res.status(500).json({ error: err2.message });

      // удалить сам файл из папки uploads
      const fs = require('fs');
      const path = require('path');
      const filePath = path.join(__dirname, 'uploads', file.path);

      fs.unlink(filePath, err3 => {
        // даже если unlink дал ошибку (например, файл уже удалён) — отвечаем 200
        if (err3) console.warn('Ошибка при удалении файла:', err3.message);
        res.json({ success: true });
      });
    });
  });
});


// Error handler for Multer and other middleware
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'file_too_large', message: 'Максимальный размер файла 5 MB' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});


app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
