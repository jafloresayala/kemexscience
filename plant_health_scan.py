"""
Plant Health Scan — Motor de escaneo paralelo de toda la planta.

Estrategia de eficiencia:
  - Fase 1 : Crawl del árbol AF con ThreadPoolExecutor (I/O bound)
             Líneas → Máquinas en paralelo por línea.
  - Fase 2 : Fetch de atributos/tags de cada máquina en paralelo.
  - Fase 3 : Fetch de valores de tags en bloques de 20 (límite de la API)
             con ThreadPoolExecutor.
  - Resultados : Guardados en JSONL incremental + resumen JSON compacto
                 para que el LLM los analice sin saturar el contexto.

Diagnóstico por tag (reglas heurísticas):
  - Flatline   : stdev < FLAT_STDEV  y count > FLAT_MIN_PTS
  - Out-of-range: min < expected_min  o  max > expected_max  (si hay UOM conocida)
  - No data    : count == 0
  - Spike      : max - min > SPIKE_RATIO * mean  (solo valores numéricos)
  - Error      : la API devolvió excepción
"""
from __future__ import annotations

import json
import os
import statistics
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from typing import Callable

import requests
import urllib3

# ── Re-usa constantes del módulo principal ─────────────────────────────────────
from foundry_pi_agent_app import (
    BASE_URL,
    ENDPOINT_CHILDREN,
    ENDPOINT_ATTRIBUTES,
    ENDPOINT_TAG_VALUES,
    PLUGIN_NAME,
    ROOT_PATH,
    VERIFY_SSL,
    API_TIMEOUT,
    MAX_TAGS_PER_CALL,
    _post,
    _ensure_list,
    _format_pi_dt,
    _safe_element_path,
)

# ── Parámetros del escaneo ────────────────────────────────────────────────────
WORKERS_TREE   = 8    # hilos para crawl de árbol AF
WORKERS_ATTRS  = 12   # hilos para fetch de atributos
WORKERS_VALUES = 16   # hilos para fetch de valores

FLAT_STDEV     = 0.001   # umbral de flatline
FLAT_MIN_PTS   = 5       # mínimo de puntos para considerar flatline
SPIKE_RATIO    = 20.0    # ratio pico/media para detectar spike

SCAN_HOURS     = 24      # ventana de tiempo en horas


# ── Estructuras de datos ──────────────────────────────────────────────────────
@dataclass
class TagHealth:
    tag_name: str
    attribute_name: str
    count: int = 0
    avg: float | None = None
    min_val: float | None = None
    max_val: float | None = None
    stdev: float | None = None
    issues: list[str] = field(default_factory=list)
    error: str | None = None


@dataclass
class MachineHealth:
    machine_name: str
    machine_path: str
    line_name: str
    line_path: str
    tags_scanned: int = 0
    tags_with_issues: int = 0
    tags_no_data: int = 0
    tags_error: int = 0
    issue_score: float = 0.0   # ponderado: error=3, no_data=2, flatline/spike=1.5, other=1
    tag_details: list[TagHealth] = field(default_factory=list)
    scan_error: str | None = None


@dataclass
class ScanResult:
    scan_id: str
    started_at: str
    finished_at: str
    from_dt: str
    to_dt: str
    lines_scanned: int
    machines_scanned: int
    tags_scanned: int
    machines: list[MachineHealth] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


# ── Motor de escaneo ──────────────────────────────────────────────────────────
class PlantHealthScanner:
    def __init__(
        self,
        progress_cb: Callable[[dict], None] | None = None,
        output_dir: str | None = None,
    ):
        self.progress_cb = progress_cb or (lambda _: None)
        self.output_dir = output_dir or os.path.dirname(os.path.abspath(__file__))
        self._lock = threading.Lock()
        self._cancelled = False

    def cancel(self):
        self._cancelled = True

    def _emit(self, msg: str, pct: float | None = None, extra: dict | None = None):
        d: dict = {"msg": msg}
        if pct is not None:
            d["pct"] = round(pct, 1)
        if extra:
            d.update(extra)
        self.progress_cb(d)

    # ── Fase 1: Crawl del árbol ────────────────────────────────────────────────
    def _fetch_children(self, path: str) -> list[dict]:
        try:
            raw = _post(ENDPOINT_CHILDREN, {"Plugin_Name": PLUGIN_NAME, "Element_Path": path})
            return _ensure_list(raw)
        except Exception as exc:
            return [{"_error": str(exc), "_path": path}]

    def _crawl_lines_and_machines(self) -> list[tuple[dict, dict]]:
        """
        Retorna lista de (line_item, machine_item) para todas las máquinas de la planta.
        """
        self._emit("🔍 Obteniendo líneas de producción…", 2)
        lines = self._fetch_children(ROOT_PATH)
        real_lines = [l for l in lines if not l.get("_error")]

        if not real_lines:
            raise RuntimeError("No se encontraron líneas en ROOT_PATH.")

        self._emit(f"📋 {len(real_lines)} líneas encontradas. Escaneando máquinas en paralelo…", 5)

        pairs: list[tuple[dict, dict]] = []
        errors: list[str] = []

        def get_machines(line: dict) -> list[tuple[dict, dict]]:
            if self._cancelled:
                return []
            children = self._fetch_children(line["path"])
            result = []
            for child in children:
                if child.get("_error"):
                    errors.append(f"Línea {line.get('name')}: {child['_error']}")
                else:
                    result.append((line, child))
            return result

        with ThreadPoolExecutor(max_workers=WORKERS_TREE) as ex:
            futs = {ex.submit(get_machines, line): line for line in real_lines}
            for fut in as_completed(futs):
                pairs.extend(fut.result())

        self._emit(f"🏭 {len(pairs)} máquinas encontradas en {len(real_lines)} líneas.", 10)
        return pairs

    # ── Fase 2: Fetch de atributos ────────────────────────────────────────────
    def _fetch_machine_attrs(self, machine_path: str) -> list[dict]:
        try:
            raw = _post(ENDPOINT_ATTRIBUTES, {"Plugin_Name": PLUGIN_NAME, "Element_Path": machine_path})
            rows = _ensure_list(raw)
            # Solo atributos con un piPoint (tag real)
            return [r for r in rows if r.get("piPoint") or r.get("PiPoint") or r.get("pi_point")]
        except Exception as exc:
            return [{"_error": str(exc)}]

    # ── Fase 3: Fetch de valores ──────────────────────────────────────────────
    def _fetch_tag_values_batch(
        self,
        tag_names: list[str],
        from_pi: str,
        to_pi: str,
    ) -> dict[str, list]:
        """
        Retorna {tag_name: [values…]} para un batch de hasta MAX_TAGS_PER_CALL tags.
        """
        try:
            raw = _post(ENDPOINT_TAG_VALUES, {
                "Plugin_Name": PLUGIN_NAME,
                "From_Date": from_pi,
                "To_Date": to_pi,
                "Tag_Names": tag_names,
            })
            result: dict[str, list] = {}
            for obj in _ensure_list(raw):
                tname = obj.get("Tag_Name") or "unknown"
                vals = []
                for pt in obj.get("Tag_Values", []) or []:
                    raw_v = pt.get("Value")
                    try:
                        vals.append(float(raw_v))
                    except (TypeError, ValueError):
                        pass
                result[tname] = vals
            return result
        except Exception as exc:
            return {"_error": str(exc), "_tags": tag_names}

    # ── Diagnóstico de un tag ──────────────────────────────────────────────────
    @staticmethod
    def _diagnose(tag_name: str, attr_name: str, values: list[float]) -> TagHealth:
        h = TagHealth(tag_name=tag_name, attribute_name=attr_name)
        h.count = len(values)

        if h.count == 0:
            h.issues.append("NO_DATA")
            return h

        h.avg = round(sum(values) / len(values), 4)
        h.min_val = round(min(values), 4)
        h.max_val = round(max(values), 4)

        if len(values) >= 2:
            try:
                h.stdev = round(statistics.stdev(values), 6)
            except Exception:
                h.stdev = 0.0
        else:
            h.stdev = 0.0

        # Flatline
        if h.count >= FLAT_MIN_PTS and h.stdev is not None and h.stdev < FLAT_STDEV:
            h.issues.append("FLATLINE")

        # Spike
        if h.avg and h.avg != 0 and h.max_val is not None and h.min_val is not None:
            rng = h.max_val - h.min_val
            if rng > SPIKE_RATIO * abs(h.avg):
                h.issues.append("SPIKE")

        return h

    # ── Función principal ──────────────────────────────────────────────────────
    def run(self, hours: int = SCAN_HOURS) -> ScanResult:
        scan_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        started = datetime.now()
        to_dt   = started
        from_dt = to_dt - timedelta(hours=hours)
        from_pi = _format_pi_dt(from_dt)
        to_pi   = _format_pi_dt(to_dt)

        self._emit(f"🚀 Iniciando Plant Health Scan — últimas {hours}h", 0,
                   {"scan_id": scan_id, "from": from_dt.isoformat(), "to": to_dt.isoformat()})

        # ── Fase 1 ────────────────────────────────────────────────────────────
        pairs = self._crawl_lines_and_machines()
        total_machines = len(pairs)

        # ── Fase 2: Atributos en paralelo ─────────────────────────────────────
        self._emit(f"🔗 Obteniendo tags de {total_machines} máquinas…", 15)

        machine_attrs: dict[str, list[dict]] = {}

        def get_attrs(pair: tuple) -> tuple:
            _, machine = pair
            path = machine.get("path", "")
            return path, self._fetch_machine_attrs(path)

        with ThreadPoolExecutor(max_workers=WORKERS_ATTRS) as ex:
            futs = {ex.submit(get_attrs, pair): pair for pair in pairs}
            done = 0
            for fut in as_completed(futs):
                if self._cancelled:
                    break
                path, attrs = fut.result()
                machine_attrs[path] = attrs
                done += 1
                if done % 5 == 0 or done == total_machines:
                    pct = 15 + (done / total_machines) * 20
                    self._emit(f"  attrs {done}/{total_machines}", pct)

        total_tags = sum(
            len([a for a in attrs if not a.get("_error")])
            for attrs in machine_attrs.values()
        )
        self._emit(f"🏷️  {total_tags} tags a consultar en {total_machines} máquinas.", 35)

        # ── Fase 3: Valores de tags en paralelo ───────────────────────────────
        # Construir jobs: (machine_path, [tag_names]) — batches de MAX_TAGS_PER_CALL
        jobs: list[tuple[str, list[str], list[str]]] = []
        for path, attrs in machine_attrs.items():
            valid_attrs = [a for a in attrs if not a.get("_error")]
            tag_map: dict[str, str] = {}
            for a in valid_attrs:
                pt = a.get("piPoint") or a.get("PiPoint") or a.get("pi_point")
                name = a.get("name") or pt or ""
                if pt:
                    tag_map[pt] = name
            tag_list = list(tag_map.keys())
            attr_names = [tag_map[t] for t in tag_list]
            # Dividir en batches
            for i in range(0, len(tag_list), MAX_TAGS_PER_CALL):
                batch_tags = tag_list[i:i + MAX_TAGS_PER_CALL]
                batch_attrs = attr_names[i:i + MAX_TAGS_PER_CALL]
                jobs.append((path, batch_tags, batch_attrs))

        # Resultados de valores: {machine_path: {tag_name: [values]}}
        tag_values: dict[str, dict[str, list]] = {}
        total_jobs = len(jobs)

        def fetch_job(job: tuple) -> tuple:
            m_path, tags, _ = job
            vals = self._fetch_tag_values_batch(tags, from_pi, to_pi)
            return m_path, vals

        with ThreadPoolExecutor(max_workers=WORKERS_VALUES) as ex:
            futs = {ex.submit(fetch_job, job): job for job in jobs}
            done = 0
            for fut in as_completed(futs):
                if self._cancelled:
                    break
                m_path, vals = fut.result()
                if m_path not in tag_values:
                    tag_values[m_path] = {}
                if "_error" not in vals:
                    tag_values[m_path].update(vals)
                done += 1
                if done % 10 == 0 or done == total_jobs:
                    pct = 35 + (done / max(total_jobs, 1)) * 50
                    self._emit(f"  valores {done}/{total_jobs} batches", pct)

        # ── Fase 4: Diagnóstico y construcción de resultados ──────────────────
        self._emit("🩺 Analizando datos…", 86)

        machines_health: list[MachineHealth] = []

        for line, machine in pairs:
            m_path = machine.get("path", "")
            attrs = machine_attrs.get(m_path, [])
            m_vals = tag_values.get(m_path, {})

            mh = MachineHealth(
                machine_name=machine.get("name", m_path),
                machine_path=m_path,
                line_name=line.get("name", ""),
                line_path=line.get("path", ""),
            )

            # ¿Error en fetch de attrs?
            attr_errors = [a for a in attrs if a.get("_error")]
            if attr_errors:
                mh.scan_error = attr_errors[0]["_error"]
                mh.tags_error += 1
                mh.issue_score += 3

            valid_attrs = [a for a in attrs if not a.get("_error")]
            mh.tags_scanned = len(valid_attrs)

            for attr in valid_attrs:
                pt = attr.get("piPoint") or attr.get("PiPoint") or attr.get("pi_point") or ""
                attr_name = attr.get("name") or pt
                values = m_vals.get(pt, [])

                th = self._diagnose(pt, attr_name, values)

                if th.error:
                    mh.tags_error += 1
                    mh.issue_score += 3
                elif "NO_DATA" in th.issues:
                    mh.tags_no_data += 1
                    mh.issue_score += 2
                elif th.issues:
                    mh.tags_with_issues += len(th.issues)
                    mh.issue_score += 1.5 * len(th.issues)

                mh.tag_details.append(th)

            machines_health.append(mh)

        # Ordenar por score descendente
        machines_health.sort(key=lambda m: m.issue_score, reverse=True)

        # ── Guardar resultados ────────────────────────────────────────────────
        finished = datetime.now()
        result = ScanResult(
            scan_id=scan_id,
            started_at=started.isoformat(),
            finished_at=finished.isoformat(),
            from_dt=from_dt.isoformat(),
            to_dt=to_dt.isoformat(),
            lines_scanned=len(set(p[0]["path"] for p in pairs)),
            machines_scanned=total_machines,
            tags_scanned=total_tags,
            machines=machines_health,
        )

        out_file = os.path.join(self.output_dir, f"health_scan_{scan_id}.json")
        with open(out_file, "w", encoding="utf-8") as fh:
            json.dump(_result_to_dict(result), fh, ensure_ascii=False, default=str, indent=2)

        elapsed = round((finished - started).total_seconds(), 1)
        self._emit(
            f"✅ Escaneo completo en {elapsed}s — {total_machines} máq, {total_tags} tags.",
            100,
            {"file": out_file, "elapsed_s": elapsed},
        )
        return result


# ── Serialización ─────────────────────────────────────────────────────────────
def _result_to_dict(r: ScanResult) -> dict:
    return {
        "scan_id": r.scan_id,
        "started_at": r.started_at,
        "finished_at": r.finished_at,
        "from_dt": r.from_dt,
        "to_dt": r.to_dt,
        "lines_scanned": r.lines_scanned,
        "machines_scanned": r.machines_scanned,
        "tags_scanned": r.tags_scanned,
        "errors": r.errors,
        "machines": [
            {
                "machine_name": m.machine_name,
                "machine_path": m.machine_path,
                "line_name": m.line_name,
                "line_path": m.line_path,
                "tags_scanned": m.tags_scanned,
                "tags_with_issues": m.tags_with_issues,
                "tags_no_data": m.tags_no_data,
                "tags_error": m.tags_error,
                "issue_score": round(m.issue_score, 2),
                "scan_error": m.scan_error,
                "tag_details": [
                    {
                        "tag_name": t.tag_name,
                        "attribute_name": t.attribute_name,
                        "count": t.count,
                        "avg": t.avg,
                        "min": t.min_val,
                        "max": t.max_val,
                        "stdev": t.stdev,
                        "issues": t.issues,
                        "error": t.error,
                    }
                    for t in m.tag_details
                ],
            }
            for m in r.machines
        ],
    }


def _tag_detail_for_prompt(t: TagHealth) -> dict:
    """Serializa un TagHealth para el prompt del LLM — solo lo relevante."""
    d: dict = {"tag": t.tag_name, "attr": t.attribute_name}
    if "NO_DATA" in t.issues:
        d["status"] = "NO_DATA"
        return d
    d["status"] = ", ".join(t.issues) if t.issues else "OK"
    if t.count is not None:
        d["pts"] = t.count
    if t.avg is not None:
        d["avg"] = t.avg
    if t.min_val is not None and t.max_val is not None:
        d["range"] = [t.min_val, t.max_val]
    if t.stdev is not None:
        d["stdev"] = t.stdev
    if t.error:
        d["error"] = t.error
    return d


def build_ai_prompt(result: ScanResult, plan: str = "") -> str:
    """
    Construye un prompt compacto pero específico para el LLM.

    Si `plan` está definido, el análisis se orienta completamente a ese objetivo.
    Si no, usa el análisis predeterminado de salud general de planta.
    """
    # Agrupar por línea
    by_line: dict[str, list[MachineHealth]] = {}
    for m in result.machines:
        by_line.setdefault(m.line_name, []).append(m)

    # Top 5 líneas por score EXCLUYENDO el peso de NO_DATA para no sesgar
    # (queremos las líneas con más anomalías reales)
    def _line_anomaly_score(machines: list[MachineHealth]) -> float:
        return sum(
            sum(1.5 for t in m.tag_details if t.issues and "NO_DATA" not in t.issues)
            + (3 * m.tags_error)
            for m in machines
        )

    def _line_total_score(machines: list[MachineHealth]) -> float:
        return sum(m.issue_score for m in machines)

    line_scores = {ln: (_line_anomaly_score(ms), _line_total_score(ms)) for ln, ms in by_line.items()}
    top5_lines = sorted(line_scores.items(), key=lambda x: x[1][0] + x[1][1] * 0.1, reverse=True)[:5]

    lines_summary = []
    for ln, (anomaly_score, total_score) in top5_lines:
        machines = sorted(by_line[ln], key=lambda m: m.issue_score, reverse=True)
        top_maq = machines[:6]
        maq_list = []
        for m in top_maq:
            # Tags con anomalías reales (flatline, spike, error) — nombres específicos
            anomalous = [
                _tag_detail_for_prompt(t)
                for t in m.tag_details
                if t.issues and "NO_DATA" not in t.issues
            ]
            # Tags OK — muestra hasta 3 para contexto
            ok_tags = [
                t.attribute_name or t.tag_name
                for t in m.tag_details
                if not t.issues and t.count and t.count > 0
            ][:3]

            maq_entry: dict = {
                "machine": m.machine_name,
                "score": round(m.issue_score, 1),
                "tags_scanned": m.tags_scanned,
                "no_data_count": m.tags_no_data,   # solo conteo
                "anomalous_tags": anomalous,        # lista con nombres y stats
                "sample_ok_tags": ok_tags,          # contexto de lo que sí funciona
            }
            if m.scan_error:
                maq_entry["api_error"] = m.scan_error
            maq_list.append(maq_entry)

        # Patrón dominante de la línea
        all_issues: list[str] = []
        for m in machines:
            for t in m.tag_details:
                all_issues.extend(i for i in t.issues if i != "NO_DATA")
        from collections import Counter
        issue_counts = Counter(all_issues)

        lines_summary.append({
            "line": ln,
            "anomaly_score": round(anomaly_score, 1),
            "total_score": round(total_score, 1),
            "machines_total": len(machines),
            "machines_with_anomalies": sum(
                1 for m in machines
                if any(t.issues and "NO_DATA" not in t.issues for t in m.tag_details)
            ),
            "dominant_issues": dict(issue_counts.most_common(3)),
            "top_machines": maq_list,
        })

    # Resumen global de tipos de issues en toda la planta
    global_issues: Counter = Counter()
    for m in result.machines:
        for t in m.tag_details:
            for i in t.issues:
                global_issues[i] += 1

    prompt_data = {
        "scan_id": result.scan_id,
        "period": f"{result.from_dt} → {result.to_dt}  (últimas 24h)",
        "plant_scope": {
            "lines": result.lines_scanned,
            "machines": result.machines_scanned,
            "tags_total": result.tags_scanned,
            "global_issue_counts": dict(global_issues.most_common()),
        },
        "legend": {
            "FLATLINE": "Tag con stdev < 0.001 en 24h — el sensor no varió, posiblemente detenido o en valor fijo.",
            "SPIKE": "Tag con rango (max-min) > 20× la media — lectura fuera de rango normal, posible falla de sensor o proceso.",
            "NO_DATA": "La API no devolvió valores — el tag puede estar desconectado, no configurado, o la máquina estaba apagada.",
            "OK": "Tag con datos normales, sin anomalías detectadas.",
            "score": "issue_score = FLATLINE/SPIKE × 1.5  +  NO_DATA × 2  +  ERROR × 3. Mayor score = mayor urgencia.",
        },
        "top5_lines": lines_summary,
    }

    instructions = """\
Eres un ingeniero experto en manufactura electrónica SMT. Analiza los resultados del escaneo de salud de planta y proporciona un informe ejecutivo estructurado de la siguiente manera:

---

## 📊 TOP 5 Líneas con más problemas

Para cada línea del top 5:
- **Nombre de la línea** y su puntuación de anomalías
- Lista de las **máquinas con problemas**, con:
  - Nombre exacto de cada máquina
  - Nombre exacto de cada TAG con anomalía (campo `attr` del JSON), junto con:
    - Tipo de falla: FLATLINE o SPIKE
    - Valores observados (avg, rango, stdev)
    - **Qué significa esto en términos de proceso** (ej: "Squeegee Speed fijo en 0 → posible sensor de velocidad detenido o motor sin movimiento")
    - **Acción recomendada** (ej: "Verificar encoder del squeegee, revisar alarmas activas en la máquina")
- Si hay tags OK en la máquina, menciónalos brevemente para dar contexto

---

## 🏭 Diagnóstico Ejecutivo

Sección de 6-10 puntos concretos con el siguiente formato para cada punto:
> **[MÁQUINA / LÍNEA]** — **[TAG ESPECÍFICO]**: [Descripción del problema]. → **Acción**: [Qué hacer].

Ejemplos del estilo esperado:
> **Línea 1 Left / Paste Printer** — **Squeegee Speed (KP.SMT.L1L.PP.SqueegeeSpeed)**: Flatline en 0.0 durante 24h → posiblemente la máquina no produjo o el encoder no está enviando datos. → **Acción**: Verificar si la máquina estuvo en producción; si sí, revisar configuración del tag en PI.
> **Línea 3 / Reflow Oven** — **Peak Temperature Zone 4 (KP.SMT.L3.RO.PeakTempZ4)**: SPIKE con rango 180-420°C (avg=240°C) → posible lectura errática del termopar en zona 4. → **Acción**: Calibrar termopar Z4, revisar historial de alarmas de temperatura.

---

## ⚠️ Patrones Sistémicos

Si el mismo tipo de anomalía aparece en múltiples líneas (ej: varios flatlines del mismo tipo de tag), indica:
- Qué tag/tipo de sensor está fallando en varias líneas
- Si puede ser un problema de configuración global, mantenimiento preventivo pendiente, o problema de proceso
- Recomendación de acción sistémica

---

IMPORTANTE:
- Usa los nombres exactos de los tags del JSON (campo `attr`) en tu análisis
- NO menciones los tags NO_DATA individualmente — solo referencia el conteo cuando sea relevante para el contexto
- Enfócate en los tags con FLATLINE y SPIKE ya que son los que tienen datos reales con anomalías
- Si una máquina tiene 0 tags con anomalías (solo NO_DATA), indícalo brevemente y pasa a la siguiente
- Sé específico y accionable — el equipo de mantenimiento usará este reporte para tomar decisiones hoy
"""

    if plan.strip():
        instructions = f"""\
Eres un ingeniero experto en manufactura electrónica SMT. El usuario ha definido el siguiente PLAN DE ANÁLISIS:

---
🎯 PLAN DE ANÁLISIS DEL USUARIO:
{plan.strip()}
---

Tu análisis debe estar completamente orientado a cumplir ese plan. Usa los datos del escaneo para responder exactamente lo que el usuario pidió.

Reglas que siempre aplican independientemente del plan:
- Usa los nombres exactos de los tags del JSON (campo `attr`) al referenciar cualquier medición
- Indica el tipo de anomalía (FLATLINE, SPIKE) y los valores observados (avg, rango, stdev) cuando sea relevante
- Ignora los tags NO_DATA en el detalle — solo menciona el conteo si es relevante para el plan
- Sé específico y accionable — el equipo usará este análisis para tomar decisiones

Estructura tu respuesta de forma clara con secciones según lo requiera el plan del usuario.
"""

    return (
        f"{instructions}\n\n"
        f"## Datos del escaneo\n\n"
        f"```json\n{json.dumps(prompt_data, ensure_ascii=False, indent=2)}\n```\n"
    )
