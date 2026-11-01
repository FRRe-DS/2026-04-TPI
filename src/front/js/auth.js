
(() => {
  const pageRoles = {
    '/ventana-de-solicitud.html': 'cliente',
    '/solicitudes.html': 'encargado',
    '/ventana-administrador.html': 'administrador'
  };

  const path = location.pathname === '/'
    ? '/ventana-de-solicitud.html'
    : location.pathname;

  const requiredRole = pageRoles[path];
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input, options = {}) => {
    const url = typeof input === 'string' ? input : input.url;

    if (!url.includes('/api/')) {
      return nativeFetch(input, options);
    }

    await window.authReady;
    await window.keycloak.updateToken(30);

    const headers = new Headers(
      options.headers || (input instanceof Request ? input.headers : undefined)
    );

    headers.set('Authorization', `Bearer ${window.keycloak.token}`);

    return nativeFetch(input, { ...options, headers });
  };

  window.authReady = (async () => {
    // Obtener configuración del servidor
    const configResponse = await nativeFetch('/auth-config.json');

    if (!configResponse.ok) {
      throw new Error('No se pudo obtener la configuración de autenticación.');
    }

    const config = await configResponse.json();

    if (!config.url || !config.realm || !config.clientId) {
      throw new Error('Falta configurar KEYCLOAK_URL, KEYCLOAK_REALM o KEYCLOAK_CLIENT_ID.');
    }

    // Importar el adaptador instalado mediante npm
    const { default: Keycloak } = await import(
      '/node_modules/keycloak-js/lib/keycloak.js'
    );

    // Crear instancia de Keycloak
    const keycloak = new Keycloak({
      url: config.url,
      realm: config.realm,
      clientId: config.clientId
    });

    window.keycloak = keycloak;

    // Iniciar autenticación
    await keycloak.init({
      onLoad: 'login-required',
      pkceMethod: 'S256',
      checkLoginIframe: false
    });

    // Comprobar roles del usuario
    const roles = keycloak.realmAccess?.roles || [];

    const role = ['administrador', 'encargado', 'cliente']
      .find(candidate => roles.includes(candidate));

    if (!role) {
      document.body.innerHTML = `
        <main style="font:16px sans-serif;padding:3rem">
          <h1>Sin permiso asignado</h1>
          <p>Pedile al administrador que te asigne un rol.</p>
          <button id="logout">Cerrar sesión</button>
        </main>
      `;

      document.getElementById('logout').onclick = () => keycloak.logout();
      return;
    }

    // Comprobar que el usuario acceda a su ventana correspondiente
    if (requiredRole && role !== requiredRole) {
      const home = {
        cliente: '/ventana-de-solicitud.html',
        encargado: '/solicitudes.html',
        administrador: '/ventana-administrador.html'
      }[role];

      location.replace(home);
      return;
    }

    // Mostrar solamente los enlaces correspondientes al rol
    document.querySelectorAll('[data-role-link]').forEach(link => {
      if (link.dataset.roleLink !== role) {
        link.remove();
      }
    });

    // Configurar cierre de sesión
    document.querySelectorAll('[data-logout]').forEach(button => {
      button.addEventListener('click', () => keycloak.logout());
    });

    window.authRole = role;

  })().catch(error => {
    console.error('Error de autenticación:', error);

    document.body.innerHTML = `
      <main style="font:16px sans-serif;padding:3rem">
        <h1>Error de autenticación</h1>
        <p>${String(error.message || error)}</p>
        <p>Verificá la configuración de Keycloak y recargá.</p>
      </main>
    `;

    throw error;
  });
})();
