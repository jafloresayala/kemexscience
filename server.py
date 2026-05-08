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

    except Exception as exc:
        _state["error"] = str(exc)


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
    return {
        "ready": _state["ready"],
        "error": _state.get("error"),
        "model": model,
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
    preamble = f"_PI_PLOT_FILE = r'{plot_file}'\n"
    code = req.code.replace(
        "plt.show()",
        f"plt.savefig(r'{plot_file}', bbox_inches='tight', dpi=150, facecolor='#080c14')\nplt.show()",
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


# ─── Servir frontend React (build estático) ───────────────────────────────────
_dist = Path(__file__).parent / "frontend" / "dist"
if _dist.exists():
    app.mount("/", StaticFiles(directory=str(_dist), html=True), name="static")


# ─── Entry point ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=7860, reload=False)
