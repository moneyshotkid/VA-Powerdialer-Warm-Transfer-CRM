import { post } from './api.js';

const form = document.getElementById('login-form');
const errorEl = document.getElementById('login-error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  try {
    const user = await post('/api/auth/login', { username, password });
    window.location.href = user.role === 'admin' ? '/admin.html' : '/agent.html';
  } catch (err) {
    errorEl.textContent = err.message || 'Login failed';
    errorEl.hidden = false;
  }
});
