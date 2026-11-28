"""Resumen de un reporte JUnit XML para el resumen del job de GitHub Actions.

Uso: python devops/ci/junit_summary.py <reporte.xml> "<título>"

Escribe una tabla en Markdown (totales y tests fallidos) en $GITHUB_STEP_SUMMARY
si existe, y siempre en la salida estándar. No cambia el resultado del job: el
que falla es el paso que corre los tests.
Es igual en G04 y G13 (los dos stacks generan JUnit).
"""

import os
import sys
import xml.etree.ElementTree as ET


def main() -> int:
    # UTF-8 también en consolas de Windows (cp1252), para correrlo localmente.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) < 2:
        print("uso: junit_summary.py <reporte.xml> [título]", file=sys.stderr)
        return 2
    ruta = sys.argv[1]
    titulo = sys.argv[2] if len(sys.argv) > 2 else "Tests"

    if not os.path.exists(ruta):
        salida = f"### {titulo}\n\nNo se generó el reporte `{ruta}`.\n"
    else:
        raiz = ET.parse(ruta).getroot()
        suites = [raiz] if raiz.tag == "testsuite" else list(raiz.iter("testsuite"))
        total = fallos = errores = omitidos = 0
        tiempo = 0.0
        fallidos = []
        for suite in suites:
            for caso in suite.iter("testcase"):
                total += 1
                tiempo += float(caso.get("time") or 0)
                nombre = f"{caso.get('classname', '')}::{caso.get('name', '')}".strip(":")
                if caso.find("failure") is not None:
                    fallos += 1
                    fallidos.append((nombre, caso.find("failure")))
                elif caso.find("error") is not None:
                    errores += 1
                    fallidos.append((nombre, caso.find("error")))
                elif caso.find("skipped") is not None:
                    omitidos += 1
        pasan = total - fallos - errores - omitidos
        icono = "✅" if fallos + errores == 0 else "❌"
        lineas = [
            f"### {icono} {titulo}",
            "",
            "| Total | Pasan | Fallan | Errores | Omitidos | Tiempo (s) |",
            "|---:|---:|---:|---:|---:|---:|",
            f"| {total} | {pasan} | {fallos} | {errores} | {omitidos} | {tiempo:.1f} |",
        ]
        if fallidos:
            lineas += ["", "| Test que falla | Motivo |", "|---|---|"]
            for nombre, nodo in fallidos[:50]:
                motivo = (nodo.get("message") or nodo.text or "").strip().splitlines()
                motivo = motivo[0][:160] if motivo else ""
                motivo = motivo.replace("|", "\\|")
                lineas.append(f"| `{nombre}` | {motivo} |")
            if len(fallidos) > 50:
                lineas.append(f"| … y {len(fallidos) - 50} más | |")
        salida = "\n".join(lineas) + "\n"

    print(salida)
    resumen = os.environ.get("GITHUB_STEP_SUMMARY")
    if resumen:
        with open(resumen, "a", encoding="utf-8") as f:
            f.write(salida + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
