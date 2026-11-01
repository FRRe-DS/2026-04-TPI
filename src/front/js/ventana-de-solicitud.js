(() => {
  const initialCenter = [-27.451, -58.986];

  let vehicle = "AUTO";
  let pointMode = "origen";
  let origen = null;
  let destino = null;
  let originMarker = null;
  let destinationMarker = null;

  const $ = (id) => document.getElementById(id);

  async function cargarDatosUsuario() {
  try {
    // Esperar a que Keycloak termine de autenticar al usuario.
    await window.authReady;

    // Obtener los datos del perfil guardados en Keycloak.
    const perfil = await window.keycloak.loadUserProfile();

    // Priorizar nombre y apellido.
    const nombreCompleto = [
      perfil.firstName,
      perfil.lastName
    ].filter(Boolean).join(" ").trim();

    // Si no hay nombre y apellido, utilizar el nombre de usuario.
    const nombre = nombreCompleto ||
      perfil.username ||
      window.keycloak.tokenParsed?.preferred_username ||
      "Cliente";

    $("client-name").textContent = nombre;

    // Generar las iniciales para el avatar.
    const iniciales = nombre
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(palabra => palabra[0].toUpperCase())
      .join("");

    $("client-avatar").textContent = iniciales || "CL";

  } catch (error) {
    console.error("Error al cargar el perfil del usuario:", error);
    $("client-name").textContent = "Cliente";
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
    });
  });

  function showFeedback(message, type) {
    const element = $("feedback");
    element.className = `feedback ${type}`;
    element.textContent = message;
  }

  submitButton.addEventListener("click", async () => {
    if (!origen || !destino) {
      showFeedback(
        "Primero seleccioná el origen y el destino en el mapa.",
        "error"
      );
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

      showFeedback(
        `Solicitud guardada en la base de datos. ID: ${solicitud.solicitudId} · Estado: ${solicitud.estado}. Persistida en MySQL.`,
        "success"
      );

      $("created-result").hidden = false;
      $("created-result").textContent =
        `Solicitud: ${solicitud.solicitudId} · Cliente: ${solicitud.clienteId} · Vehículo: ${solicitud.tipoVehiculo} · Estado: ${solicitud.estado}`;

    } catch (error) {
      console.error("Error al crear solicitud:", error);

      showFeedback(
        `${error.message} Comprobá que el servidor Node.js esté iniciado.`,
        "error"
      );
    } finally {
      submitButton.disabled = false;
      submitButton.querySelector("span:first-child").textContent =
        "Crear solicitud";
    }
  });

  setPointMode("origen");
})();