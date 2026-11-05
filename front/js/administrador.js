window.authReady.then(async () => {
  const message = document.getElementById('message');
  const tbody = document.getElementById('users');
  const roles = ['cliente', 'encargado', 'administrador'];
  const esc = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function load() {
    message.className = ''; message.textContent = 'Cargando usuarios…';
    try {
      const response = await fetch('/api/admin/users');
      const users = await response.json();
      if (!response.ok) throw new Error(users.error || 'No se pudieron cargar los usuarios.');
      tbody.innerHTML = users.map(user => `<tr><td>${esc(user.username)}</td><td>${esc(`${user.firstName} ${user.lastName}`.trim())}</td><td>${esc(user.email)}</td><td>${user.enabled ? 'Activo' : 'Deshabilitado'}</td><td><select data-user="${esc(user.id)}"><option value="">Sin permiso</option>${roles.map(role => `<option value="${role}" ${user.role === role ? 'selected' : ''}>${role}</option>`).join('')}</select></td></tr>`).join('');
      message.textContent = `${users.length} usuario(s) encontrado(s).`;
      tbody.querySelectorAll('select').forEach(select => select.addEventListener('change', async () => {
        if (!select.value) return;
        select.disabled = true;
        try {
          const update = await fetch(`/api/admin/users/${encodeURIComponent(select.dataset.user)}/role`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({role:select.value}) });
          const data = await update.json(); if (!update.ok) throw new Error(data.error || 'No se pudo actualizar el permiso.');
          message.className = 'success'; message.textContent = `Permiso actualizado a “${data.role}”.`;
        } catch (error) { message.className = 'error'; message.textContent = error.message; await load(); }
        finally { select.disabled = false; }
      }));
    } catch (error) { message.className = 'error'; message.textContent = error.message; }
  }
  await load();
});
