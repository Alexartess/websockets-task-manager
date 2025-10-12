const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

const statusLabels = {
  pending: 'В ожидании',
  in_progress: 'В процессе',
  done: 'Завершено'
};

function escapeHtml(s) { 
  if (!s) return ''; 
  return s.replaceAll('&','&amp;')
          .replaceAll('<','&lt;')
          .replaceAll('>','&gt;')
          .replaceAll('"','&quot;'); 
} 

//менеджер задач
const TaskManager = {
  tasksElement: null,
  createForm: null,
  filterElement: null,
  initialized: false, // Флаг инициализации

  init() {
     if (this.initialized) {
      console.log('TaskManager already initialized');
      return;
    }
    this.tasksElement = document.getElementById('tasks');
    this.createForm = document.getElementById('createForm');
    this.filterElement = document.getElementById('filter');

    this.bindEvents();
    this.fetchTasks();
    this.initialized = true;
    
    console.log('TaskManager initialized');
  },

  bindEvents() {
    // Удаляем все существующие обработчики перед добавлением
    this.createForm.removeEventListener('submit', this.boundHandleCreateTask);
    this.filterElement.removeEventListener('change', this.boundFetchTasks);
    
    // Привязываем методы к контексту
    this.boundHandleCreateTask = this.handleCreateTask.bind(this);
    this.boundFetchTasks = this.fetchTasks.bind(this);
    
    // Добавляем обработчики
    this.createForm.addEventListener('submit', this.boundHandleCreateTask);
    this.filterElement.addEventListener('change', this.boundFetchTasks);
    
    console.log('Event handlers bound');
  },

  async fetchTasks() {
    const status = this.filterElement.value;
    let url = '/tasks';
    if (status) url += '?status=' + encodeURIComponent(status);
    
    try {
      this.showLoading();
      const res = await authFetch(url);
      if (!res.ok) { 
        this.showError('Ошибка загрузки задач'); 
        return; 
      }
      const tasks = await res.json();
      this.renderTasks(tasks);
    } catch (err) {
      if (err.message !== 'Authentication required') {
        this.showError('Ошибка загрузки задач');
      }
    }
  },

  renderTasks(tasks) {
    this.tasksElement.innerHTML = '';
    
    if (tasks.length === 0) {
      this.tasksElement.innerHTML = '<p class="loading">Нет задач</p>';
      return;
    }

    for (const task of tasks) {
      const taskElement = this.createTaskElement(task);
      this.tasksElement.appendChild(taskElement);
    }
  },

  createTaskElement(task) {
    const div = document.createElement('div');
    div.className = `task ${task.status}`;
    div.innerHTML = `
      <h3>${escapeHtml(task.title)}</h3>
      <p>${escapeHtml(task.description || '')}</p>
      <p><strong>Статус:</strong> ${statusLabels[task.status] || task.status}</p>
      <p><strong>Срок:</strong> ${task.due_date || '-'}</p>
      ${task.files && task.files.length ? 
        '<p><strong>Файлы:</strong> ' + 
        task.files.map(f => `<a href="${f.url}" target="_blank">${escapeHtml(f.name)}</a>`).join(', ') + 
        '</p>' : ''}
      <div class="actions">
        <button class="delete" data-task-id="${task.id}">Удалить</button>
        <button class="edit" data-task-id="${task.id}">Изменить</button>
      </div>
    `;

    //добавляем обработчики событий
    div.querySelector('.delete').addEventListener('click', () => this.deleteTask(task.id));
    div.querySelector('.edit').addEventListener('click', () => this.showEditForm(task.id));

    return div;
  },

  async deleteTask(id) {
    if (!confirm('Удалить задачу?')) return;
    try {
      const res = await authFetch('/tasks/' + id, { method: 'DELETE' });
      if (!res.ok) {
        this.showError('Ошибка при удалении задачи');
        return;
      }
      this.fetchTasks();
    } catch (err) {
      //ошибка 401 уже обработана в authFetch
    }
  },

  async showEditForm(id) {
    try {
      const taskRes = await authFetch('/tasks/' + id);
      if (!taskRes.ok) { 
        this.showError('Не удалось загрузить задачу'); 
        return; 
      }
      const task = await taskRes.json();
      this.renderEditForm(task);
    } catch (err) {
      //ошибка 401 уже обработана в authFetch
    }
  },

  renderEditForm(task) {
    const filesHtml = (task.files && task.files.length)
      ? `<ul class="file-list">` + task.files.map(f =>
          `<li>${escapeHtml(f.name)} <button type="button" data-file-id="${f.id}" data-task-id="${task.id}">Удалить</button></li>`
        ).join('') + `</ul>`
      : '<p>Файлов нет</p>';

    const div = document.createElement('div');
    div.className = `task edit-form ${task.status}`;
    div.innerHTML = `
      <h3>Редактировать задачу</h3>
      <input type="text" id="edit-title-${task.id}" value="${escapeHtml(task.title)}" />
      <textarea id="edit-desc-${task.id}">${escapeHtml(task.description || '')}</textarea>
      <select id="edit-status-${task.id}">
        <option value="pending" ${task.status === 'pending' ? 'selected' : ''}>В ожидании</option>
        <option value="in_progress" ${task.status === 'in_progress' ? 'selected' : ''}>В процессе</option>
        <option value="done" ${task.status === 'done' ? 'selected' : ''}>Завершено</option>
      </select>
      <input type="date" id="edit-due-${task.id}" value="${task.due_date || ''}" />
      <h4>Файлы</h4>
      ${filesHtml}
      <input type="file" id="edit-files-${task.id}" multiple />
      <div class="actions">
        <button class="edit" data-save-task="${task.id}" type="button">Сохранить</button>
        <button class="delete" data-cancel-edit type="button">Отмена</button>
      </div>
    `;

    // обработчики событий
    div.querySelector(`[data-save-task="${task.id}"]`).addEventListener('click', () => this.saveTask(task.id));
    div.querySelector('[data-cancel-edit]').addEventListener('click', () => this.fetchTasks());
    
    // обработчики для удаления файлов
    div.querySelectorAll('[data-file-id]').forEach(button => {
      button.addEventListener('click', (e) => {
        const fileId = e.target.getAttribute('data-file-id');
        const taskId = e.target.getAttribute('data-task-id');
        this.deleteFile(taskId, fileId);
      });
    });

    // Заменяем существующую задачу формой редактирования
    const existingTask = [...this.tasksElement.children].find(child => 
      child.querySelector(`[data-task-id="${task.id}"]`)
    );
    
    if (existingTask) {
      this.tasksElement.replaceChild(div, existingTask);
    } else {
      this.tasksElement.prepend(div);
    }
  },

  async deleteFile(taskId, fileId) {
    if (!confirm('Удалить файл?')) return;
    try {
      const res = await authFetch(`/files/${fileId}`, { method: 'DELETE' });
      if (!res.ok) {
        this.showError('Ошибка при удалении файла');
        return;
      }
      this.showEditForm(taskId);
    } catch (err) {
      //ошибка 401 уже обработана в authFetch
    }
  },

  async saveTask(id) {
    const newTitle = document.getElementById(`edit-title-${id}`).value.trim();
    const newDescription = document.getElementById(`edit-desc-${id}`).value;
    const newStatus = document.getElementById(`edit-status-${id}`).value;
    const newDue = document.getElementById(`edit-due-${id}`).value;
    const newFilesInput = document.getElementById(`edit-files-${id}`);

    const formData = new FormData();
    formData.append('title', newTitle);
    formData.append('description', newDescription);
    formData.append('status', newStatus);
    formData.append('due_date', newDue || '');

    if (newFilesInput && newFilesInput.files.length) {
      for (const file of newFilesInput.files) {
        if (file.size > MAX_FILE_SIZE) {
          this.showError(`Файл "${file.name}" превышает 5 MB и не будет загружен`);
          return;
        }
        formData.append('files', file);
      }
    }

    try {
      const res = await authFetch(`/tasks/${id}`, { 
        method: 'PUT', 
        body: formData 
      });
      
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (err.error === 'file_too_large') {
          this.showError('Один из файлов слишком большой (максимум 5 MB)');
        } else {
          this.showError('Ошибка при сохранении задачи');
        }
        return;
      }

      this.fetchTasks();
    } catch (err) {
      //ошибка 401 уже обработана в authFetch
    }
  },

async handleCreateTask(ev) {
  ev.preventDefault();
  console.log('=== FORM SUBMIT STARTED ===', new Date().toISOString());
  const fd = new FormData(this.createForm);
  
  console.log('Creating task with data:');
  for (let [key, value] of fd.entries()) {
    if (key === 'files') {
      console.log(`File: ${value.name}, size: ${value.size}`);
    } else {
      console.log(`${key}: ${value}`);
    }
  }
  
  // Проверка размера файлов
  for (const file of fd.getAll('files')) {
    if (file.size > MAX_FILE_SIZE) {
      this.showError(`Файл "${file.name}" превышает 5 MB`);
      return;
    }
  }
  
  try {
    const res = await authFetch('/tasks', { 
      method: 'POST', 
      body: fd 
    });
    
    console.log('Response status:', res.status);
    
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('Error response:', err);
      if (err.error === 'file_too_large') {
        this.showError('Файл слишком большой (максимум 5 MB)');
      } else {
        this.showError('Ошибка при создании задачи: ' + (err.message || err.error || 'Неизвестная ошибка'));
      }
      return;
    }
    
    const result = await res.json();
    console.log('Task created:', result);
    
    this.createForm.reset();
    this.fetchTasks();
  } catch (err) {
    console.error('Create task error:', err);
    if (err.message !== 'Authentication required') {
      this.showError('Ошибка при создании задачи');
    }
  }
},

  showLoading() {
    this.tasksElement.innerHTML = '<p class="loading">Загрузка...</p>';
  },

  showError(message) {
    alert(message);
  }
};