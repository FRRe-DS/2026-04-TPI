import asyncio
import json
import websockets
from urllib.parse import urlparse, parse_qs

# Datos mock según tu OpenAPI
ASIENTOS_MOCK = [
    {"id": 1001, "funcionId": 42, "fila": "A", "numero": 1, "estado": "libre", "version": 1},
    {"id": 1002, "funcionId": 42, "fila": "A", "numero": 2, "estado": "libre", "version": 1},
    {"id": 1017, "funcionId": 42, "fila": "F", "numero": 5, "estado": "libre", "version": 1}
]

async def handler(websocket):
    path = websocket.request.path
    params = parse_qs(urlparse(path).query)
    token = params.get('token', [None])[0]
    
    # Validar token (según OpenAPI: código 1008 si es inválido)
    if not token:
        await websocket.close(code=1008, reason="Token requerido")
        return
    
    print(f"[MOCK WS] Conexión establecida en {path}")
    
    # Enviar estado completo al conectar (según OpenAPI)
    await websocket.send(json.dumps({
        "tipo": "estado_completo",
        "grilla": {
            "funcionId": 42,
            "generadoEn": "2026-11-12T20:00:00Z",
            "asientos": ASIENTOS_MOCK
        }
    }))
    
    # Loop para recibir mensajes del cliente (pong)
    try:
        async for message in websocket:
            data = json.loads(message)
            print(f"[MOCK WS] Recibido: {data}")
            
            # Simular envío de ping cada 30 segundos
            if data.get('tipo') == 'pong':
                print("[MOCK WS] Pong recibido del cliente")
    except websockets.exceptions.ConnectionClosed:
        print("[MOCK WS] Conexión cerrada")

async def main():
    async with websockets.serve(handler, "0.0.0.0", 8081):
        print("[MOCK WS] Servidor WebSocket corriendo en puerto 8081")
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())