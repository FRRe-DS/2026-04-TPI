(() => {
  if (sessionStorage.getItem("viajeActivo")) {
    location.replace("/viaje-activo.html");
    return;
  }
  const initialCenter = [-27.451, -58.986];

  let vehicle = "AUTO";
  let pointMode = "origen";
  let origen = null;
  let destino = null;
  let originMarker = null;
  let destinationMarker = null;
  let estimateTimer = null;
  let estimateVersion = 0;
  let estimateReady = false;

  const $ = (id) => document.getElementById(id);

  async function cargarDatosUsuario() {
    try {
      await window.authReady;
      const claims = window.keycloak?.tokenParsed || {};
      const nombreCompleto = [claims.given_name, claims.family_name]
        .filter(Boolean).join(" ").trim();
      const nombre = nombreCompleto || claims.name || claims.preferred_username || claims.email || "Cliente";
      const nameElement = $("client-name");
      const avatarElement = $("client-avatar");
      if (!nameElement || !avatarElement) return;

      nameElement.textContent = nombre;
      avatarElement.textContent = nombre.split(/\s+/).filter(Boolean).slice(0, 2)
        .map(palabra => palabra[0].toUpperCase()).join("") || "CL";
      $("summary-customer").textContent = nombre;
    } catch (error) {
      console.error("Error al cargar los datos del usuario:", error);
      const nameElement = $("client-name");
      if (nameElement) nameElement.textContent = "Cliente";
    }
}

// Cargar los datos de la cuenta activa.
cargarDatosUsuario();

  const originButton = $("choose-origin");
  const destinationButton = $("choose-destination");
  const submitButton = $("submit-request");

  function setPointMode(mode) {
    pointMode = mode;

    originButton.classList.toggle("active", mode === "origen");
    destinationButton.classList.toggle("active", mode === "destino");
  }

  function coordinatesText(point) {
    return point
      ? `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`
      : "Sin seleccionar";
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
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>'
  }).addTo(map);

  map.on("click", (event) => {
    const punto = {
      lat: event.latlng.lat,
      lng: event.latlng.lng
    };

    if (pointMode === "origen") {
      origen = punto;

      if (originMarker) {
        map.removeLayer(originMarker);
      }

      originMarker = L.marker(
        [punto.lat, punto.lng],
        { icon: pinIcon("A", "#168fbd") }
      )
        .addTo(map)
        .bindPopup("Origen del viaje")
        .openPopup();

      $("origin-text").value = "Origen seleccionado en el mapa";
      $("origin-coords").textContent = coordinatesText(origen);
      $("summary-origin").textContent = coordinatesText(origen);

      setPointMode("destino");
    } else {
      destino = punto;

      if (destinationMarker) {
        map.removeLayer(destinationMarker);
      }

      destinationMarker = L.marker(
        [punto.lat, punto.lng],
        { icon: pinIcon("B", "#23b9cf") }
      )
        .addTo(map)
        .bindPopup("Destino del viaje")
        .openPopup();

      $("destination-text").value = "Destino seleccionado en el mapa";
      $("destination-coords").textContent = coordinatesText(destino);
      $("summary-destination").textContent = coordinatesText(destino);
    }
    programarEstimacion();
  });

  originButton.addEventListener("click", () => {
    setPointMode("origen");
  });

  destinationButton.addEventListener("click", () => {
    setPointMode("destino");
  });

  document.querySelectorAll(".vehicle-option").forEach((button) => {
    button.addEventListener("click", () => {
      vehicle = button.dataset.vehicle;

      document.querySelectorAll(".vehicle-option").forEach((option) => {
        const seleccionado = option === button;

        option.classList.toggle("selected", seleccionado);
        option.setAttribute("aria-pressed", String(seleccionado));
      });

      $("summary-vehicle").textContent =
        vehicle === "AUTO" ? "Auto" : "Moto";
      programarEstimacion();
    });
  });

  function showFeedback(message, type) {
    const element = $("feedback");
    element.className = `feedback ${type}`;
    element.textContent = message;
  }

  function mostrarCosto(texto, estado, esError = false) {
    $("summary-cost").textContent = texto;
    const detalle = $("summary-cost-status");
    detalle.textContent = estado;
    detalle.classList.toggle("error", esError);
  }

  function formatoMoneda(total, moneda) {
    try {
      return new Intl.NumberFormat("es-AR", {
        style: "currency",
        currency: moneda || "ARS"
      }).format(total);
    } catch {
      return `${moneda || "ARS"} ${total.toFixed(2)}`;
    }
  }

  // Consulta a M5/M4/M7 con los puntos y vehículo seleccionados actualmente.
  async function actualizarEstimacion(version) {
    if (!origen || !destino) {
      estimateReady = false;
      submitButton.disabled = true;
      mostrarCosto("—", "Seleccioná origen y destino para calcularlo.");
      return;
    }

    mostrarCosto("Calculando…", "Consultando distancia en M4 y tarifa en M7.");
    submitButton.disabled = true;
    try {
      const response = await fetch("/api/solicitudes/estimacion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origen, destino, tipoVehiculo: vehicle })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "No se pudo calcular la tarifa.");
      if (version !== estimateVersion) return;

      const total = Number(data.desglose?.total);
      if (!Number.isFinite(total) || total < 0) throw new Error("M7 no devolvió un total válido.");
      estimateReady = true;
      mostrarCosto(formatoMoneda(total, data.moneda), "Estimación orientativa. Se confirma al crear la solicitud.");
      submitButton.disabled = false;
    } catch (error) {
      if (version !== estimateVersion) return;
      estimateReady = false;
      mostrarCosto("No disponible", error.message, true);
      submitButton.disabled = true;
    }
  }

  // Agrupa cambios rápidos y descarta respuestas de precio para un trayecto que ya cambió.
  function programarEstimacion() {
    clearTimeout(estimateTimer);
    const version = ++estimateVersion;
    estimateReady = false;
    submitButton.disabled = true;
    if (!origen || !destino) {
      void actualizarEstimacion(version);
      return;
    }
    mostrarCosto("—", "Actualizando estimación para el recorrido seleccionado.");
    estimateTimer = setTimeout(() => void actualizarEstimacion(version), 350);
  }

  submitButton.addEventListener("click", async () => {
    if (!origen || !destino) {
      showFeedback(
        "Primero seleccioná el origen y el destino en el mapa.",
        "error"
      );
      return;
    }
    if (!estimateReady) {
      showFeedback("Esperá a que M7 calcule el costo estimado antes de crear la solicitud.", "error");
      return;
    }

    submitButton.disabled = true;
    submitButton.querySelector("span:first-child").textContent =
      "Creando solicitud…";

    try {
      const response = await fetch("/api/solicitudes/inmediata", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          origen: origen,
          destino: destino,
          tipoVehiculo: vehicle,
          tipoActivacion: "Inmediata"
        })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(
          data.error || "No se pudo crear la solicitud."
        );
      }

      const solicitud = data.solicitud || data;
      solicitud.clienteNombre = solicitud.clienteNombre || $("client-name").textContent || "Cliente";
      sessionStorage.setItem("viajeActivo", JSON.stringify(solicitud));
      location.replace("/viaje-activo.html");
      return;

    } catch (error) {
      console.error("Error al crear solicitud:", error);

      showFeedback(
        `${error.message} Comprobá que el servidor Node.js esté iniciado.`,
        "error"
      );
    } finally {
      submitButton.disabled = !estimateReady;
      submitButton.querySelector("span:first-child").textContent =
        "Crear solicitud";
    }
  });

  submitButton.disabled = true;
  setPointMode("origen");
})();
