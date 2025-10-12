//обработка 401 для fetch
async function authFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    credentials: 'include'
  });
  
  if (res.status === 401) {
    AuthManager.setCurrentUser(null);
    AuthManager.showAuth();
    throw new Error('Authentication required');
  }
  
  return res;
}

//менеджер аутентификации
const AuthManager = {
  currentUser: null,

  init() {
    this.bindEvents();
    this.checkAuth();
  },

  bindEvents() {
    document.getElementById('loginForm').addEventListener('submit', this.handleLogin.bind(this));
    document.getElementById('registerForm').addEventListener('submit', this.handleRegister.bind(this));
    document.getElementById('logoutButton').addEventListener('click', this.handleLogout.bind(this));
    document.getElementById('showRegisterLink').addEventListener('click', this.showRegister.bind(this));
    document.getElementById('showLoginLink').addEventListener('click', this.showLogin.bind(this));
  },

  async checkAuth() {  //проверяем состояние аутентификации
    try {
      const res = await fetch('/auth/me');
      if (res.ok) {
        const data = await res.json();
        this.setCurrentUser(data.user);
        this.showApp();
      } else {
        this.showAuth();
      }
    } catch (err) {
      console.error('Auth check failed:', err);
      this.showAuth();
    }
  },

  showAuth() {
    document.getElementById('authSection').classList.remove('hidden');
    document.getElementById('appSection').classList.add('hidden');
  },

  showApp() {
    document.getElementById('authSection').classList.add('hidden');
    document.getElementById('appSection').classList.remove('hidden');
    document.getElementById('username').textContent = this.currentUser.username;
    
    // инициализируем менеджер задач после успешной аутентификации
    if (typeof TaskManager !== 'undefined') {
      TaskManager.init();
    }
  },

  showRegister() {
    document.getElementById('loginForm').parentElement.classList.add('hidden');
    document.getElementById('registerSection').classList.remove('hidden');
  },

  showLogin() {
    document.getElementById('registerSection').classList.add('hidden');
    document.getElementById('loginForm').parentElement.classList.remove('hidden');
  },

  async handleLogin(ev) {
    ev.preventDefault();
    const formData = new FormData(ev.target);
    const data = {
      username: formData.get('username'),
      password: formData.get('password')
    };

    try {
      const res = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      if (res.ok) {
        const result = await res.json();
        this.setCurrentUser(result.user);
        this.showApp();
      } else {
        const error = await res.json();
        this.showError('Ошибка входа: ' + (error.message || 'Неверные данные'));
      }
    } catch (err) {
      this.showError('Ошибка сети');
    }
  },

    async handleRegister(ev) {
    ev.preventDefault();
    const formData = new FormData(ev.target);
    const data = {
        username: formData.get('username'),
        password: formData.get('password')
    };

    try {
        const res = await fetch('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
        });

        const result = await res.json();
        
        if (res.ok) {
        this.setCurrentUser(result.user);
        this.showApp();
        } else {
        this.showError(result.message || result.error || 'Неизвестная ошибка');
        }
    } catch (err) {
        console.error('Registration error:', err);
        this.showError('Ошибка сети при регистрации');
    }
  },

  async handleLogout() {
    try {
      await fetch('/auth/logout', { method: 'POST' });
      this.setCurrentUser(null);
      this.showAuth();
    } catch (err) {
      console.error('Logout error:', err);
    }
  },

  setCurrentUser(user) {
    this.currentUser = user;
  },

  getCurrentUser() {
    return this.currentUser;
  },

  showError(message) {
    alert(message);
  }
};