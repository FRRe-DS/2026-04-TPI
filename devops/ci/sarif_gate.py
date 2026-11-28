"""Quality Gate de SAST sobre los resultados SARIF de CodeQL.

Uso: python devops/ci/sarif_gate.py <carpeta-o-archivo-sarif> [--umbral 7.0]

Falla (exit 1) si hay alguna alerta con security-severity >= umbral.
Escala de GitHub: crítica >= 9.0, alta 7.0-8.9, media 4.0-6.9, baja < 4.0.
Umbral propuesto (a acordar con Desarrollo): 7.0 -> bloquean altas y críticas;
medias y bajas se informan sin bloquear.

Escribe el detalle en $GITHUB_STEP_SUMMARY si existe, y en la salida estándar.
Es igual en G04 y G13.
"""

import argparse
import glob
import json
import os
import sys


def nivel(sev: float) -> str:
    if sev >= 9.0:
        return "crítica"
    if sev >= 7.0:
        return "alta"
    if sev >= 4.0:
        return "media"
    return "baja"


def leer_alertas(rutas):
    alertas = []
    for ruta in rutas:
        with open(ruta, encoding="utf-8") as f:
            sarif = json.load(f)
        for run in sarif.get("runs", []):
            reglas = {}
            driver = run.get("tool", {}).get("driver", {})
            componentes = [driver] + run.get("tool", {}).get("extensions", [])
            for comp in componentes:
                for regla in comp.get("rules", []) or []:
                    reglas[regla.get("id")] = regla
            for res in run.get("results", []):
                regla = reglas.get(res.get("ruleId"), {})
                props = regla.get("properties", {}) or {}
                sev = props.get("security-severity")
                if sev is None:
                    continue  # alertas de calidad, sin severidad de seguridad
                ubic = (res.get("locations") or [{}])[0].get("physicalLocation", {})
                archivo = ubic.get("artifactLocation", {}).get("uri", "?")
                linea = ubic.get("region", {}).get("startLine", "?")
                alertas.append({
                    "sev": float(sev),
                    "regla": res.get("ruleId", "?"),
                    "mensaje": (res.get("message", {}).get("text") or "").splitlines()[0][:160],
                    "lugar": f"{archivo}:{linea}",
                })
    return sorted(alertas, key=lambda a: -a["sev"])


def main() -> int:
    # UTF-8 también en consolas de Windows (cp1252), para correrlo localmente.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("ruta")
    ap.add_argument("--umbral", type=float, default=7.0)
    args = ap.parse_args()

    if os.path.isdir(args.ruta):
        rutas = glob.glob(os.path.join(args.ruta, "**", "*.sarif"), recursive=True)
    else:
        rutas = [args.ruta]
    if not rutas:
        print(f"No se encontraron archivos SARIF en {args.ruta}", file=sys.stderr)
        return 2

    alertas = leer_alertas(rutas)
    bloquean = [a for a in alertas if a["sev"] >= args.umbral]
    icono = "❌" if bloquean else "✅"

    lineas = [
        f"### {icono} Quality Gate SAST (CodeQL)",
        "",
        f"Regla: falla si hay alertas con *security-severity* >= {args.umbral} (altas y críticas).",
        "",
        "| Crítica | Alta | Media | Baja |",
        "|---:|---:|---:|---:|",
        "| {} | {} | {} | {} |".format(
            *(sum(1 for a in alertas if nivel(a["sev"]) == n) for n in ("crítica", "alta", "media", "baja"))
        ),
    ]
    if alertas:
        lineas += ["", "| Severidad | Regla | Ubicación | Mensaje |", "|---|---|---|---|"]
        for a in alertas[:50]:
            msg = a["mensaje"].replace("|", "\\|")
            lineas.append(f"| {nivel(a['sev'])} ({a['sev']}) | `{a['regla']}` | `{a['lugar']}` | {msg} |")
    salida = "\n".join(lineas) + "\n"

    print(salida)
    resumen = os.environ.get("GITHUB_STEP_SUMMARY")
    if resumen:
        with open(resumen, "a", encoding="utf-8") as f:
            f.write(salida + "\n")
    return 1 if bloquean else 0


if __name__ == "__main__":
    sys.exit(main())
