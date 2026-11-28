"""Reemplazo de M1 (Keycloak) para el E2E del CI.

Genera una clave RSA descartable, publica su clave pública (JWKS) en el mock
(WireMock) en la ruta que usa M5 para validar tokens:
    {KEYCLOAK_ISSUER}/protocol/openid-connect/certs
y firma tokens de prueba con el mismo formato que emite Keycloak (RS256, iss,
aud, sub, exp, realm_access.roles).

La clave vive solo durante el job: no hay secretos en el repo (RNF-06).

Uso:
    python devops/ci/m1_tokens_prueba.py --mock http://127.0.0.1:8089 >> "$GITHUB_ENV"

Variables de entorno de entrada: KEYCLOAK_ISSUER, KEYCLOAK_AUDIENCE.
Escribe en la salida estándar (formato KEY=VALOR):
    M1_CLIENTE_ID        sub del cliente de prueba
    M1_TOKEN_CLIENTE     token con rol CLIENTE
    M1_TOKEN_SIN_ROL     token válido pero sin rol CLIENTE (para probar el 403)
    M1_TOKEN_M3          token de servicio de M3: rol SERVICIO y scope m5:offers:respond
                         (con él M3 responde las ofertas en nombre del conductor)
"""

import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import uuid

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

KID = "m5-ci"


def publicar_jwks(mock: str, issuer: str, jwk: dict) -> None:
    ruta = urllib.parse.urlparse(issuer).path.rstrip("/") + "/protocol/openid-connect/certs"
    mapping = {
        "name": "M1 (Keycloak) JWKS del realm - generado por devops/ci/m1_tokens_prueba.py",
        "request": {"method": "GET", "urlPath": ruta},
        "response": {
            "status": 200,
            "headers": {"Content-Type": "application/json"},
            "jsonBody": {"keys": [jwk]},
        },
    }
    pedido = urllib.request.Request(
        mock.rstrip("/") + "/__admin/mappings",
        data=json.dumps(mapping).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(pedido, timeout=10) as respuesta:
        if respuesta.status not in (200, 201):
            raise SystemExit(f"No se pudo registrar el JWKS en el mock (HTTP {respuesta.status})")
    print(f"JWKS publicado en {mock}{ruta}", file=sys.stderr)


def firmar(clave, issuer: str, audience: str, sub: str, roles: list, scope: str = "") -> str:
    ahora = int(time.time())
    payload = {
        "iss": issuer,
        "aud": audience,
        "sub": sub,
        "iat": ahora,
        "exp": ahora + 3600,
        "email": "cliente.ci@example.com",
        "realm_access": {"roles": roles},
    }
    if scope:
        payload["scope"] = scope
    return jwt.encode(payload, clave, algorithm="RS256", headers={"kid": KID})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mock", required=True, help="URL del WireMock")
    args = ap.parse_args()

    issuer = os.environ.get("KEYCLOAK_ISSUER")
    audience = os.environ.get("KEYCLOAK_AUDIENCE")
    if not issuer or not audience:
        print("Faltan KEYCLOAK_ISSUER o KEYCLOAK_AUDIENCE", file=sys.stderr)
        return 2

    clave = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(clave.public_key()))
    jwk.update({"kid": KID, "use": "sig", "alg": "RS256"})
    publicar_jwks(args.mock, issuer, jwk)

    cliente_id = str(uuid.uuid4())
    print(f"M1_CLIENTE_ID={cliente_id}")
    print(f"M1_TOKEN_CLIENTE={firmar(clave, issuer, audience, cliente_id, ['CLIENTE'])}")
    print(f"M1_TOKEN_SIN_ROL={firmar(clave, issuer, audience, str(uuid.uuid4()), ['CONDUCTOR'])}")
    print(f"M1_TOKEN_M3={firmar(clave, issuer, audience, 'm3-conductores', ['SERVICIO'], 'm5:offers:respond')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
