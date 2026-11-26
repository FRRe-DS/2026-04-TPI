(() => {
  const raw = sessionStorage.getItem("viajeActivo");
  if (!raw) {
    location.replace("/ventana-de-solicitud.html");
    return;
  }

  let solicitud;
  try { solicitud = JSON.parse(raw); } catch {
    sessionStorage.removeItem("viajeActivo");
    location.replace("/ventana-de-solicitud.html");
    return;
  }

  const $ = id => document.getElementById(id);
  const estados = {
    pendiente: { titulo: "Solicitud recibida", detalle: "Estamos preparando la búsqueda de un conductor." },
    buscando: { titulo: "Buscando conductor", detalle: "Estamos buscando un conductor para tu viaje." },
    asignada: { titulo: "Conductor asignado", detalle: "Tu solicitud ya tiene un conductor asignado." },
    sin_disponibilidad: { titulo: "No encontramos conductor", detalle: "No hay conductores disponibles para este recorrido." },
    cancelada: { titulo: "Viaje cancelado", detalle: "La solicitud fue cancelada." }
  };
  const estadosFinales = new Set(["asignada", "sin_disponibilidad", "cancelada"]);

  function formatoPunto(value) {
    return value && Number.isFinite(Number(value.lat)) && Number.isFinite(Number(value.lng))
      ? `${Number(value.lat).toFixed(5)}, ${Number(value.lng).toFixed(5)}`
      : "—";
  }

  function formatoCosto(value, moneda) {
    if (value == null || !Number.isFinite(Number(value))) return "A definir";
    try {
      return new Intl.NumberFormat("es-AR", {
        style: "currency",
        currency: moneda || "ARS"
      }).format(Number(value));
    } catch {
      return `${moneda || "ARS"} ${value}`;
    }
  }

  // Muestra la información persistida por M5 y traduce sus estados técnicos a mensajes claros.
  function mostrarSolicitud(actual) {
    solicitud = { ...solicitud, ...actual };
    const estado = String(solicitud.estado || "buscando").toLowerCase();
    const mensaje = estados[estado] || { titulo: estado, detalle: "Estado actualizado por el backend." };
    $("trip-heading").textContent = mensaje.titulo;
    $("trip-message").textContent = mensaje.detalle;
    $("trip-status").textContent = mensaje.titulo;
    $("trip-origin").textContent = formatoPunto(solicitud.origen);
    $("trip-destination").textContent = formatoPunto(solicitud.destino);
    $("trip-client").textContent = solicitud.clienteNombre || "Cliente";
    $("trip-id").textContent = solicitud.solicitudId || "—";
    $("trip-vehicle").textContent = solicitud.tipoVehiculo === "AUTO"
      ? "Auto"
      : solicitud.tipoVehiculo === "MOTO" ? "Moto" : solicitud.tipoVehiculo || "—";
    $("trip-vehicle-id").textContent = solicitud.vehiculo_id || "Sin asignar";
    $("trip-driver").textContent = solicitud.conductorId || "Sin asignar";
    $("trip-cost").textContent = formatoCosto(solicitud.costo, solicitud.moneda);
    $("trip-created").textContent = solicitud.creadaEn
      ? new Date(solicitud.creadaEn).toLocaleString("es-AR")
      : "—";
    $("cancel-trip").hidden = estadosFinales.has(estado);
    sessionStorage.setItem("viajeActivo", JSON.stringify(solicitud));
  }

  mostrarSolicitud(solicitud);

  // Consulta el registro para reflejar cuando M5 asigna un conductor o termina la búsqueda.
  let sondeo;
  async function actualizarEstado() {
    if (!solicitud.solicitudId) return;
    try {
      const response = await fetch(`/api/solicitudes/${encodeURIComponent(solicitud.solicitudId)}`, {
        headers: { Accept: "application/json" },
        cache: "no-store"
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Error HTTP ${response.status}`);
      const actual = data.solicitud || data;
      mostrarSolicitud({ ...actual, clienteNombre: solicitud.clienteNombre });
      if (estadosFinales.has(String(actual.estado || "").toLowerCase())) clearInterval(sondeo);
    } catch (error) {
      console.warn("No se pudo actualizar el estado de la solicitud:", error.message);
    }
  }
  sondeo = setInterval(actualizarEstado, 4000);

  document.addEventListener("click", event => {
    if (event.target.closest("a[href='/ventana-de-solicitud.html']")) event.preventDefault();
  });

  $("cancel-trip").addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Cancelando…";
    try {
      const response = await fetch(`/api/solicitudes/${encodeURIComponent(solicitud.solicitudId)}/cancelar`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "No se pudo cancelar el viaje.");
      solicitud = data.solicitud || data;
      mostrarSolicitud(solicitud);
      clearInterval(sondeo);
      $("feedback").textContent = "El viaje fue cancelado.";
      button.textContent = "Viaje cancelado";
      setTimeout(() => location.replace("/ventana-de-solicitud.html"), 900);
    } catch (error) {
      $("feedback").textContent = error.message;
      button.disabled = false;
      button.textContent = "Cancelar viaje";
    }
  });
})();
