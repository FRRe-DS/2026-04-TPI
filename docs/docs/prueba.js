// ============================================================================
// MÓDULO 5: SOLICITUD Y DESPACHO DE VEHÍCULOS
// Parte B1 (Persona 2 - Lautaro): Ofertas, Vencimiento (TTL), Redis y Medición
// ============================================================================
// NOTA SOBRE COMENTARIOS EN JAVASCRIPT:
// Todo lo que empieza con doble barra "//" es un comentario.
// Node.js lo ignora por completo al ejecutar el programa; sirve únicamente
// para que vos y los profesores entiendan qué hace cada línea de código.

// ----------------------------------------------------------------------------
// 1. FUNCIÓN: medirTiempo (Cumple con RNF-16: Medición solicitud -> oferta)
// ----------------------------------------------------------------------------
// ¿Qué explicar en la defensa?:
// "Esta función recibe el objeto solicitud y calcula cuánto tardó el sistema
// desde que el cliente pidió el viaje (creadaEn) hasta que enviamos la primera
// oferta (ofertaEnviadaEn)."
function medirTiempo(solicitud) {
  // Primero validamos con un 'if': si todavía no se envió ninguna oferta
  // (es decir, ofertaEnviadaEn vale null), devolvemos null para no hacer una resta inválida.
  if (solicitud.ofertaEnviadaEn === null) {
    return null;
  }

  // Restamos la hora en que se envió la oferta menos la hora en que se creó la solicitud.
  // Usamos Math.abs() (valor absoluto) para asegurarnos de que el tiempo nunca dé negativo.
  return Math.abs(solicitud.ofertaEnviadaEn - solicitud.creadaEn);
}

// ----------------------------------------------------------------------------
// 2. FUNCIÓN: crearOferta (Cumple con RF-5.4: Creación de oferta con vencimiento)
// ----------------------------------------------------------------------------
// ¿Qué explicar en la defensa?:
// "Esta función arma el objeto OfertaDespacho para un conductor específico,
// le asigna el estado inicial PENDIENTE y calcula a qué hora exacta vence
// sumándole el TTL (tiempo de vida en segundos) a la hora de envío."
function crearOferta(solicitudId, conductorId, ttlSegundos) {
  // Guardamos en una constante el momento en que se envía la oferta (ej: segundo 1000).
  const enviadaEn = 1000;

  // Creamos el objeto (entre llaves {}) con los datos que pide el Diagrama de Clases:
  const miOferta = {
    solicitudId: solicitudId,           // ID del viaje que pidió el pasajero
    conductorId: conductorId,           // ID del conductor al que le mandamos la oferta
    estado: "PENDIENTE",                // Toda oferta recién creada arranca PENDIENTE
    enviadaEn: enviadaEn,               // Momento exacto en que se envió
    venceEn: enviadaEn + ttlSegundos    // Momento en que caduca (hora de envío + TTL)
  };

  // Devolvemos el objeto terminado para que otra parte del programa lo pueda usar.
  return miOferta;
}

// ----------------------------------------------------------------------------
// 3. FUNCIÓN: crearOfertasParaVarios (Cumple con RF-5.4: Ofertas a 1 o más conductores)
// ----------------------------------------------------------------------------
// ¿Qué explicar en la defensa?:
// "En una ronda de búsqueda podemos ofertarle el viaje a varios conductores.
// Esta función recibe una lista (array) de conductores, recorre uno por uno
// con un bucle 'for...of', le crea su oferta llamando a crearOferta() y guarda
// todas las ofertas en una lista nueva."
function crearOfertasParaVarios(solicitudId, listaConductores, ttlSegundos) {
  // 1) Creamos una lista vacía [] donde iremos guardando cada oferta creada.
  const ofertasCreadas = [];

  // 2) El bucle 'for...of' toma cada conductorId de 'listaConductores' uno por vez.
  for (const conductorId of listaConductores) {
    // Llamamos a nuestra función anterior para crear la oferta de este conductor puntual.
    const oferta = crearOferta(solicitudId, conductorId, ttlSegundos);

    // Con .push() metemos esa oferta individual adentro de la lista 'ofertasCreadas'.
    ofertasCreadas.push(oferta);
  }

  // 3) Cuando termina de recorrer todos los conductores, devolvemos la lista completa.
  return ofertasCreadas;
}

// ----------------------------------------------------------------------------
// 4. FUNCIÓN: verificarVencimiento (Lógica de negocio de vencimiento de oferta)
// ----------------------------------------------------------------------------
// ¿Qué explicar en la defensa?:
// "Compara la hora actual con la hora límite (venceEn) de la oferta.
// Si la hora actual alcanzó o superó el límite, cambia el estado a VENCIDA."
function verificarVencimiento(oferta, horaActual) {
  // Preguntamos si la horaActual es mayor o igual (>=) a la hora en que vencía.
  if (horaActual >= oferta.venceEn) {
    // Usamos un solo signo igual (=) para modificar el estado del objeto a "VENCIDA".
    oferta.estado = "VENCIDA";
  }

  // Devolvemos la oferta (con su estado actualizado si había vencido).
  return oferta;
}

// ----------------------------------------------------------------------------
// 5. FUNCIÓN: guardarConTTL (Cumple con RNF-11: RepositorioOfertasRedis)
// ----------------------------------------------------------------------------
// ¿Qué explicar en la defensa?:
// "Guarda la oferta en Redis asignándole un TTL (Time To Live).
// Como Redis guarda texto plano, primero transformamos el objeto de JavaScript
// a formato JSON (texto) usando JSON.stringify(), y le pasamos el parámetro 'EX'
// para que Redis borre la clave automáticamente cuando pasen los segundos del TTL."
function guardarConTTL(redis, oferta, ttl) {
  // 1) Armamos la clave única uniendo el prefijo "oferta:" con el ID de la solicitud.
  const clave = "oferta:" + oferta.solicitudId;

  // 2) Convertimos el objeto 'oferta' a una cadena de texto JSON.
  const textoJson = JSON.stringify(oferta);

  // 3) Guardamos en Redis: clave, valor en texto, 'EX' (expirar en segundos) y el tiempo ttl.
  redis.set(clave, textoJson, "EX", ttl);
}

// ----------------------------------------------------------------------------
// 6. FUNCIÓN: obtenerVigente / SigueExistiendoOFERTA (Cumple con RNF-11: Redis)
// ----------------------------------------------------------------------------
// ¿Qué explicar en la defensa?:
// "Busca la oferta en Redis por su clave. Si el TTL ya expiró, Redis devuelve null
// y sabemos que la oferta venció. Si todavía existe, convertimos el texto JSON
// nuevamente a un objeto de JavaScript usando JSON.parse()."
function obtenerVigente(redis, solicitudId) {
  // 1) Armamos la clave exactamente igual que cuando la guardamos.
  const clave = "oferta:" + solicitudId;

  // 2) Le pedimos a Redis el valor guardado en esa clave.
  const textoJson = redis.get(clave);

  // 3) Si Redis devuelve null (no existe o ya venció su TTL), devolvemos null.
  if (textoJson === null) {
    return null;
  } else {
    // 4) Si sigue vigente, reconstruimos el objeto original con JSON.parse().
    return JSON.parse(textoJson);
  }
}

// ----------------------------------------------------------------------------
// 7. FUNCIÓN: eliminarOfertaDeRedis (Cumple con RepositorioOfertasRedis.eliminar)
// ----------------------------------------------------------------------------
// ¿Qué explicar en la defensa?:
// "Cuando un conductor acepta o rechaza antes de que se cumpla el TTL, borramos
// la oferta de Redis manualmente con redis.del()."
function eliminarOfertaDeRedis(redis, solicitudId) {
  const clave = "oferta:" + solicitudId;
  redis.del(clave);
}
// ----------------------------------------------------------------------------
// 8. FUNCIÓN: ejecutarRonda (Cumple con RF-5.4: Rondas de búsqueda y despacho)
// ----------------------------------------------------------------------------
// ¿Qué explicar en la defensa?:
// "Ejecuta una ronda de búsqueda. Si la lista de conductores candidatos está vacía
// (.length === 0), devuelve la búsqueda en estado AGOTADA. Si hay candidatos,
// genera las ofertas para todos ellos, registra la hora de envío para medir el
// RNF-16 y devuelve la búsqueda en estado ACTIVA."
function ejecutarRonda(solicitud, candidatosRonda, numeroRonda, ttlSegundos) {
  // 1) Si no hay conductores en esta ronda, la búsqueda queda AGOTADA:
  if (candidatosRonda.length === 0) {
    return {
      solicitudId: solicitud.solicitudId,
      ronda: numeroRonda,
      estadoBusqueda: "AGOTADA",
      ofertasEnviadas: []
    };
  } else {
    // 2) Si hay candidatos, creamos las ofertas para todos los conductores de la ronda:
    const ofertas = crearOfertasParaVarios(solicitud.solicitudId, candidatosRonda, ttlSegundos);

    // 3) Registramos la hora en que se envió la oferta (ej: 1350 o Date.now() para reloj real):
    solicitud.ofertaEnviadaEn = 1350;

    // 4) Calculamos la demora desde que se creó la solicitud hasta que se envió la oferta:
    const demora = medirTiempo(solicitud);

    // 5) Devolvemos el resultado de la ronda con estado ACTIVA:
    return {
      solicitudId: solicitud.solicitudId,
      ronda: numeroRonda,
      estadoBusqueda: "ACTIVA",
      ofertasEnviadas: ofertas,
      tiempoDemora: demora
    };
  }
} 



// SECCIÓN DE PRUEBAS AUTOMÁTICAS (Cumple con las Pruebas pedidas a Persona 2)
// ============================================================================

// PRUEBA 1: Medición de tiempo (RNF-16)
function probarMedicion() {
  const solicitudPrueba = {
    solicitudId: "test-1",
    creadaEn: 1000,
    ofertaEnviadaEn: 1250
  };

  const resultado = medirTiempo(solicitudPrueba);

  if (resultado === 250) {
    console.log("Prueba Medición OK");
  } else {
    console.log("Prueba Medición FALLÓ");
  }
}

// PRUEBA 2: Ofertas a varios conductores (RF-5.4) - Escrita por Lautaro
function probarOfertasVarios() {
  const oferta = crearOfertasParaVarios("test 2", [10, 504, 42120], 15);

  if (oferta.length === 3) {
    console.log("Prueba de crearOfertasVarios OK");
  } else {
    console.log("Prueba de crearOfertasVarios FALLÓ");
  }
}



function probarVerificarVencimiento() { 
  const miOferta = crearOferta("test-3",55555, 78015);

const resultado = verificarVencimiento(miOferta, 1015);

if (resultado.estado === "VENCIDA") { console.log("Prueba verificarVencimiento OK"); } else { console.log("Prueba verificarVencimiento FALLÓ"); } }

// PRUEBA EXTRA: Probar POST /busquedas (Caso exitoso 201 y Caso error 400)
function probarPostBusquedas() {
  const respuestaError = procesarPostBusquedas({ solicitud: null });
  console.log("4) Respuesta POST /busquedas con error (RNF-03):", respuestaError);

  const respuestaExito = procesarPostBusquedas({
    solicitud: { solicitudId: "viaje-100", creadaEn: 1000, ofertaEnviadaEn: null },
    candidatos: [10, 20],
    ronda: 1,
    ttlSegundos: 15
  });
  console.log("5) Respuesta POST /busquedas exitosa (201):", respuestaExito);
}



// Ejecutamos las pruebas:c
probarMedicion();
probarOfertasVarios();
probarVerificarVencimiento();
probarPostBusquedas();
// ===================================================

// ============================================================================
// ZONA DE PRUEBAS (Para ejecutar con 'node prueba.js' en la terminal)
// ============================================================================

// Probamos 1: Medición de tiempo (RNF-16)
const solicitudEjemplo = {
  solicitudId: "viaje-99",
  creadaEn: 1000,
  ofertaEnviadaEn: 1350
};
console.log("1) Tiempo solicitud -> oferta (ms):", medirTiempo(solicitudEjemplo));

// Probamos 2 y 3: Crear ofertas para 3 conductores (IDs 10, 25 y 40) con 15 seg de TTL
const misOfertas = crearOfertasParaVarios("viaje-99", [10, 25, 40], 15);
console.log("2) Ofertas recién creadas:", misOfertas);

// Probamos 4: Verificar si la primera oferta (misOfertas[0]) venció en el segundo 1020
const ofertaDespuesDe20Segundos = verificarVencimiento(misOfertas[0], 1020);
console.log("3) Primera oferta en el segundo 1020:", ofertaDespuesDe20Segundos);

// Probamos 5, 6 y 7: Simulamos un pizarrón de Redis en memoria para probar tus funciones
const pizarronMemoria = {};
const redisSimulado = {
  set: function (clave, valor) { pizarronMemoria[clave] = valor; },
  get: function (clave) { return pizarronMemoria[clave] || null; },
  del: function (clave) { delete pizarronMemoria[clave]; }
};

guardarConTTL(redisSimulado, misOfertas[1], 15);
console.log("4) Oferta recuperada de Redis:", obtenerVigente(redisSimulado, "viaje-99"));

eliminarOfertaDeRedis(redisSimulado, "viaje-99");
console.log("5) Oferta tras eliminarla de Redis:", obtenerVigente(redisSimulado, "viaje-99")); // Debería devolver null 