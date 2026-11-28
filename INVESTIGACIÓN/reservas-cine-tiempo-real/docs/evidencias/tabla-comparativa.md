# WebSocket y polling en el arranque alternativo de Asientos

Node.js 20.20.2, MySQL 8.4.9 y HTTP directo por loopback. Seis cambios REST en cada fase de 60 s. Se registraron 756 pares cliente-cambio.

| Clientes | Mecanismo | Solicitudes/min (TP) | Fórmula teórica | Prom. (ms) | p95 (ms) | Máx. (ms) |
| ---: | --- | ---: | --- | ---: | ---: | ---: |
| 3 | WebSocket | 24 | 3 × (6 + 2) = 24 | 2.185 | 3.211 | 3.211 |
| 3 | Polling 2 s | 90 | 3 × 60 / 2 = 90 | 1174.039 | 1937.974 | 1937.974 |
| 10 | WebSocket | 80 | 10 × (6 + 2) = 80 | 2.199 | 3.223 | 3.259 |
| 10 | Polling 2 s | 300 | 10 × 60 / 2 = 300 | 1188.887 | 1948.150 | 1949.994 |
| 50 | WebSocket | 400 | 50 × (6 + 2) = 400 | 3.222 | 5.772 | 6.316 |
| 50 | Polling 2 s | 1500 | 50 × 60 / 2 = 1500 | 1229.296 | 2007.961 | 2011.249 |

La columna de WebSocket sigue la convención del TP. Suma un upgrade HTTP, una foto inicial y seis mensajes de cambio por cliente. El contador de Asientos dio 21, 70 y 350 mensajes. Los upgrades fueron 3, 10 y 50. La columna de polling cuenta cada GET de grilla en la ventana de 60 s.

| Entorno | Clientes | Mecanismo | Ejecución | Solicitudes/min | Prom. (ms) | p95 (ms) | Máx. (ms) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Gateway | 3, 10 y 50 | WebSocket | NO EJECUTADO | no medido | no medido | no medido | no medido |
| Gateway | 3, 10 y 50 | Polling | NO EJECUTADO | no medido | no medido | no medido | no medido |

El RAR viene sin gateway ni Docker Compose.

[Salida real](mediciones-tiempo-real.txt) · [CSV de observaciones](mediciones-tiempo-real.csv)
