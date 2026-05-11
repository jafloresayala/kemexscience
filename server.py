"""
PI Foundry Agent — Backend FastAPI
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Ejecutar:
    uvicorn server:app --host 0.0.0.0 --port 7860

O simplemente:
    python server.py
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncGenerator

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

load_dotenv()

import foundry_pi_agent_app as backend
from foundry_pi_agent_app import create_agent, create_project_client, run_agent_turn
from plant_health_scan import PlantHealthScanner, build_ai_prompt, _result_to_dict

# ─── App ─────────────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app_: FastAPI):
    threading.Thread(target=_init_agent, daemon=True).start()
    yield


app = FastAPI(title="PI Foundry Agent", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Global state ─────────────────────────────────────────────────────────────
_state: dict = {
    "project": None,
    "openai_client": None,
    "agent": None,
    "conversation": None,
    "ready": False,
    "error": None,
}

asset_cache = None


def _init_agent() -> None:
    import time
    max_attempts = 5
    delay = 3  # seconds between retries
    for attempt in range(max_attempts):
        try:
            project = create_project_client()
            openai_client = project.get_openai_client()
            conversation = openai_client.conversations.create()
            agent = create_agent(project)

            _state.update(
                project=project,
                openai_client=openai_client,
                conversation=conversation,
                agent=agent,
                ready=True,
                error=None,
            )
            return

        except Exception as exc:
            _state["error"] = str(exc)
            if attempt < max_attempts - 1:
                time.sleep(delay)


# ─── Modelos Pydantic ─────────────────────────────────────────────────────────
class ChatRequest(BaseModel):
    message: str


class ExecuteRequest(BaseModel):
    code: str


# ─── SSE helpers ─────────────────────────────────────────────────────────────
def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def _stream_agent(message: str) -> AsyncGenerator[str, None]:
    if not _state["ready"]:
        err = _state.get("error") or "El agente aún está inicializando, intenta en unos segundos."
        yield _sse({"type": "error", "content": err})
        yield _sse({"type": "done"})
        return

    event_queue: queue.Queue = queue.Queue()

    # Envolver tool dispatch para capturar eventos en tiempo real
    original = dict(backend.TOOL_DISPATCH)

    def wrap(fn_name: str, fn):
        def interceptor(**kwargs):
            preview = ", ".join(f"{k}={repr(v)[:60]}" for k, v in kwargs.items())
            event_queue.put({"type": "tool_call", "name": fn_name, "preview": preview})
            result = fn(**kwargs)
            event_queue.put({"type": "tool_result", "name": fn_name, "preview": result[:200]})
            return result
        return interceptor

    for name, fn in original.items():
        backend.TOOL_DISPATCH[name] = wrap(name, fn)

    result_holder: dict = {}
    done_event = threading.Event()

    def run() -> None:
        try:
            result_holder["answer"] = run_agent_turn(
                openai_client=_state["openai_client"],
                conversation_id=_state["conversation"].id,
                agent=_state["agent"],
                user_text=message,
            )
        except Exception as exc:
            result_holder["error"] = str(exc)
        finally:
            backend.TOOL_DISPATCH.update(original)
            done_event.set()

    threading.Thread(target=run, daemon=True).start()

    # Drena la cola de eventos mientras el agente trabaja
    while not done_event.is_set() or not event_queue.empty():
        try:
            event = event_queue.get(timeout=0.1)
            yield _sse(event)
        except queue.Empty:
            await asyncio.sleep(0.05)

    if "error" in result_holder:
        yield _sse({"type": "error", "content": result_holder["error"]})
    else:
        yield _sse({"type": "answer", "content": result_holder.get("answer", "")})

    yield _sse({"type": "done"})


# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.post("/api/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    return StreamingResponse(
        _stream_agent(req.message),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/status")
def status() -> dict:
    model = os.getenv("MODEL_DEPLOYMENT_NAME", "—")
    project_dir = Path(__file__).parent
    scan_files = list(project_dir.glob("health_scan_*.json"))
    return {
        "ready": _state["ready"],
        "error": _state.get("error"),
        "model": model,
        "cache": {
            "status": "ready",
            "scan_files": len(scan_files),
        },
    }


@app.get("/api/pi/children")
def pi_children(path: str = "") -> dict:
    """
    Devuelve los hijos inmediatos de un nodo AF de PI.
    Usado por el explorador interactivo del PI AF Tree en el frontend.
    """
    try:
        import json as _json
        raw = backend.pi_fetch_child_elements(path or None)
        data = _json.loads(raw.replace("... [TRUNCADO]", ""))
        children = data.get("children", [])
        return {
            "path": data.get("query_path", path),
            "count": len(children),
            "children": [
                {
                    "name": c.get("name", ""),
                    "path": c.get("path", ""),
                }
                for c in children
            ],
        }
    except Exception as exc:
        return {"path": path, "count": 0, "children": [], "error": str(exc)}


@app.get("/api/pi/attributes")
def pi_attributes(path: str) -> dict:
    """
    Devuelve los atributos (tags PI) de un elemento AF.
    Usado por el explorador interactivo del PI AF Tree en el frontend.
    """
    try:
        import json as _json
        raw = backend.pi_fetch_element_attributes(path)
        data = _json.loads(raw.replace("... [TRUNCADO]", ""))
        attrs = data.get("attributes", [])
        return {
            "path": path,
            "count": len(attrs),
            "attributes": [
                {
                    "name": a.get("attribute_name", ""),
                    "tagName": a.get("piPoint") or a.get("tag_name_for_pi_get_tag_values", ""),
                    "path": a.get("path", ""),
                    "uom": a.get("UOM", ""),
                    "currentValue": a.get("current_value"),
                }
                for a in attrs
            ],
        }
    except Exception as exc:
        return {"path": path, "count": 0, "attributes": [], "error": str(exc)}


@app.post("/api/cache/refresh")
def cache_refresh() -> dict:
    """
    Elimina todos los archivos health_scan_*.json del directorio del proyecto.
    Antes se reservó para reconstruir caché AF (nunca implementado); ahora
    limpia los archivos de resultados de escaneo.
    """
    project_dir = Path(__file__).parent
    scan_files = list(project_dir.glob("health_scan_*.json"))
    deleted = []
    errors = []
    for f in scan_files:
        try:
            f.unlink()
            deleted.append(f.name)
        except Exception as exc:
            errors.append(f"{f.name}: {exc}")
    return {
        "deleted": len(deleted),
        "files": deleted,
        "errors": errors,
    }


@app.post("/api/execute")
def execute_code(req: ExecuteRequest) -> dict:
    """
    Ejecuta un bloque de código Python en un subproceso.
    Si genera una gráfica matplotlib, la devuelve como base64.
    """
    plot_file = os.path.join(
        tempfile.gettempdir(), f"pi_agent_plot_{uuid.uuid4().hex[:8]}.png"
    )

    # Inyectar lógica de guardado de gráficas
    # matplotlib.use('Agg') evita que el servidor intente abrir una ventana GUI
    preamble = (
        "import matplotlib\nmatplotlib.use('Agg')\n"
        f"_PI_PLOT_FILE = r'{plot_file}'\n"
    )
    # Reemplazar plt.show() con savefig (sin plt.show() que bloquea en servidores sin display)
    code = req.code.replace(
        "plt.show()",
        f"plt.savefig(r'{plot_file}', bbox_inches='tight', dpi=150, facecolor='#080c14')",
    )
    # Si hay uso de plt pero sin plt.show(), guardar al final
    epilogue = (
        "\ntry:\n"
        "    import matplotlib.pyplot as _plt_auto\n"
        "    import matplotlib as _mpl_auto\n"
        "    if _mpl_auto.get_fignums() or _plt_auto.get_fignums():\n"
        f"        _plt_auto.savefig(r'{plot_file}', bbox_inches='tight', dpi=150, facecolor='#080c14')\n"
        "        _plt_auto.close('all')\n"
        "except Exception:\n"
        "    pass\n"
    )

    if "plt" in req.code and "plt.show()" not in req.code:
        full_code = preamble + code + epilogue
    else:
        full_code = preamble + code

    tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix=".py", delete=False, encoding="utf-8"
    )
    tmp.write(full_code)
    tmp.close()

    try:
        result = subprocess.run(
            [sys.executable, tmp.name],
            capture_output=True,
            text=True,
            timeout=90,
        )
        stdout = result.stdout
        stderr = result.stderr
        returncode = result.returncode
    except subprocess.TimeoutExpired:
        stdout = ""
        stderr = "Timeout: el código tardó más de 90 segundos."
        returncode = -1
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass

    plot_b64: str | None = None
    if os.path.exists(plot_file):
        with open(plot_file, "rb") as f:
            plot_b64 = base64.b64encode(f.read()).decode()
        try:
            os.unlink(plot_file)
        except Exception:
            pass

    return {
        "stdout": stdout,
        "stderr": stderr,
        "returncode": returncode,
        "plot_base64": plot_b64,
    }


# ─── Plant Health Scan endpoint (SSE) ─────────────────────────────────────────
_scan_state: dict = {"running": False, "scanner": None}


async def _stream_health_scan(plan: str = "") -> AsyncGenerator[str, None]:
    if _scan_state["running"]:
        yield _sse({"type": "error", "msg": "Ya hay un escaneo en curso."})
        yield _sse({"type": "done"})
        return

    _scan_state["running"] = True
    prog_queue: queue.Queue = queue.Queue()
    result_holder: dict = {}
    done_event = threading.Event()

    def on_progress(d: dict):
        prog_queue.put({"type": "progress", **d})

    def run_scan():
        try:
            scanner = PlantHealthScanner(
                progress_cb=on_progress,
                output_dir=str(Path(__file__).parent),
            )
            _scan_state["scanner"] = scanner
            result = scanner.run(hours=24)
            result_holder["result"] = result
            result_holder["prompt"] = build_ai_prompt(result, plan=plan)
        except Exception as exc:
            result_holder["error"] = str(exc)
        finally:
            _scan_state["running"] = False
            _scan_state["scanner"] = None
            done_event.set()

    threading.Thread(target=run_scan, daemon=True).start()

    while not done_event.is_set() or not prog_queue.empty():
        try:
            ev = prog_queue.get(timeout=0.15)
            yield _sse(ev)
        except queue.Empty:
            await asyncio.sleep(0.1)

    if "error" in result_holder:
        yield _sse({"type": "scan_error", "msg": result_holder["error"]})
    else:
        r = result_holder["result"]
        yield _sse({
            "type": "scan_done",
            "prompt": result_holder["prompt"],
            "summary": {
                "lines": r.lines_scanned,
                "machines": r.machines_scanned,
                "tags": r.tags_scanned,
                "scan_id": r.scan_id,
            },
        })

    yield _sse({"type": "done"})


class ScanRequest(BaseModel):
    plan: str = ""


@app.post("/api/health-scan")
async def health_scan(req: ScanRequest = ScanRequest()) -> StreamingResponse:
    return StreamingResponse(
        _stream_health_scan(plan=req.plan),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/health-scan/cancel")
def health_scan_cancel() -> dict:
    scanner = _scan_state.get("scanner")
    if scanner:
        scanner.cancel()
        return {"cancelled": True}
    return {"cancelled": False}


@app.get("/api/health-scan/list")
def health_scan_list() -> dict:
    """Lista todos los archivos de scan disponibles en el directorio del proyecto."""
    project_dir = Path(__file__).parent
    files = sorted(project_dir.glob("health_scan_*.json"), reverse=True)
    result = []
    for f in files[:20]:  # max 20 más recientes
        try:
            with open(f, encoding="utf-8") as fh:
                meta = json.load(fh)
            result.append({
                "scan_id": meta.get("scan_id", f.stem),
                "started_at": meta.get("started_at"),
                "finished_at": meta.get("finished_at"),
                "from_dt": meta.get("from_dt"),
                "to_dt": meta.get("to_dt"),
                "lines": meta.get("lines_scanned", 0),
                "machines": meta.get("machines_scanned", 0),
                "tags": meta.get("tags_scanned", 0),
                "file": f.name,
            })
        except Exception:
            pass
    return {"scans": result}


@app.get("/api/health-scan/table/{scan_id}")
def health_scan_table(
    scan_id: str,
    status_filter: str = "all",   # all | anomaly | ok | no_data
    line_filter: str = "",
    machine_filter: str = "",
    page: int = 1,
    page_size: int = 100,
) -> dict:
    """
    Devuelve los datos del scan como filas planas (DataFrame-style) con filtros y paginación.
    Cada fila = un tag de una máquina.
    """
    # Validar scan_id para evitar path traversal
    import re as _re
    if not _re.match(r'^[0-9_]+$', scan_id):
        from fastapi import HTTPException
        raise HTTPException(status_code=400, detail="scan_id inválido")

    project_dir = Path(__file__).parent
    scan_file = project_dir / f"health_scan_{scan_id}.json"
    if not scan_file.exists():
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Scan no encontrado")

    with open(scan_file, encoding="utf-8") as fh:
        data = json.load(fh)

    # Construir filas planas
    rows = []
    for machine in data.get("machines", []):
        for tag in machine.get("tag_details", []):
            issues = tag.get("issues", [])
            if not issues:
                row_status = "OK"
            elif issues == ["NO_DATA"]:
                row_status = "NO_DATA"
            else:
                row_status = ", ".join(i for i in issues if i != "NO_DATA")
                if "NO_DATA" in issues:
                    row_status += " + NO_DATA"

            rows.append({
                "line": machine["line_name"],
                "machine": machine["machine_name"],
                "attribute": tag.get("attribute_name") or tag.get("tag_name", ""),
                "tag": tag.get("tag_name", ""),
                "status": row_status,
                "count": tag.get("count", 0),
                "avg": tag.get("avg"),
                "min": tag.get("min"),
                "max": tag.get("max"),
                "stdev": tag.get("stdev"),
                "issue_score": machine.get("issue_score", 0),
            })

    # Filtrar
    if status_filter == "anomaly":
        rows = [r for r in rows if r["status"] not in ("OK", "NO_DATA")]
    elif status_filter == "ok":
        rows = [r for r in rows if r["status"] == "OK"]
    elif status_filter == "no_data":
        rows = [r for r in rows if r["status"] == "NO_DATA"]

    if line_filter:
        lf = line_filter.lower()
        rows = [r for r in rows if lf in r["line"].lower()]

    if machine_filter:
        mf = machine_filter.lower()
        rows = [r for r in rows if mf in r["machine"].lower()]

    # Ordenar: anomalías primero, luego por línea + máquina
    status_order = {"FLATLINE": 0, "SPIKE": 1, "FLATLINE, SPIKE": 0, "NO_DATA": 3, "OK": 4}
    rows.sort(key=lambda r: (status_order.get(r["status"], 2), r["line"], r["machine"]))

    total = len(rows)
    start = (page - 1) * page_size
    page_rows = rows[start:start + page_size]

    # Lista de líneas y máquinas únicas para los filtros del frontend
    all_lines = sorted({r["line"] for r in rows})
    all_machines = sorted({r["machine"] for r in rows})

    return {
        "scan_id": scan_id,
        "period": f"{data.get('from_dt', '')} → {data.get('to_dt', '')}",
        "total_rows": total,
        "page": page,
        "page_size": page_size,
        "pages": max(1, (total + page_size - 1) // page_size),
        "rows": page_rows,
        "filters": {
            "lines": all_lines,
            "machines": all_machines,
        },
        "summary": {
            "ok": sum(1 for r in rows if r["status"] == "OK"),
            "no_data": sum(1 for r in rows if r["status"] == "NO_DATA"),
            "anomaly": sum(1 for r in rows if r["status"] not in ("OK", "NO_DATA")),
        },
    }


# ─── Servir frontend React (build estático) ───────────────────────────────────
_dist = Path(__file__).parent / "frontend" / "dist"
if _dist.exists():
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="static")


# ─── Entry point ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=7860, reload=False)
