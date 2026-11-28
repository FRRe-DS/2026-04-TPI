
import { leerSesion, borrarSesion, irAlLogin } from './sesion.js';

const gateway = new URL(window.location.origin);
// La ejecución directa de frontend-cine/server.js usa 3000 y el gateway usa 8080.
if (gateway.port === '3000') gateway.port = '8080';
const API_BASE = (window.CINE_API_BASE || gateway.origin).replace(/\/+$/, '');
const PAGE_MODE = document.documentElement.dataset.mode === 'polling' ? 'polling' : 'websocket';
const POLLING_INTERVAL_MS = 2000;
const METRICS_INTERVAL_MS = 10000;
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

const elements = {
  currentUser: document.getElementById('currentUser'),
  logout: document.getElementById('logout'),
  connectionStatus: document.getElementById('connectionStatus'),
  connectionText: document.getElementById('connectionText'),
  functionSelect: document.getElementById('functionSelect'),
  reloadFunctions: document.getElementById('reloadFunctions'),
  functionInfo: document.getElementById('functionInfo'),
  seatGrid: document.getElementById('seatGrid'),
  seatCount: document.getElementById('seatCount'),
  feedback: document.getElementById('feedback'),
  ownLockPanel: document.getElementById('ownLockPanel'),
  ownLockSeat: document.getElementById('ownLockSeat'),
  countdown: document.getElementById('countdown'),
  countdownHelp: document.getElementById('countdownHelp'),
  confirmButton: document.getElementById('confirmButton'),
  releaseButton: document.getElementById('releaseButton'),
  activeConnections: document.getElementById('activeConnections'),
  messagesEmitted: document.getElementById('messagesEmitted'),
  pollingRequests: document.getElementById('pollingRequests'),
  metricsNote: document.getElementById('metricsNote'),
  refreshMetrics: document.getElementById('refreshMetrics'),
  toastRegion: document.getElementById('toastRegion')
};

const state = {
  token: '',
  userSub: null,
  functions: [],
  selectedFunctionId: null,
  seats: [],
  activeOwnedSeatId: null,
  socket: null,
  reconnectTimer: null,
  reconnectDelay: INITIAL_RECONNECT_DELAY_MS,
  manuallyStoppedSocket: false,
  pollingTimer: null,
  pollingInFlight: false,
  metricsTimer: null,
  countdownTimer: null,
  expiryTimer: null,
  expiredLockRefreshRequested: false
};

class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.mensaje || `Error HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload?.codigo || 'ERROR_API';
  }
}

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

async function apiRequest(path, options = {}) {
  if (!state.token) throw new Error('Iniciá sesión para continuar.');

  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${state.token}`);
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  let response;
  try {
    response = await fetch(apiUrl(path), { ...options, headers });
  } catch (error) {
    throw new Error('No se pudo conectar con el gateway. Revisá que esté iniciado y que la URL sea correcta.');
  }

  if (response.status === 401) {
    salir(true);
    throw new Error('Volvé a iniciar sesión.');
  }
  if (response.status === 204) return null;

  let payload = null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    throw new ApiError(response.status, payload);
  }
  return payload;
}

function setConnectionState(kind, message) {
  if (!elements.connectionStatus || !elements.connectionText) return;
  elements.connectionStatus.className = `status-pill status-${kind}`;
  elements.connectionText.textContent = message;
}

function setFeedback(message, kind = '') {
  if (!elements.feedback) return;
  elements.feedback.textContent = message;
  elements.feedback.className = `feedback ${kind}`.trim();
}

function showToast(message, kind = '') {
  if (!elements.toastRegion) return;
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`.trim();
  toast.textContent = message;
  elements.toastRegion.appendChild(toast);
  window.setTimeout(() => toast.remove(), 4500);
}

function formatDate(value) {
  if (!value) return 'Horario no informado';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

function formatSeatName(seat) {
  return `${seat.fila}${seat.numero}`;
}

function isMyLock(seat) {
  return seat.estado === 'bloqueado'
    && Boolean(state.userSub)
    && seat.bloqueadoPor === state.userSub;
}

function findMyLockedSeat() {
  const seats = state.seats.filter(isMyLock);
  if (state.activeOwnedSeatId != null) {
    const active = seats.find(seat => seat.id === state.activeOwnedSeatId);
    if (active) return active;
  }
  return seats[0] || null;
}

function updateSeat(incomingSeat) {
  if (!incomingSeat || incomingSeat.id == null) return;
  const index = state.seats.findIndex(seat => seat.id === incomingSeat.id);
  if (index === -1) {
    state.seats.push(incomingSeat);
  } else {
    const current = state.seats[index];
    const incomingVersion = Number(incomingSeat.version ?? 0);
    const currentVersion = Number(current.version ?? 0);
    if (incomingVersion < currentVersion) return;
    state.seats[index] = { ...current, ...incomingSeat };
  }
  renderSeatGrid();
  renderOwnLock();
}

function renderFunctionInfo() {
  const current = state.functions.find(fn => String(fn.id) === String(state.selectedFunctionId));
  if (!current) {
    elements.functionInfo.textContent = 'Seleccioná una función para ver la sala.';
    return;
  }
  elements.functionInfo.innerHTML = '';
  const lines = [
    current.sala || 'Sala sin nombre',
    formatDate(current.horario),
    `${current.filas} filas · ${current.asientosPorFila} asientos por fila`
  ];
  lines.forEach(line => {
    const div = document.createElement('div');
    div.textContent = line;
    elements.functionInfo.appendChild(div);
  });
}

function renderFunctions() {
  const previous = state.selectedFunctionId;
  elements.functionSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = state.functions.length ? 'Seleccioná una función...' : 'No hay funciones disponibles';
  elements.functionSelect.appendChild(placeholder);

  state.functions.forEach(fn => {
    const option = document.createElement('option');
    option.value = String(fn.id);
    option.textContent = `${fn.pelicula} · ${formatDate(fn.horario)} · ${fn.sala}`;
    elements.functionSelect.appendChild(option);
  });

  if (previous != null && state.functions.some(fn => String(fn.id) === String(previous))) {
    elements.functionSelect.value = String(previous);
  } else {
    state.selectedFunctionId = null;
    elements.functionSelect.value = '';
  }
  renderFunctionInfo();
}

async function loadFunctions() {
  elements.reloadFunctions.disabled = true;
  try {
    const functions = await apiRequest('/api/funciones');
    if (!Array.isArray(functions)) throw new Error('La respuesta de /api/funciones no tiene el formato esperado.');
    state.functions = functions;
    renderFunctions();
    if (state.selectedFunctionId) {
      await selectFunction(state.selectedFunctionId);
    }
    if (!functions.length) setFeedback('No hay funciones disponibles para mostrar.', '');
  } catch (error) {
    showToast(error.message, 'error');
    setFeedback(`No se pudieron cargar las funciones: ${error.message}`, 'error');
  } finally {
    elements.reloadFunctions.disabled = false;
  }
}

function stopPolling() {
  if (state.pollingTimer) window.clearInterval(state.pollingTimer);
  state.pollingTimer = null;
  state.pollingInFlight = false;
}

function stopWebSocket() {
  state.manuallyStoppedSocket = true;
  if (state.reconnectTimer) window.clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  if (state.socket) {
    const socket = state.socket;
    state.socket = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.onopen = null;
    try { socket.close(1000, 'Cambio de función o modo'); } catch { /* La conexión ya puede estar cerrada. */ }
  }
}

function stopRealtime() {
  stopPolling();
  stopWebSocket();
}

async function fetchGrid({ silent = false } = {}) {
  if (!state.selectedFunctionId) return;
  try {
    const result = await apiRequest(`/api/asientos?funcionId=${encodeURIComponent(state.selectedFunctionId)}`);
    if (!result || !Array.isArray(result.asientos)) {
      throw new Error('La respuesta de la grilla no tiene el formato esperado.');
    }
    state.seats = result.asientos;
    renderSeatGrid();
    renderOwnLock();
    if (PAGE_MODE === 'polling') setConnectionState('connected', 'Polling activo');
    if (!silent) setFeedback(`Grilla actualizada · ${formatDate(result.generadoEn)}`, 'success');
    state.expiredLockRefreshRequested = false;
  } catch (error) {
    if (PAGE_MODE === 'polling') setConnectionState('error', 'Error de consulta');
    if (!silent) setFeedback(`No se pudo actualizar la grilla: ${error.message}`, 'error');
  }
}

function renderSeatGrid() {
  elements.seatGrid.innerHTML = '';
  elements.seatGrid.classList.remove('empty-grid');

  if (!state.selectedFunctionId || !state.seats.length) {
    elements.seatGrid.classList.add('empty-grid');
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = state.selectedFunctionId
      ? 'La función no tiene asientos para mostrar.'
      : 'Primero seleccioná una función para cargar la grilla.';
    elements.seatGrid.appendChild(empty);
    elements.seatCount.textContent = state.selectedFunctionId ? '0 asientos' : 'Sin función';
    return;
  }

  const freeCount = state.seats.filter(seat => seat.estado === 'libre').length;
  elements.seatCount.textContent = `${freeCount} libres / ${state.seats.length} asientos`;

  const rows = new Map();
  state.seats.forEach(seat => {
    const rowName = String(seat.fila);
    if (!rows.has(rowName)) rows.set(rowName, []);
    rows.get(rowName).push(seat);
  });

  [...rows.keys()].sort((a, b) => a.localeCompare(b, 'es', { numeric: true })).forEach(rowName => {
    const row = document.createElement('div');
    row.className = 'seat-row';
    const label = document.createElement('span');
    label.className = 'row-label';
    label.textContent = rowName;
    row.appendChild(label);

    rows.get(rowName)
      .sort((a, b) => Number(a.numero) - Number(b.numero))
      .forEach(seat => {
        const button = document.createElement('button');
        const mine = isMyLock(seat);
        button.type = 'button';
        button.className = 'seat';
        button.textContent = seat.numero;
        button.title = `Fila ${seat.fila}, asiento ${seat.numero}: ${seat.estado}`;
        button.setAttribute('aria-label', `Fila ${seat.fila}, asiento ${seat.numero}, ${seat.estado}${mine ? ', tu reserva' : ''}`);

        if (seat.estado === 'bloqueado') button.classList.add('is-locked');
        else if (seat.estado === 'vendido') button.classList.add('is-sold');
        if (mine) button.classList.add('is-mine');

        button.disabled = seat.estado !== 'libre' && !mine;
        button.addEventListener('click', () => handleSeatClick(seat));
        row.appendChild(button);
      });
    elements.seatGrid.appendChild(row);
  });
}

async function handleSeatClick(seat) {
  if (isMyLock(seat)) {
    state.activeOwnedSeatId = seat.id;
    renderOwnLock();
    setFeedback(`Tenés bloqueado el asiento ${formatSeatName(seat)}. Confirmá la compra o liberalo.`, 'success');
    return;
  }
  if (seat.estado !== 'libre') return;

  setFeedback(`Solicitando el bloqueo del asiento ${formatSeatName(seat)}...`);
  try {
    const lockedSeat = await apiRequest(`/api/asientos/${encodeURIComponent(seat.id)}/bloqueo`, { method: 'POST' });
    if (lockedSeat) {
      if (!lockedSeat.bloqueadoPor && state.userSub) lockedSeat.bloqueadoPor = state.userSub;
      updateSeat(lockedSeat);
      if (isMyLock(lockedSeat)) state.activeOwnedSeatId = lockedSeat.id;
    }
    renderOwnLock();
    const current = state.seats.find(item => item.id === seat.id) || lockedSeat;
    setFeedback(`Reservaste temporalmente el asiento ${formatSeatName(current)}. Tenés que confirmar antes de que venza.`, 'success');
    showToast(`El asiento ${formatSeatName(current)} quedó bloqueado para vos.`, 'success');
  } catch (error) {
    if (error.status === 409) {
      const message = error.message || 'Otra persona acaba de elegir ese asiento.';
      setFeedback(`Conflicto: ${message} Elegí otro asiento.`, 'error');
      showToast('Ese asiento ya no está disponible. Actualizamos la grilla.', 'error');
      await fetchGrid({ silent: true });
    } else {
      setFeedback(`No se pudo bloquear el asiento: ${error.message}`, 'error');
      showToast(error.message, 'error');
    }
  }
}

function renderOwnLock() {
  const seat = findMyLockedSeat();
  if (!seat) {
    elements.ownLockPanel.classList.add('hidden');
    elements.countdown.textContent = '--:--';
    state.activeOwnedSeatId = null;
    return;
  }

  state.activeOwnedSeatId = seat.id;
  elements.ownLockPanel.classList.remove('hidden');
  elements.ownLockSeat.textContent = `Asiento ${formatSeatName(seat)}`;
  updateCountdown();
}

function updateCountdown() {
  const seat = findMyLockedSeat();
  if (!seat) {
    elements.ownLockPanel.classList.add('hidden');
    return;
  }

  const deadline = seat.bloqueadoHasta ? new Date(seat.bloqueadoHasta).getTime() : NaN;
  if (!Number.isFinite(deadline)) {
    elements.countdown.textContent = '—:—';
    elements.countdownHelp.textContent = 'El servidor no informó la hora de vencimiento.';
    return;
  }

  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    elements.countdown.textContent = '00:00';
    elements.countdownHelp.textContent = 'El tiempo de reserva terminó. Actualizando disponibilidad...';
    if (!state.expiredLockRefreshRequested) {
      state.expiredLockRefreshRequested = true;
      window.setTimeout(() => fetchGrid({ silent: true }), 300);
    }
    return;
  }

  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  elements.countdown.textContent = `${minutes}:${seconds}`;
  elements.countdownHelp.textContent = `Vence: ${formatDate(seat.bloqueadoHasta)}.`;
}

async function confirmOwnedSeat() {
  const seat = findMyLockedSeat();
  if (!seat) return;
  elements.confirmButton.disabled = true;
  try {
    const soldSeat = await apiRequest(`/api/asientos/${encodeURIComponent(seat.id)}/confirmacion`, { method: 'POST' });
    if (soldSeat) updateSeat(soldSeat);
    else await fetchGrid({ silent: true });
    state.activeOwnedSeatId = null;
    renderOwnLock();
    setFeedback(`Compra confirmada para el asiento ${formatSeatName(seat)}.`, 'success');
    showToast(`¡Compra confirmada! Asiento ${formatSeatName(seat)}.`, 'success');
  } catch (error) {
    if (error.status === 409) {
      setFeedback('El bloqueo venció o dejó de ser válido. Actualizamos la grilla; elegí otro asiento.', 'error');
      showToast('No se pudo confirmar: el bloqueo venció o ya no es válido.', 'error');
      await fetchGrid({ silent: true });
    } else {
      setFeedback(`No se pudo confirmar la compra: ${error.message}`, 'error');
      showToast(error.message, 'error');
    }
  } finally {
    elements.confirmButton.disabled = false;
  }
}

async function releaseOwnedSeat() {
  const seat = findMyLockedSeat();
  if (!seat) return;
  elements.releaseButton.disabled = true;
  try {
    await apiRequest(`/api/asientos/${encodeURIComponent(seat.id)}/bloqueo`, { method: 'DELETE' });
    state.seats = state.seats.map(item => item.id === seat.id
      ? { ...item, estado: 'libre', bloqueadoPor: null, bloqueadoHasta: null }
      : item);
    state.activeOwnedSeatId = null;
    renderSeatGrid();
    renderOwnLock();
    setFeedback(`Liberaste el asiento ${formatSeatName(seat)}.`, 'success');
    showToast(`El asiento ${formatSeatName(seat)} volvió a estar libre.`, 'success');
  } catch (error) {
    setFeedback(`No se pudo liberar el asiento: ${error.message}`, 'error');
    showToast(error.message, 'error');
    if (error.status === 403) await fetchGrid({ silent: true });
  } finally {
    elements.releaseButton.disabled = false;
  }
}

function makeWebSocketUrl(functionId) {
  const url = new URL(API_BASE);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const basePath = url.pathname.replace(/\/$/, '');
  url.pathname = `${basePath}/ws/sala/${encodeURIComponent(functionId)}`;
  url.search = new URLSearchParams({ token: state.token }).toString();
  return url.toString();
}

function connectWebSocket() {
  if (PAGE_MODE !== 'websocket' || !state.selectedFunctionId || !state.token) return;
  state.manuallyStoppedSocket = false;
  setConnectionState('reconnecting', 'Conectando...');

  let socket;
  try {
    socket = new WebSocket(makeWebSocketUrl(state.selectedFunctionId));
  } catch (error) {
    scheduleReconnect(error.message);
    return;
  }
  state.socket = socket;

  socket.addEventListener('open', () => {
    if (state.socket !== socket) return;
    state.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    if (state.reconnectTimer) window.clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
    setConnectionState('connected', 'Conectado');
  });

  socket.addEventListener('message', event => {
    if (state.socket !== socket) return;
    handleWebSocketMessage(event.data, socket);
  });

  socket.addEventListener('error', () => {
    if (state.socket === socket) setConnectionState('reconnecting', 'Conexión inestable');
  });

  socket.addEventListener('close', event => {
    if (state.socket !== socket) return;
    state.socket = null;
    if (state.manuallyStoppedSocket) return;
    if (event.code === 1008) {
      salir(true);
      return;
    }
    if (event.code === 1000) {
      setConnectionState('idle', 'Desconectado');
      return;
    }
    scheduleReconnect(`Conexión cerrada (${event.code || 'sin código'})`);
  });
}

function scheduleReconnect(reason = '') {
  if (state.manuallyStoppedSocket || PAGE_MODE !== 'websocket' || !state.selectedFunctionId) return;
  if (state.reconnectTimer) return;
  const delay = state.reconnectDelay;
  setConnectionState('reconnecting', `Reconectando en ${Math.ceil(delay / 1000)} s`);
  if (reason) setFeedback(`${reason}. Se intentará reconectar automáticamente.`, '');
  state.reconnectTimer = window.setTimeout(() => {
    state.reconnectTimer = null;
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    connectWebSocket();
  }, delay);
}

function handleWebSocketMessage(rawMessage, socket) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch {
    return;
  }

  switch (message.tipo) {
    case 'estado_completo':
      if (message.grilla && Array.isArray(message.grilla.asientos)) {
        state.seats = message.grilla.asientos;
        renderSeatGrid();
        renderOwnLock();
        setFeedback('Grilla sincronizada con el servidor.', 'success');
      }
      break;
    case 'asiento_bloqueado':
      updateSeat({
        id: message.asientoId,
        funcionId: state.selectedFunctionId,
        fila: message.fila,
        numero: message.numero,
        estado: 'bloqueado',
        bloqueadoHasta: message.bloqueadoHasta,
        version: message.version
      });
      break;
    case 'asiento_liberado':
      updateSeat({
        id: message.asientoId,
        funcionId: state.selectedFunctionId,
        fila: message.fila,
        numero: message.numero,
        estado: 'libre',
        bloqueadoPor: null,
        bloqueadoHasta: null,
        version: message.version
      });
      break;
    case 'asiento_vendido':
      updateSeat({
        id: message.asientoId,
        funcionId: state.selectedFunctionId,
        fila: message.fila,
        numero: message.numero,
        estado: 'vendido',
        bloqueadoPor: null,
        bloqueadoHasta: null,
        version: message.version
      });
      break;
    case 'ping':
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ tipo: 'pong' }));
      break;
    default:
      // Se ignoran los tipos de mensaje no contemplados por el contrato.
      break;
  }
}

function startPolling() {
  if (PAGE_MODE !== 'polling' || !state.selectedFunctionId) return;
  stopPolling();
  setConnectionState('connected', 'Polling activo');
  state.pollingTimer = window.setInterval(async () => {
    if (state.pollingInFlight || !state.selectedFunctionId) return;
    state.pollingInFlight = true;
    try {
      await fetchGrid({ silent: true });
    } finally {
      state.pollingInFlight = false;
    }
  }, POLLING_INTERVAL_MS);
}

async function selectFunction(functionId) {
  stopRealtime();
  state.selectedFunctionId = functionId ? String(functionId) : null;
  state.seats = [];
  state.activeOwnedSeatId = null;
  state.expiredLockRefreshRequested = false;
  renderFunctionInfo();
  renderSeatGrid();
  renderOwnLock();

  if (!state.selectedFunctionId) {
    setConnectionState('idle', 'Sin función');
    return;
  }

  const selected = state.functions.find(fn => String(fn.id) === String(functionId));
  if (selected) {
    elements.functionInfo.innerHTML = '';
    [selected.sala, formatDate(selected.horario), `${selected.filas} filas · ${selected.asientosPorFila} asientos por fila`].forEach(text => {
      const div = document.createElement('div');
      div.textContent = text;
      elements.functionInfo.appendChild(div);
    });
  }

  setConnectionState('reconnecting', 'Cargando grilla...');
  await fetchGrid();
  if (PAGE_MODE === 'websocket') connectWebSocket();
  else startPolling();
}

async function refreshMetrics() {
  if (!state.token) return;
  elements.refreshMetrics.disabled = true;
  const [connectionsResult, pollingResult] = await Promise.allSettled([
    apiRequest('/api/metricas/conexiones'),
    apiRequest('/api/metricas/solicitudes?ventanaSegundos=60')
  ]);

  if (connectionsResult.status === 'fulfilled') {
    const metrics = connectionsResult.value;
    elements.activeConnections.textContent = metrics.conexionesActivas ?? '—';
    elements.messagesEmitted.textContent = metrics.mensajesEmitidos ?? '—';
  } else {
    elements.activeConnections.textContent = '—';
    elements.messagesEmitted.textContent = '—';
  }

  if (pollingResult.status === 'fulfilled') {
    elements.pollingRequests.textContent = pollingResult.value.solicitudesPolling ?? '—';
  } else {
    elements.pollingRequests.textContent = '—';
  }

  if (connectionsResult.status === 'rejected' || pollingResult.status === 'rejected') {
    elements.metricsNote.textContent = 'No se pudieron consultar todas las métricas. Revisá que los endpoints estén disponibles.';
  } else {
    elements.metricsNote.textContent = 'Última actualización: ' + new Date().toLocaleTimeString('es-AR');
  }
  elements.refreshMetrics.disabled = false;
}

function startMetricsRefresh() {
  if (state.metricsTimer) window.clearInterval(state.metricsTimer);
  refreshMetrics();
  state.metricsTimer = window.setInterval(refreshMetrics, METRICS_INTERVAL_MS);
}

function salir(vencida = false) {
  if (!state.token) return;
  state.token = '';
  state.userSub = null;
  document.body.hidden = true;
  stopRealtime();
  window.clearInterval(state.metricsTimer);
  window.clearInterval(state.countdownTimer);
  window.clearTimeout(state.expiryTimer);
  borrarSesion();
  irAlLogin(PAGE_MODE, vencida);
}

function initialize() {
  const sesion = leerSesion();
  if (!sesion) {
    irAlLogin(PAGE_MODE);
    return;
  }
  state.token = sesion.token;
  state.userSub = sesion.usuario;
  elements.currentUser.textContent = sesion.usuario;
  elements.logout.addEventListener('click', () => salir());
  elements.functionSelect.addEventListener('change', event => selectFunction(event.target.value));
  elements.reloadFunctions.addEventListener('click', loadFunctions);
  elements.confirmButton.addEventListener('click', confirmOwnedSeat);
  elements.releaseButton.addEventListener('click', releaseOwnedSeat);
  elements.refreshMetrics.addEventListener('click', refreshMetrics);

  // Al volver con Atrás, cargar la identidad actual antes de mostrar una sala anterior.
  window.addEventListener('pagehide', () => {
    document.body.hidden = true;
    stopRealtime();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) window.location.reload();
  });

  state.expiryTimer = window.setTimeout(() => salir(true), sesion.exp * 1000 - Date.now());
  state.countdownTimer = window.setInterval(updateCountdown, 1000);
  document.body.hidden = false;
  loadFunctions();
  startMetricsRefresh();
}

initialize();
