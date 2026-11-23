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
  const point = value => value && Number.isFinite(Number(value.lat)) && Number.isFinite(Number(value.lng))
    ? `${Number(value.lat).toFixed(5)}, ${Number(value.lng).toFixed(5)}` : "—";
  $("trip-origin").textContent = point(solicitud.origen);
  $("trip-destination").textContent = point(solicitud.destino);
  $("trip-client").textContent = solicitud.clienteNombre || "Cliente";
  $("trip-id").textContent = solicitud.solicitudId || "—";
  $("trip-vehicle").textContent = solicitud.tipoVehiculo === "AUTO" ? "Auto" : solicitud.tipoVehiculo === "MOTO" ? "Moto" : solicitud.tipoVehiculo || "—";
  $("trip-vehicle-id").textContent = solicitud.vehiculo_id || "Sin asignar";
  $("trip-driver").textContent = solicitud.conductorId || "Sin asignar";
  $("trip-cost").textContent = solicitud.costo == null ? "A definir" : new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(solicitud.costo);
  $("trip-created").textContent = solicitud.creadaEn ? new Date(solicitud.creadaEn).toLocaleString("es-AR") : "—";
  $("trip-status").textContent = solicitud.estado || "Pendiente";

  document.addEventListener("click", event => {
    if (event.target.closest("a[href='/ventana-de-solicitud.html']")) event.preventDefault();
  });

  $("cancel-trip").addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Cancelando…";
    try {
      const response = await fetch(`/api/solicitudes/${encodeURIComponent(solicitud.solicitudId)}/cancelar`, { method: "PATCH" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "No se pudo cancelar el viaje.");
      solicitud = data.solicitud || data;
      $("trip-status").textContent = solicitud.estado || "CANCELADA";
      sessionStorage.removeItem("viajeActivo");
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
