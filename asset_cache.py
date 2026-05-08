"""
PI Asset Cache
~~~~~~~~~~~~~~
Crawlea el árbol AF de PI en segundo plano al arrancar el servidor.
Permite al agente buscar activos al instante sin llamar a la API cada vez.
"""
from __future__ import annotations

import json
import threading
from datetime import datetime
from typing import Any

import requests
import urllib3

# ─── Config (mismos valores que foundry_pi_agent_app.py) ─────────────────────
BASE_URL = "https://kp.kemx.keint.com/PI_WebApi/api/Generic"
ENDPOINT_CHILDREN = f"{BASE_URL}/Fetch_Child_Elements"
ENDPOINT_ATTRIBUTES = f"{BASE_URL}/Fetch_Element_Attributes"
PLUGIN_NAME = "MBBP Data Fetch"
ROOT_PATH = (
    r"\\NTS5120\Kimball BD Produccion"
    r"\Kimball Electronics Mexico"
    r"\Production"
    r"\SMT"
    r"\Plant 2"
)
VERIFY_SSL = False
API_TIMEOUT = 30

MAX_CACHE_NODES = 3000   # Máximo de nodos a cachear
CACHE_DEPTH = 3          # Profundidad del crawl
ATTR_DEPTH = 1           # Nivel a partir del cual se obtienen atributos


def _post(url: str, payload: dict) -> Any:
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    resp = requests.post(
        url, headers=headers, json=payload, timeout=API_TIMEOUT, verify=VERIFY_SSL
    )
    resp.raise_for_status()
    return resp.json()


class AssetCache:
    """
    Cache en memoria del árbol AF de PI.
    Thread-safe: build() corre en background, search_tool() puede llamarse en cualquier momento.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._elements: list[dict] = []
        self._attributes: dict[str, list[dict]] = {}   # path → [atributos]
        self._status: str = "not_started"
        self._built_at: datetime | None = None
        self._nodes_visited: int = 0

    # ── Status ────────────────────────────────────────────────────────────────

    def status(self) -> dict:
        with self._lock:
            return {
                "status": self._status,
                "elements": len(self._elements),
                "nodes_visited": self._nodes_visited,
                "built_at": self._built_at.isoformat() if self._built_at else None,
            }

    # ── Build (background) ────────────────────────────────────────────────────

    def build(self) -> None:
        """Crawlea el árbol AF desde ROOT_PATH y construye el índice en memoria."""
        with self._lock:
            self._status = "building"
            self._elements = []
            self._attributes = {}
            self._nodes_visited = 0

        elements: list[dict] = []
        attributes: dict[str, list[dict]] = {}
        visited: set[str] = set()

        def walk(path: str, depth: int) -> None:
            if depth < 0 or path in visited or len(elements) >= MAX_CACHE_NODES:
                return
            visited.add(path)

            try:
                raw = _post(
                    ENDPOINT_CHILDREN,
                    {"Plugin_Name": PLUGIN_NAME, "Element_Path": path},
                )
            except Exception:
                return

            if isinstance(raw, dict):
                raw = [raw]
            if not isinstance(raw, list):
                return

            for item in raw:
                el = {
                    "name": item.get("name") or "",
                    "path": item.get("path") or "",
                    "type": item.get("type") or "",
                    "template": item.get("template") or "",
                    "description": item.get("description") or "",
                }
                elements.append(el)

                item_path = el["path"]

                # Obtener atributos para nodos cercanos a las hojas
                if depth <= ATTR_DEPTH and item_path:
                    try:
                        attrs_raw = _post(
                            ENDPOINT_ATTRIBUTES,
                            {"Plugin_Name": PLUGIN_NAME, "Element_Path": item_path},
                        )
                        if isinstance(attrs_raw, dict):
                            attrs_raw = [attrs_raw]
                        if isinstance(attrs_raw, list):
                            attributes[item_path] = [
                                {
                                    "name": a.get("name") or "",
                                    "value": a.get("value"),
                                    "UOM": a.get("UOM") or "",
                                    "piPoint": a.get("piPoint") or "",
                                    "description": a.get("description") or "",
                                }
                                for a in attrs_raw
                                if a.get("name")
                            ]
                    except Exception:
                        pass

                if item_path and depth > 0:
                    walk(item_path, depth - 1)

        try:
            walk(ROOT_PATH, CACHE_DEPTH)
            with self._lock:
                self._elements = elements
                self._attributes = attributes
                self._nodes_visited = len(visited)
                self._built_at = datetime.now()
                self._status = "ready"
        except Exception as exc:
            with self._lock:
                self._status = f"error: {exc}"

    # ── Search tool (callable por el agente) ──────────────────────────────────

    def search_tool(self, keyword: str) -> str:
        """
        Busca activos en el cache local por palabra clave. Instantáneo.
        Devuelve nombre, ruta, template y atributos encontrados.
        """
        with self._lock:
            status = self._status
            elements = list(self._elements)
            attributes = dict(self._attributes)

        if status != "ready":
            return json.dumps(
                {
                    "warning": f"Cache en estado '{status}'. Resultados parciales.",
                    "matches": [],
                },
                ensure_ascii=False,
            )

        kw = (keyword or "").lower().strip()
        if not kw:
            return json.dumps({"error": "keyword no puede estar vacío."}, ensure_ascii=False)

        matches: list[dict] = []
        for el in elements:
            haystack = " ".join(
                [el["name"], el["path"], el["template"], el["description"]]
            ).lower()
            if kw in haystack:
                attrs = attributes.get(el["path"], [])
                matches.append(
                    {
                        "name": el["name"],
                        "path": el["path"],
                        "type": el["type"],
                        "template": el["template"],
                        "description": el["description"],
                        "attributes": attrs[:20],  # máximo 20 atributos por elemento
                    }
                )
            if len(matches) >= 60:
                break

        return json.dumps(
            {
                "keyword": keyword,
                "match_count": len(matches),
                "cache_total_elements": len(elements),
                "matches": matches,
            },
            ensure_ascii=False,
            default=str,
        )

    # ── Summary for agent context ─────────────────────────────────────────────

    def get_compact_summary(self, max_items: int = 400) -> str:
        """
        Resumen compacto de todos los elementos cacheados.
        Útil para inyectar en el system prompt del agente.
        """
        with self._lock:
            elements = list(self._elements[:max_items])
            attributes = dict(self._attributes)

        if not elements:
            return "(cache vacío)"

        lines: list[str] = []
        for el in elements:
            attrs = attributes.get(el["path"], [])
            attr_names = [a["name"] for a in attrs if a.get("name")]
            line = f"• {el['name']} | {el['path']}"
            if attr_names:
                line += f" | attrs: {', '.join(attr_names[:10])}"
            lines.append(line)

        return "\n".join(lines)
