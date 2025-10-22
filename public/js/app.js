document.addEventListener('DOMContentLoaded', function() {
  AuthManager.init();
});

//Socket.IO
function initSocket() {
  if (window.socket) return;

  window.socket = io({
    auth: { token: getCookie('token') }
  });

  window.socket.on('tasks:created', () => TaskManager.fetchTasks());
  window.socket.on('tasks:updated', () => TaskManager.fetchTasks());
  window.socket.on('tasks:deleted', () => TaskManager.fetchTasks());
}

// читаем cookie
function getCookie(name) {
  const value = `; ${document.cookie}`;
  const parts = value.split(`; ${name}=`);
  if (parts.length === 2) return parts.pop().split(';').shift();
}
