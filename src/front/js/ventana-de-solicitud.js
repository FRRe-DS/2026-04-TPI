(() => {
  const CLIENTE_ID = "001";
  const initialCenter = [-27.451, -58.986];
  let vehicle = "AUTO";
  let pointMode = "origen";
  let origin = null;
  let destination = null;
  let originMarker = null;
  let destinationMarker = null;

  const $ = (id) => document.getElementById(id);
  const originButton = $("choose-origin");
  const destinationButton = $("choose-destination");
  const submitButton = $("submit-request");

  function setPointMode(mode) {
    pointMode = mode;
    originButton.classList.toggle("active", mode === "origen");
    destinationButton.classList.toggle("active", mode === "destino");
  }

  function coordinatesText(point) {
    return point ? `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}` : "Sin seleccionar";
  }

  function pinIcon(letter, color) {
    return L.divIcon({
      className: "",
      html: `<div class="custom-pin" style="background:${color}"><span>${letter}</span></div>`,
      iconSize: [29, 29],
      iconAnchor: [14, 29]
    });
  }

  const map = L.map("map").setView(initialCenter, 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>'
  }).addTo(map);

  map.on("click", (event) => {
    const point = { lat: event.latlng.lat, lng: event.latlng.lng };

    if (pointMode === "origen") {
      origin = point;
      if (originMarker) map.removeLayer(originMarker);
      originMarker = L.marker([point.lat, point.lng], { icon: pinIcon("A", "#168fbd") })
        .addTo(map).bindPopup("Origen del viaje").openPopup();
      $("origin-text").value = "Origen seleccionado en el mapa";
      $("origin-coords").textContent = coordinatesText(origin);
      $("summary-origin").textContent = coordinatesText(origin);
      setPointMode("destino");
    } else {
      destination = point;
      if (destinationMarker) map.removeLayer(destinationMarker);
      destinationMarker = L.marker([point.lat, point.lng], { icon: pinIcon("B", "#23b9cf") })
        .addTo(map).bindPopup("Destino del viaje").openPopup();
      $("destination-text").value = "Destino seleccionado en el mapa";
      $("destination-coords").textContent = coordinatesText(destination);
      $("summary-destination").textContent = coordinatesText(destination);
    }
  });

  originButton.addEventListener("click", () => setPointMode("origen"));
  destinationButton.addEventListener("click", () => setPointMode("destino"));

  document.querySelectorAll(".vehicle-option").forEach((button) => {
    button.addEventListener("click", () => {
      vehicle = button.dataset.vehicle;
      document.querySelectorAll(".vehicle-option").forEach((option) => {
        const selected = option === button;
        option.classList.toggle("selected", selected);
        option.setAttribute("aria-pressed", String(selected));
      });
      $("summary-vehicle").textContent = vehicle === "AUTO" ? "Auto" : "Moto";
    });
  });

  function showFeedback(message, type) {
    const element = $("feedback");
    element.className = `feedback ${type}`;
    element.textContent = message;
  }

  submitButton.addEventListener("click", async () => {
    if (!origin || !destination) {
      showFeedback("Primero seleccioná el origen y el destino en el mapa.", "error");
      return;
    }

    submitButton.disabled = true;
    submitButton.querySelector("span:first-child").textContent = "Creando solicitud…";

    try {
      const response = await fetch("/api/solicitudes/inmediata", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clienteId: CLIENTE_ID,
          origen,
          destino,
          tipoVehiculo: vehicle
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "No se pudo crear la solicitud.");
      const solicitud = data.solicitud || data;

      showFeedback(
        `Solicitud creada y agregada a Lista de pendientes. ID: ${solicitud.solicitudId} · Estado: ${solicitud.estado}. Pendientes: ${data.pendientes ?? "—"}.`,
        "success"
      );
      $("created-result").hidden = false;
      $("created-result").textContent =
        `Solicitud: ${solicitud.solicitudId} · Cliente: ${solicitud.clienteId} · Vehículo: ${solicitud.tipoVehiculo} · Estado: ${solicitud.estado}`;
    } catch (error) {
      showFeedback(`${error.message} Comprobá que el servidor Node.js esté iniciado.`, "error");
    } finally {
      submitButton.disabled = false;
      submitButton.querySelector("span:first-child").textContent = "Crear solicitud";
    }
  })();

  // La estructura del menú permite añadir más .nav-item en el futuro.
  setPointMode("origen");
})();
