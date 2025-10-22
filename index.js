const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');

const JWT_SECRET = process.env.JWT_SECRET || 'dltvluHBdhajyETI47-IByyrt7';
const JWT_EXPIRES_IN = '7d';
const SALT_ROUNDS = 12;

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
  limits: { fileSize: 5 * 1024 * 1024 }
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));


const DB_PATH = path.join(__dirname, 'db.sqlite');
const db = new sqlite3.Database(DB_PATH);

//инициализация базы данных
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    due_date TEXT,
    created_at TEXT NOT NULL,
    user_id INTEGER NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    original_name TEXT,
    mime TEXT,
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
  )`);

  //users 
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
});

//функции для работы с БД
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

// Middleware аутентификации
const authenticateToken = (req, res, next) => {
  const token = req.cookies?.token;
  
  if (!token) {
    return res.status(401).json({ error: 'access_denied', message: 'Требуется аутентификация' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'invalid_token', message: 'Невалидный токен' });
    }
    req.user = user;
    next();
  });
};

// регистрация
app.post('/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ 
        error: 'username_password_required',
        message: 'Имя пользователя и пароль обязательны' 
      });
    }

    if (password.length < 6) {
      return res.status(400).json({ 
        error: 'password_too_short',
        message: 'Пароль должен быть не менее 6 символов' 
      });
    }

    const existingUser = await getAsync('SELECT id FROM users WHERE username = ?', [username]);
    if (existingUser) {
      return res.status(400).json({ 
        error: 'user_exists',
        message: 'Пользователь с таким именем уже существует' 
      });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const now = new Date().toISOString();

    const result = await runAsync(
      'INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)',
      [username, passwordHash, now]
    );

    const token = jwt.sign(
      { id: result.lastID, username }, 
      JWT_SECRET, 
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.status(201).json({ 
      message: 'user_created', 
      user: { id: result.lastID, username } 
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ 
      error: 'internal_error',
      message: 'Внутренняя ошибка сервера' 
    });
  }
});


//вход
app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ 
        error: 'username_password_required',
        message: 'Имя пользователя и пароль обязательны' 
      });
    }

    const user = await getAsync('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) {
      return res.status(401).json({ 
        error: 'invalid_credentials',
        message: 'Неверное имя пользователя или пароль' 
      });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ 
        error: 'invalid_credentials',
        message: 'Неверное имя пользователя или пароль' 
      });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username }, 
      JWT_SECRET, 
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({ 
      message: 'login_success', 
      user: { id: user.id, username: user.username } 
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ 
      error: 'internal_error',
      message: 'Внутренняя ошибка сервера' 
    });
  }
});

//выход
app.post('/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'logout_success' });
});

//проверка текущего состояния аутентификации пользователя
app.get('/auth/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});


//REST API

//маршруты для работы с задачами требуют аутентификации

// GET /tasks?status=...
app.get('/tasks', authenticateToken, async (req, res) => {
  try {
    const status = req.query.status;
    let rows;
    //выбираем задачи конкретного пользователя
    if (status) {
      rows = await allAsync(
        
        'SELECT * FROM tasks WHERE status = ? AND user_id = ? ORDER BY due_date IS NULL, due_date ASC', 
        [status, req.user.id]
      );
    } else {
      rows = await allAsync(
        'SELECT * FROM tasks WHERE user_id = ? ORDER BY due_date IS NULL, due_date ASC',
        [req.user.id]
      );
    }
    
    for (const t of rows) {
      const files = await allAsync('SELECT id, filename, original_name, mime FROM files WHERE task_id = ?', [t.id]);
      t.files = files.map(f => ({ id: f.id, url: '/uploads/' + f.filename, name: f.original_name, mime: f.mime }));
    }
    res.status(200).json(rows);
  } catch (err) {
    console.error('Get tasks error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /tasks/:id
app.get('/tasks/:id', authenticateToken, async (req, res) => {
  try {
    const row = await getAsync(
      'SELECT * FROM tasks WHERE id = ? AND user_id = ?', 
      [req.params.id, req.user.id]
    );
    if (!row) return res.status(404).json({ error: 'not_found' });
    
    const files = await allAsync('SELECT id, filename, original_name, mime FROM files WHERE task_id = ?', [row.id]);
    row.files = files.map(f => ({ id: f.id, url: '/uploads/' + f.filename, name: f.original_name, mime: f.mime }));
    res.status(200).json(row);
  } catch (err) {
    console.error('Get task error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// POST /tasks 
app.post('/tasks', authenticateToken, upload.array('files'), async (req, res) => {
  try {
    console.log('Creating task for user:', req.user.id);
    console.log('Files:', req.files);
    console.log('Body:', req.body);

    const title = (req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'title_required' });
    
    const description = req.body.description || '';
    const status = req.body.status || 'pending';
    const due_date = req.body.due_date || null;

    const now = new Date().toISOString();
    const result = await runAsync(
      'INSERT INTO tasks (title, description, status, due_date, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)', 
      [title, description, status, due_date, now, req.user.id]
    );
    
    const taskId = result.lastID;

    if (req.files && req.files.length) {
      console.log('Saving files:', req.files.length);
      const stmtPromises = req.files.map(f => 
        runAsync(
          'INSERT INTO files (task_id, filename, original_name, mime) VALUES (?, ?, ?, ?)', 
          [taskId, f.filename, f.originalname, f.mimetype]
        )
      );
      await Promise.all(stmtPromises);
    }

    const created = await getAsync('SELECT * FROM tasks WHERE id = ?', [taskId]);
    const files = await allAsync('SELECT id, filename, original_name, mime FROM files WHERE task_id = ?', [taskId]);
    created.files = files.map(f => ({ id: f.id, url: '/uploads/' + f.filename, name: f.original_name, mime: f.mime }));

    res.status(201).json(created);
  } catch (err) {
    console.error('Create task error:', err);
    res.status(500).json({ error: 'internal_error', details: err.message });
  }
});

// PUT /tasks/:id
app.put('/tasks/:id', authenticateToken, upload.array('files'), async (req, res) => {
  try {
    const id = req.params.id;
    const exists = await getAsync(
      'SELECT * FROM tasks WHERE id = ? AND user_id = ?', 
      [id, req.user.id]
    );
    if (!exists) return res.status(404).json({ error: 'not_found' });

    const fields = [];
    const params = [];
    if (req.body.title !== undefined) { fields.push('title = ?'); params.push(req.body.title); }
    if (req.body.description !== undefined) { fields.push('description = ?'); params.push(req.body.description); }
    if (req.body.status !== undefined) { fields.push('status = ?'); params.push(req.body.status); }
    if (req.body.due_date !== undefined) { fields.push('due_date = ?'); params.push(req.body.due_date || null); }

    if (fields.length) {
      params.push(id, req.user.id);
      await runAsync(
        `UPDATE tasks SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`, 
        params
      );
    }

    if (req.files && req.files.length) {
      const stmtPromises = req.files.map(f => 
        runAsync(
          'INSERT INTO files (task_id, filename, original_name, mime) VALUES (?, ?, ?, ?)', 
          [id, f.filename, f.originalname, f.mimetype]
        )
      );
      await Promise.all(stmtPromises);
    }

    const updated = await getAsync('SELECT * FROM tasks WHERE id = ?', [id]);
    const files = await allAsync('SELECT id, filename, original_name, mime FROM files WHERE task_id = ?', [id]);
    updated.files = files.map(f => ({ id: f.id, url: '/uploads/' + f.filename, name: f.original_name, mime: f.mime }));

    res.status(200).json(updated);
  } catch (err) {
    console.error('Update task error:', err);
    res.status(500).json({ error: 'internal_error', details: err.message });
  }
});

// DELETE /tasks/:id
app.delete('/tasks/:id', authenticateToken, async (req, res) => {
  try {
    const id = req.params.id;
    const exists = await getAsync(
      'SELECT * FROM tasks WHERE id = ? AND user_id = ?', 
      [id, req.user.id]
    );
    if (!exists) return res.status(404).json({ error: 'not_found' });

    const files = await allAsync('SELECT filename FROM files WHERE task_id = ?', [id]);
    for (const f of files) {
      const p = path.join(UPLOAD_DIR, f.filename);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }

    await runAsync('DELETE FROM files WHERE task_id = ?', [id]);
    await runAsync('DELETE FROM tasks WHERE id = ? AND user_id = ?', [id, req.user.id]);

    res.status(204).send();
  } catch (err) {
    console.error('Delete task error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// DELETE /files/:id
app.delete('/files/:id', authenticateToken, async (req, res) => {
  try {
    const f = await getAsync(`
      SELECT f.* FROM files f 
      JOIN tasks t ON f.task_id = t.id 
      WHERE f.id = ? AND t.user_id = ?
    `, [req.params.id, req.user.id]);
    
    if (!f) return res.status(404).json({ error: 'not_found' });
    
    const p = path.join(UPLOAD_DIR, f.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    await runAsync('DELETE FROM files WHERE id = ?', [req.params.id]);
    res.status(204).send();
  } catch (err) {
    console.error('Delete file error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Ограничение размера файла
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