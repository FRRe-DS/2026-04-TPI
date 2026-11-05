(() => {
  const $ = (id) => document.getElementById(id);
  const tbody = $("requests-body");
  const notice = $("notice");
  const searchInput = $("search-input");
  const statusFilter = $("status-filter");
  const refreshButton = $("refresh-button");
  let requests = [];

  async function loadOperatorProfile() {
    try {
      await window.authReady;
      const profile = await window.keycloak.loadUserProfile();
      const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(" ").trim();
      const name = fullName ||
        profile.username ||
        window.keycloak.tokenParsed?.preferred_username ||
        "Encargado";

      $("client-name").textContent = name;
      $("client-avatar").textContent = name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(part => part[0].toLocaleUpperCase("es-AR"))
        .join("") || "EN";
    } catch (error) {
      console.error("Error al cargar el perfil del encargado:", error);
      $("client-name").textContent = "Encargado";
      $("client-avatar").textContent = "EN";
    }
  }

  function showNotice(message, type = "info") {
    notice.className = `notice visible ${type}`;
    notice.textContent = message;
  }
  function hideNotice() {
    notice.className = "notice";
    notice.textContent = "";
  }
  function formatDate(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("es-AR", {
      dateStyle: "short", timeStyle: "short"
    }).format(date);
  }
  function formatPoint(point) {
    if (!point) return "Sin coordenadas";
    const lat = Number(point.lat);
    const lng = Number(point.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "Coordenadas no disponibles";
    return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  }
  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[char]);
  }
  function statusClass(status) {
    return String(status || "pendiente").toLowerCase().replace(/\s+/g, "_");
  }
  function render() {
    const term = searchInput.value.trim().toLowerCase();
    const filter = statusFilter.value;
    const filtered = requests.filter(item => {
      const status = String(item.estado || "").toLowerCase();
      const matchesStatus = filter === "todos" ||
        (filter === "pendiente" && status.includes("pendiente")) ||
        (filter === "otros" && !status.includes("pendiente"));
      const haystack = [
        item.solicitudId, item.clienteId, item.tipoVehiculo, item.estado,
        item.tipoActivacion, formatPoint(item.origen), formatPoint(item.destino)
      ].join(" ").toLowerCase();
      return matchesStatus && haystack.includes(term);
    });

    $("total-count").textContent = requests.length;
    $("pending-count").textContent = requests.filter(item => String(item.estado).toLowerCase().includes("pendiente")).length;
    $("result-caption").textContent = `${filtered.length} resultado${filtered.length === 1 ? "" : "s"} de ${requests.length} solicitud${requests.length === 1 ? "" : "es"}`;
    $("shown-count").textContent = `${filtered.length} solicitud${filtered.length === 1 ? "" : "es"} visible${filtered.length === 1 ? "" : "s"}`;
    $("empty-state").hidden = filtered.length !== 0;
    tbody.innerHTML = filtered.map(item => {
      const status = statusClass(item.estado);
      const vehicle = String(item.tipoVehiculo || "No especificado").toUpperCase();
      const vehicleIcon = vehicle === "MOTO" ? "🏍️" : "🚘";
      const created = item.creadaEn || item.ofertaEnviadaEn;
      return `<tr>
        <td><span class="request-id">${escapeHtml(item.solicitudId || "Sin ID")}</span><span class="request-client">Cliente ${escapeHtml(item.clienteId || "—")}</span></td>
        <td><div class="route-points"><div class="route-point"><i></i><span>${escapeHtml(formatPoint(item.origen))}</span></div><div class="route-point destination"><i></i><span>${escapeHtml(formatPoint(item.destino))}</span></div></div></td>
        <td><span class="vehicle-tag">${vehicleIcon} ${escapeHtml(vehicle)}</span></td>
        <td>${escapeHtml(item.tipoActivacion || "—")}</td>
        <td>${escapeHtml(formatDate(created))}</td>
        <td><span class="status ${escapeHtml(status)}">${escapeHtml(item.estado || "Sin estado")}</span></td>
        <td><button type="button" class="delete-button" data-delete-id="${escapeHtml(item.solicitudId || "")}" aria-label="Eliminar solicitud ${escapeHtml(item.solicitudId || "")}" ${item.solicitudId ? "" : "disabled"}>Eliminar</button></td>
      </tr>`;
    }).join("");
  }
  async function deleteRequest(button) {
    const solicitudId = button.dataset.deleteId;
    if (!solicitudId || !window.confirm(`¿Querés eliminar la solicitud ${solicitudId}? Esta acción no se puede deshacer.`)) {
      return;
    }

    button.disabled = true;
    button.textContent = "Eliminando…";
    try {
      const response = await fetch(`/api/solicitudes/${encodeURIComponent(solicitudId)}`, {
        method: "DELETE",
        headers: { "Accept": "application/json" }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Error HTTP ${response.status}`);

      requests = requests.filter(item => String(item.solicitudId) !== solicitudId);
      render();
      showNotice(`La solicitud ${solicitudId} fue eliminada de la base de datos.`, "success");
    } catch (error) {
      button.disabled = false;
      button.textContent = "Eliminar";
      showNotice(`No se pudo eliminar la solicitud: ${error.message}`, "error");
    }
  }
  async function loadRequests() {
    refreshButton.disabled = true;
    refreshButton.textContent = "Cargando…";
    showNotice("Consultando la base de datos…", "info");
    try {
      const response = await fetch("/api/solicitudes/pendientes", {
        headers: { "Accept": "application/json" },
        cache: "no-store"
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Error HTTP ${response.status}`);
      if (!Array.isArray(data.solicitudes)) throw new Error("La respuesta del servidor no contiene una lista de solicitudes válida.");
      requests = data.solicitudes;
      render();
      if (requests.length === 0) {
        showNotice("Conexión correcta: el servidor respondió, pero la base de datos no contiene solicitudes. Creá una solicitud y volvé a actualizar.", "info");
      } else {
        showNotice(`Conexión correcta: se encontraron ${requests.length} solicitud${requests.length === 1 ? "" : "es"} en la base de datos.`, "success");
      }
    } catch (error) {
      requests = [];
      render();
      showNotice(`${error.message} Verificá que Node.js esté ejecutándose y que la página se haya abierto desde http://localhost:3005.`, "error");
    } finally {
      refreshButton.disabled = false;
      refreshButton.textContent = "↻ Actualizar";
    }
  }
  searchInput.addEventListener("input", render);
  statusFilter.addEventListener("change", render);
  refreshButton.addEventListener("click", loadRequests);
  tbody.addEventListener("click", event => {
    const button = event.target.closest("[data-delete-id]");
    if (button) deleteRequest(button);
  });
  loadOperatorProfile();
  loadRequests();
})();