
(() => {
  const pageRoles = {
    '/ventana-de-solicitud.html': 'clientes-be',
    '/solicitudes.html': 'solicitud-be'
  };

  const adminPage = '/ventana-administrador.html';

  const path = location.pathname === '/'
    ? '/ventana-de-solicitud.html'
    : location.pathname;

  const requiredRole = pageRoles[path];
  const nativeFetch = window.fetch.bind(window);

  // Agregar el token a las llamadas de la API.
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
    const configResponse = await nativeFetch('/auth-config.json');

    if (!configResponse.ok) {
      throw new Error('No se pudo obtener la configuración de autenticación.');
    }

    const config = await configResponse.json();

    if (!config.url || !config.realm || !config.clientId) {
      throw new Error('Falta configurar KEYCLOAK_URL, KEYCLOAK_REALM o KEYCLOAK_CLIENT_ID.');
    }

    const { default: Keycloak } = await import(
      '/node_modules/keycloak-js/lib/keycloak.js'
    );

    const keycloak = new Keycloak({
      url: config.url,
      realm: config.realm,
      clientId: config.clientId
    });

    window.keycloak = keycloak;

    await keycloak.init({
      onLoad: 'login-required',
      pkceMethod: 'S256',
      checkLoginIframe: false
    });

    // Roles centrales de M5.
    const roles = keycloak.realmAccess?.roles || [];

    const role = ['solicitud-be', 'clientes-be']
      .find(candidate => roles.includes(candidate));

    if (!role) {
      document.body.innerHTML = `
        <main style="font:16px sans-serif;padding:3rem">
          <h1>Sin permiso asignado</h1>
          <p>Tu usuario no tiene asignado un rol habilitado para el módulo 5.</p>
          <button id="logout">Cerrar sesión</button>
        </main>
      `;

      document.getElementById('logout').onclick = () => keycloak.logout();
      return;
    }

    // El administrador queda deshabilitado hasta que exista
    // un rol administrativo confirmado para M5.
    if (path === adminPage) {
      document.body.innerHTML = `
        <main style="font:16px sans-serif;padding:3rem">
          <h1>Ventana no habilitada</h1>
          <p>El módulo 5 no tiene configurado actualmente un rol administrador.</p>
          <button id="logout">Cerrar sesión</button>
        </main>
      `;

      document.getElementById('logout').onclick = () => keycloak.logout();
      return;
    }

    // Comprobar que el usuario acceda a su ventana.
    if (requiredRole && role !== requiredRole) {
      const home = {
        'clientes-be': '/ventana-de-solicitud.html',
        'solicitud-be': '/solicitudes.html'
      }[role];

      if (home && path !== home) {
        location.replace(home);
        return;
      }
    }

    // Mostrar solamente los enlaces del rol correspondiente.
    document.querySelectorAll('[data-role-link]').forEach(link => {
      if (link.dataset.roleLink !== role) {
        link.remove();
      }
    });

    // Configurar cierre de sesión.
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
        <p>Verificá la configuración del Keycloak central y recargá.</p>
      </main>
    `;

    throw error;
  });
})();
