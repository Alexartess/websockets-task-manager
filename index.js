import express from 'express';
import http from 'http';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import sqlite3 from 'sqlite3';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import bcrypt from 'bcrypt';

// Константы 
const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', credentials: true } });

const JWT_SECRET = process.env.JWT_SECRET || 'dltvluHBdhajyETI47-IByyrt7';
const JWT_EXPIRES_IN = '7d';
const SALT_ROUNDS = 12;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_FILE_SIZE }
});

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR);
}

//Настройка бд
const db = new sqlite3.Database('tasks.db');
db.run(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  password_hash TEXT
)`);
db.run(`CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT,
  description TEXT,
  status TEXT,
  due_date TEXT,
  created_at TEXT,
  user_id INTEGER
)`);
db.run(`CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  filename TEXT,
  original_name TEXT,
  mime TEXT
)`);

//функции для работы с БД
function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

//Middleware аутентификации
app.use(cookieParser());
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

function authMiddleware(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

//регистрация
app.post('/auth/register', async (req, res) => {
  const { username, password } = req.body;
  try {
    if (!username || !password) {
      return res.status(400).json({ error: 'username_password_required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'password_too_short' });
    }

    const existing = await getAsync('SELECT id FROM users WHERE username = ?', [username]);
    if (existing) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    await runAsync('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, hash]);

    const user = await getAsync('SELECT id, username FROM users WHERE username = ?', [username]);
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({ user });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

//вход
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    if (!username || !password) {
      return res.status(400).json({ error: 'username_password_required' });
    }

    const user = await getAsync('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({ user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

//проверка текущего состояния аутентификации пользователя
app.get('/auth/me', authMiddleware, (req, res) => {
  res.json({ user: { id: req.user.id, username: req.user.username } });
});

//выход
app.post('/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

//Socket.IO 
//проверка аутентификации
io.use((socket, next) => {
  const token =
    socket.handshake.auth?.token ||
    socket.handshake.headers?.cookie?.match(/token=([^;]+)/)?.[1];

  if (!token) return next(new Error('auth_required'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('invalid_token'));
  }
});

//работа с задачами
io.on('connection', (socket) => {
  const userId = socket.user.id;
  console.log(`Socket connected: ${socket.user.username}`);
  socket.join(userId.toString());

  //получение задач
  socket.on('tasks:get', async (status, callback) => {
    try {
      let rows;
      if (status) {
        rows = await allAsync(
          'SELECT * FROM tasks WHERE status = ? AND user_id = ? ORDER BY due_date IS NULL, due_date ASC',
          [status, userId]
        );
      } else {
        rows = await allAsync(
          'SELECT * FROM tasks WHERE user_id = ? ORDER BY due_date IS NULL, due_date ASC',
          [userId]
        );
      }
      for (const t of rows) {
        const files = await allAsync('SELECT id, filename, original_name, mime FROM files WHERE task_id = ?', [t.id]);
        t.files = files.map(f => ({
          id: f.id,
          url: '/uploads/' + f.filename,
          name: f.original_name,
          mime: f.mime
        }));
      }
      callback({ success: true, data: rows });
    } catch (err) {
      console.error(err);
      callback({ success: false, error: 'internal_error' });
    }
  });

  // создание задачи
  socket.on('tasks:create', async (data, callback) => {
    try {
      const { title, description = '', status = 'pending', due_date = null } = data;
      if (!title) return callback({ success: false, error: 'title_required' });

      const now = new Date().toISOString();
      const result = await runAsync(
        'INSERT INTO tasks (title, description, status, due_date, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)',
        [title, description, status, due_date, now, userId]
      );
      const task = await getAsync('SELECT * FROM tasks WHERE id = ?', [result.lastID]);
      task.files = [];

      io.to(userId.toString()).emit('tasks:created', task);
      callback({ success: true, data: task });
    } catch (err) {
      console.error(err);
      callback({ success: false, error: 'internal_error' });
    }
  });

  // удаление задачи
  socket.on('tasks:delete', async (id, callback) => {
    try {
      await runAsync('DELETE FROM tasks WHERE id = ? AND user_id = ?', [id, userId]);
      io.to(userId.toString()).emit('tasks:deleted', id);
      callback({ success: true });
    } catch (err) {
      console.error(err);
      callback({ success: false, error: 'internal_error' });
    }
  });

  //обновление существующей задачи
  socket.on('tasks:update', async (task, callback) => {
    try {
      const { id, title, description, status, due_date } = task;
      await runAsync(
        'UPDATE tasks SET title = ?, description = ?, status = ?, due_date = ? WHERE id = ? AND user_id = ?',
        [title, description, status, due_date, id, userId]
      );
      const updated = await getAsync('SELECT * FROM tasks WHERE id = ?', [id]);
      const files = await allAsync('SELECT id, filename, original_name, mime FROM files WHERE task_id = ?', [id]);
      updated.files = files.map(f => ({
        id: f.id,
        url: '/uploads/' + f.filename,
        name: f.original_name,
        mime: f.mime
      }));

      io.to(userId.toString()).emit('tasks:updated', updated);
      callback({ success: true, data: updated });
    } catch (err) {
      console.error(err);
      callback({ success: false, error: 'internal_error' });
    }
  });
});

// работа с файлами
app.post('/tasks/:id/files', authMiddleware, upload.array('files'), async (req, res) => {
  const taskId = req.params.id;
  for (const file of req.files) {
    await runAsync(
      'INSERT INTO files (task_id, filename, original_name, mime) VALUES (?, ?, ?, ?)',
      [taskId, file.filename, file.originalname, file.mimetype]
    );
  }
  res.json({ success: true });
});

app.delete('/files/:id', authMiddleware, async (req, res) => {
  const fileId = req.params.id;
  const file = await getAsync('SELECT * FROM files WHERE id = ?', [fileId]);
  if (file) {
    fs.unlinkSync(path.join(UPLOAD_DIR, file.filename));
    await runAsync('DELETE FROM files WHERE id = ?', [fileId]);
  }
  res.json({ success: true });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
});
