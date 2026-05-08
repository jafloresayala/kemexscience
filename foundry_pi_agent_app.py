"""
Agente Azure AI Foundry con herramientas para consultar PI Web API.

Versión corregida:
- NO agrega api-version manualmente cuando se usa /openai/v1.
- Corrige schemas de FunctionTool con strict=True.
- Permite parámetros opcionales usando null.
- Usa tus endpoints reales de PI Web API.
- El agente decide qué herramienta usar y este script ejecuta la llamada real a la API.

Requisitos:
    pip install --upgrade azure-ai-projects azure-identity openai requests pandas python-dotenv urllib3

Archivo .env requerido en la misma carpeta:
    PROJECT_ENDPOINT=https://<tu-recurso>.services.ai.azure.com/api/projects/<tu-proyecto>
    MODEL_DEPLOYMENT_NAME=<tu-deployment-name>

Autenticación:
    az login
"""

import os
import json
import urllib3
import requests
import pandas as pd
from datetime import datetime, timedelta
from collections import defaultdict
from typing import Any

from dotenv import load_dotenv
from azure.identity import DefaultAzureCredential
from azure.ai.projects import AIProjectClient
from azure.ai.projects.models import PromptAgentDefinition, Tool, FunctionTool
from openai.types.responses.response_input_param import (
    FunctionCallOutput,
    ResponseInputParam,
)


# =========================================================
# Cargar variables de entorno
# =========================================================
load_dotenv()

# Eliminar variables de Azure SP vacías para que DefaultAzureCredential
# no las vea y no intente ClientSecretCredential con valores inválidos.
for _sp_var in ("AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"):
    if not (os.environ.get(_sp_var) or "").strip():
        os.environ.pop(_sp_var, None)


# =========================================================
# PI WEB API - valores reales
# =========================================================
BASE_URL = "https://kp.kemx.keint.com/PI_WebApi/api/Generic"

ENDPOINT_CHILDREN = f"{BASE_URL}/Fetch_Child_Elements"
ENDPOINT_ATTRIBUTES = f"{BASE_URL}/Fetch_Element_Attributes"
ENDPOINT_TAG_VALUES = f"{BASE_URL}/Fetch_Generic_Tag_Class_with_PluginName"

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


# =========================================================
# Límites de seguridad / control
# =========================================================
MAX_TAGS_PER_CALL = 20
MAX_DAYS_PER_CALL = None  # Sin límite de días
MAX_SEARCH_DEPTH = 3
MAX_RETURN_ROWS = 500
CHUNK_DAYS = 7          # Bloques internos para consultas grandes

# Archivo buffer donde se guarda el último dataset completo
_LAST_DATA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_pi_last_data.json")
MAX_TOOL_LOOPS = 5


# =========================================================
# Utilidades PI API
# =========================================================
def _post(url: str, payload: dict) -> dict | list:
    """
    Ejecuta POST contra PI Web API.
    """
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json",
    }

    if not VERIFY_SSL:
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    response = requests.post(
        url,
        headers=headers,
        json=payload,
        timeout=API_TIMEOUT,
        verify=VERIFY_SSL,
    )

    if not response.ok:
        # Intentar devolver el cuerpo del error como dict para que el agente lo procese
        try:
            body = response.json()
        except Exception:
            body = response.text[:500]
        raise RuntimeError(
            f"PI API HTTP {response.status_code}: {body}"
        )

    return response.json()


def _ensure_list(data: Any) -> list:
    """
    Normaliza respuesta de API a lista.
    """
    if isinstance(data, list):
        return data

    if isinstance(data, dict):
        return [data]

    return []


def _safe_element_path(element_path: str | None) -> str:
    """
    Restringe búsquedas al ROOT_PATH para evitar consultas fuera del árbol permitido.

    Si element_path viene null, vacío o fuera del ROOT_PATH, usa ROOT_PATH.
    """
    if not element_path:
        return ROOT_PATH

    element_path = str(element_path).strip()

    if not element_path:
        return ROOT_PATH

    if not element_path.startswith(ROOT_PATH):
        return ROOT_PATH

    return element_path


def _parse_user_datetime(value: str) -> datetime:
    """
    Acepta formatos comunes:
    - 2026-05-05T08:00:00
    - 2026-05-05 08:00:00
    - 2026-05-05T08:00
    - 2026-05-05 08:00
    - 2026-05-05
    """
    if value is None:
        raise ValueError("Fecha requerida. Usa formato YYYY-MM-DD HH:MM:SS.")

    value = str(value).strip()

    formats = [
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
    ]

    for fmt in formats:
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            pass

    raise ValueError(
        f"Fecha inválida: {value}. Usa formato YYYY-MM-DD HH:MM:SS."
    )


def _format_pi_dt(dt: datetime) -> str:
    """
    Formato esperado por el endpoint de PI: yyyyMMddHHmmss.
    """
    return dt.strftime("%Y%m%d%H%M%S")


def _json_preview(obj: Any, max_chars: int = 12000) -> str:
    """
    Devuelve JSON reducido para no saturar el contexto del modelo.
    """
    text = json.dumps(obj, ensure_ascii=False, default=str)

    if len(text) > max_chars:
        return text[:max_chars] + "... [TRUNCADO]"

    return text


# =========================================================
# Funciones que el agente puede llamar
# =========================================================
def pi_fetch_child_elements(element_path: str | None) -> str:
    """
    Obtiene los elementos hijos de una ruta AF de PI.

    :param element_path: Ruta AF dentro del ROOT_PATH permitido.
                         Si viene null, usa ROOT_PATH.
    :return: JSON con hijos encontrados.
    """
    safe_path = _safe_element_path(element_path)

    data = _post(
        ENDPOINT_CHILDREN,
        {
            "Plugin_Name": PLUGIN_NAME,
            "Element_Path": safe_path,
        },
    )

    rows = _ensure_list(data)
    normalized = []

    for item in rows:
        normalized.append(
            {
                "id": item.get("id"),
                "name": item.get("name"),
                "path": item.get("path"),
                "type": item.get("type"),
                "template": item.get("template"),
                "description": item.get("description"),
            }
        )

    return _json_preview(
        {
            "query_path": safe_path,
            "count": len(normalized),
            "children": normalized[:MAX_RETURN_ROWS],
        }
    )


def pi_fetch_element_attributes(element_path: str) -> str:
    """
    Obtiene atributos de un elemento AF de PI.

    :param element_path: Ruta AF exacta del elemento dentro del ROOT_PATH permitido.
    :return: JSON con atributos del elemento.
    """
    safe_path = _safe_element_path(element_path)

    data = _post(
        ENDPOINT_ATTRIBUTES,
        {
            "Plugin_Name": PLUGIN_NAME,
            "Element_Path": safe_path,
        },
    )

    rows = _ensure_list(data)
    normalized = []

    for item in rows:
        pi_point = item.get("piPoint") or item.get("PiPoint") or item.get("pi_point")
        normalized.append(
            {
                "attribute_name": item.get("name"),
                "tag_name_for_pi_get_tag_values": pi_point,  # usar este valor en pi_get_tag_values
                "path": item.get("path"),
                "type": item.get("type"),
                "description": item.get("description"),
                "current_value": item.get("value"),
                "lastValueDate": item.get("lastValueDate"),
                "UOM": item.get("UOM"),
                "piPoint": pi_point,
            }
        )

    # Extraer solo los tag names disponibles para facilitar al agente
    tag_names = [n["tag_name_for_pi_get_tag_values"] for n in normalized if n["tag_name_for_pi_get_tag_values"]]

    return _json_preview(
        {
            "query_path": safe_path,
            "count": len(normalized),
            "available_tag_names": tag_names,  # pasar estos directamente a pi_get_tag_values
            "attributes": normalized[:MAX_RETURN_ROWS],
        }
    )


def pi_get_tag_values(
    tag_names: list[str],
    from_datetime: str,
    to_datetime: str,
) -> str:
    """
    Obtiene valores históricos de uno o varios tags PI para un rango de fechas.
    Divide automáticamente en bloques de 7 días para rangos grandes y consolida
    todos los resultados. Guarda el dataset completo en _pi_last_data.json.

    :param tag_names: Lista de nombres de tags PI. Máximo 20 por llamada.
    :param from_datetime: Fecha inicio en formato YYYY-MM-DD HH:MM:SS.
    :param to_datetime: Fecha fin en formato YYYY-MM-DD HH:MM:SS.
    :return: JSON compacto con resumen + arrays de datos completos por tag.
    """
    if not tag_names:
        return json.dumps({"error": "Debes enviar al menos un tag."}, ensure_ascii=False)

    tag_names = [str(t).strip() for t in tag_names if str(t).strip()]
    tag_names = tag_names[:MAX_TAGS_PER_CALL]

    if not tag_names:
        return json.dumps({"error": "La lista de tags viene vacía."}, ensure_ascii=False)

    from_dt = _parse_user_datetime(from_datetime)
    to_dt   = _parse_user_datetime(to_datetime)

    if to_dt <= from_dt:
        return json.dumps({"error": "to_datetime debe ser mayor que from_datetime."}, ensure_ascii=False)

    # ── Auto-chunking: divide el rango en bloques de CHUNK_DAYS ──────────────
    tag_data: dict[str, dict] = defaultdict(lambda: {"timestamps": [], "values": []})
    chunks_fetched = 0
    chunk_errors = []
    chunk_start = from_dt

    while chunk_start < to_dt:
        chunk_end = min(chunk_start + timedelta(days=CHUNK_DAYS), to_dt)
        payload = {
            "Plugin_Name": PLUGIN_NAME,
            "From_Date": _format_pi_dt(chunk_start),
            "To_Date": _format_pi_dt(chunk_end),
            "Tag_Names": tag_names,
        }
        try:
            data = _post(ENDPOINT_TAG_VALUES, payload)
            rows = _ensure_list(data)
            for tag_obj in rows:
                tname = tag_obj.get("Tag_Name") or "unknown"
                for point in tag_obj.get("Tag_Values", []) or []:
                    ts  = point.get("TimeStamp")
                    raw = point.get("Value")
                    try:
                        val = float(raw)
                    except (TypeError, ValueError):
                        val = raw
                    tag_data[tname]["timestamps"].append(ts)
                    tag_data[tname]["values"].append(val)
            chunks_fetched += 1
        except Exception as exc:
            chunk_errors.append(str(exc))
        chunk_start = chunk_end

    total_records = sum(len(d["timestamps"]) for d in tag_data.values())

    if total_records == 0:
        return json.dumps(
            {
                "from_datetime": from_datetime,
                "to_datetime": to_datetime,
                "tags": tag_names,
                "count": 0,
                "message": "No se encontraron datos para el rango solicitado.",
                "errors": chunk_errors,
            },
            ensure_ascii=False,
        )

    # ── Guardar dataset completo en archivo buffer ────────────────────────────
    try:
        with open(_LAST_DATA_FILE, "w", encoding="utf-8") as fh:
            json.dump(
                {"from": from_datetime, "to": to_datetime, "tags": dict(tag_data)},
                fh,
                ensure_ascii=False,
                default=str,
            )
    except Exception:
        pass

    # ── Resumen por tag ───────────────────────────────────────────────────────
    summary: dict[str, dict] = {}
    for tname, d in tag_data.items():
        nums = [v for v in d["values"] if isinstance(v, (int, float))]
        summary[tname] = {
            "count": len(d["timestamps"]),
            "avg":   round(sum(nums) / len(nums), 4) if nums else None,
            "min":   round(min(nums), 4)             if nums else None,
            "max":   round(max(nums), 4)             if nums else None,
        }

    # ── Respuesta compacta al modelo ──────────────────────────────────────────
    # Incluye arrays completos en formato compacto (mucho más pequeño que lista de dicts)
    result = {
        "from_datetime": from_datetime,
        "to_datetime": to_datetime,
        "total_records": total_records,
        "chunks_fetched": chunks_fetched,
        "summary_by_tag": summary,
        "data": dict(tag_data),  # {tag: {timestamps: [...], values: [...]}}
        "data_file": "_pi_last_data.json",
        "graph_note": (
            "Para graficar usa los arrays 'timestamps' y 'values' de 'data', "
            "o carga el archivo _pi_last_data.json con: "
            "import json; d=json.load(open('_pi_last_data.json'))"
        ),
    }
    if chunk_errors:
        result["chunk_errors"] = chunk_errors

    return _json_preview(result, max_chars=80000)


def pi_search_assets(
    keyword: str,
    start_path: str | None,
    max_depth: int | None,
) -> str:
    """
    Busca elementos AF por palabra clave recorriendo hijos desde una ruta inicial.

    Usa esta función cuando el usuario no sabe la ruta exacta del activo/equipo/línea.

    :param keyword: Texto a buscar en name, path, template o description.
    :param start_path: Ruta AF inicial. Si viene null, usa ROOT_PATH.
    :param max_depth: Profundidad de búsqueda. Si viene null, usa 2. Máximo 3.
    :return: JSON con elementos que coinciden.
    """
    safe_start = _safe_element_path(start_path)

    if max_depth is None:
        max_depth = 2

    max_depth = min(int(max_depth), MAX_SEARCH_DEPTH)

    keyword_l = (keyword or "").lower().strip()

    if not keyword_l:
        return json.dumps(
            {"error": "keyword no puede estar vacío."},
            ensure_ascii=False,
        )

    visited = set()
    matches = []

    def walk(path: str, depth: int):
        if depth < 0:
            return

        if path in visited:
            return

        if len(matches) >= MAX_RETURN_ROWS:
            return

        visited.add(path)

        try:
            raw = _post(
                ENDPOINT_CHILDREN,
                {
                    "Plugin_Name": PLUGIN_NAME,
                    "Element_Path": path,
                },
            )
        except Exception as ex:
            matches.append(
                {
                    "path": path,
                    "error": str(ex),
                }
            )
            return

        for item in _ensure_list(raw):
            name = str(item.get("name") or "")
            item_path = str(item.get("path") or "")
            template = str(item.get("template") or "")
            desc = str(item.get("description") or "")

            text = " ".join(
                [
                    name,
                    item_path,
                    template,
                    desc,
                ]
            ).lower()

            if keyword_l in text:
                matches.append(
                    {
                        "name": item.get("name"),
                        "path": item.get("path"),
                        "type": item.get("type"),
                        "template": item.get("template"),
                        "description": item.get("description"),
                    }
                )

            child_path = item.get("path")

            if child_path and depth > 0:
                walk(child_path, depth - 1)

    walk(safe_start, max_depth)

    return _json_preview(
        {
            "keyword": keyword,
            "start_path": safe_start,
            "max_depth": max_depth,
            "visited_nodes": len(visited),
            "match_count": len(matches),
            "matches": matches,
        }
    )


# =========================================================
# Definición de herramientas para Foundry
# =========================================================
def build_tools() -> list[Tool]:
    """
    IMPORTANTE:
    Con strict=True, todas las propiedades declaradas deben estar en required.

    Para simular parámetros opcionales, se usa:
        "type": ["string", "null"]
    o:
        "type": ["integer", "null"]
    """
    return [
        FunctionTool(
            name="pi_fetch_child_elements",
            description=(
                "Obtiene elementos hijos de una ruta AF de PI. "
                "Útil para navegar la jerarquía de planta. "
                "Si el usuario pregunta por la ruta raíz, enviar element_path como null."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "element_path": {
                        "type": ["string", "null"],
                        "description": (
                            "Ruta AF dentro de ROOT_PATH. "
                            f"Si no se conoce, enviar null para usar ROOT_PATH: {ROOT_PATH}"
                        ),
                    }
                },
                "required": ["element_path"],
                "additionalProperties": False,
            },
            strict=True,
        ),
        FunctionTool(
            name="pi_fetch_element_attributes",
            description=(
                "Obtiene atributos de un elemento AF de PI, incluyendo configuración, "
                "UOM y piPoint si existe."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "element_path": {
                        "type": "string",
                        "description": (
                            "Ruta AF exacta del elemento dentro del ROOT_PATH permitido."
                        ),
                    }
                },
                "required": ["element_path"],
                "additionalProperties": False,
            },
            strict=True,
        ),
        FunctionTool(
            name="pi_get_tag_values",
            description=(
                "Obtiene valores históricos de tags PI en un rango de fechas. "
                "Usar para tendencias, promedios, mínimos, máximos y análisis de comportamiento."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "tag_names": {
                        "type": "array",
                        "items": {
                            "type": "string",
                        },
                        "description": "Lista de tags PI. Máximo 20 por llamada.",
                    },
                    "from_datetime": {
                        "type": "string",
                        "description": "Fecha inicio en formato YYYY-MM-DD HH:MM:SS.",
                    },
                    "to_datetime": {
                        "type": "string",
                        "description": "Fecha fin en formato YYYY-MM-DD HH:MM:SS.",
                    },
                },
                "required": [
                    "tag_names",
                    "from_datetime",
                    "to_datetime",
                ],
                "additionalProperties": False,
            },
            strict=True,
        ),
        FunctionTool(
            name="pi_search_assets",
            description=(
                "Busca activos, líneas, equipos o elementos AF por palabra clave "
                "cuando el usuario no conoce la ruta exacta."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "keyword": {
                        "type": "string",
                        "description": (
                            "Texto a buscar en nombre, ruta, plantilla o descripción."
                        ),
                    },
                    "start_path": {
                        "type": ["string", "null"],
                        "description": (
                            "Ruta inicial. Si no se conoce, enviar null para usar ROOT_PATH: "
                            f"{ROOT_PATH}"
                        ),
                    },
                    "max_depth": {
                        "type": ["integer", "null"],
                        "description": (
                            "Profundidad de búsqueda. "
                            "Si no se especifica, enviar null. Máximo 3."
                        ),
                    },
                },
                "required": [
                    "keyword",
                    "start_path",
                    "max_depth",
                ],
                "additionalProperties": False,
            },
            strict=True,
        ),
    ]


TOOL_DISPATCH = {
    "pi_fetch_child_elements": pi_fetch_child_elements,
    "pi_fetch_element_attributes": pi_fetch_element_attributes,
    "pi_get_tag_values": pi_get_tag_values,
    "pi_search_assets": pi_search_assets,
}


AGENT_INSTRUCTIONS = f"""
Eres un agente experto en datos de producción de PI System para Kimball Electronics Mexico.

Tienes acceso a herramientas para consultar PI Web API en tiempo real.

Tu raíz permitida de navegación AF es:
{ROOT_PATH}

Reglas:
1. Cuando el usuario pregunte por una máquina, línea o activo y no conozcas la ruta exacta,
   usa pi_search_assets para buscar en la API.
2. Cuando el usuario pregunte por la jerarquía raíz, usa pi_fetch_child_elements con element_path=null.
3. Para obtener los tags de un elemento, usa pi_fetch_element_attributes. La respuesta incluye
   el campo 'available_tag_names' — esos son los nombres a usar en pi_get_tag_values.
4. Flujo para obtener valores históricos de un equipo:
   a) Si no tienes la ruta exacta: usa pi_search_assets o pi_fetch_child_elements para encontrarla.
   b) Llama pi_fetch_element_attributes con esa ruta para obtener los tag names.
   c) Usa los valores de 'available_tag_names' en pi_get_tag_values con el rango de fechas.
   NUNCA inventes tag names. Sólo usa los que devuelve pi_fetch_element_attributes.
5. Cuando el usuario pregunte por valores históricos, tendencias, promedios, mínimos, máximos
   o comportamiento de tags y ya tienes el tag name, usa directamente pi_get_tag_values.
5. Si el usuario pide una gráfica, genera código Python con matplotlib usando TODOS los datos
   del campo 'data' de la respuesta de pi_get_tag_values.
   - Usa estilo oscuro: plt.style.use('dark_background').
   - Carga los datos así:
       import json
       d = json.load(open('_pi_last_data.json'))
       tag = list(d['tags'].keys())[0]   # o el tag específico
       timestamps = d['tags'][tag]['timestamps']
       values     = d['tags'][tag]['values']
   - Convierte timestamps a datetime: pd.to_datetime(timestamps)
   - NUNCA uses solo un resumen o promedios para graficar. Usa TODOS los puntos.
6. No inventes valores. Si la API no devuelve datos, dilo claramente.
7. Para rangos grandes pi_get_tag_values divide internamente en bloques de 7 días y
   consolida TODO automáticamente. Haz UNA sola llamada con el rango completo.
8. Resume los datos de forma clara: periodo, tags, promedio, mínimo, máximo, lecturas y hallazgos.
"""


# =========================================================
# Runtime del agente
# =========================================================
def _ensure_az_in_path() -> None:
    """
    En Windows, Azure CLI puede no estar en PATH si se instaló después de abrir
    la terminal de VS Code. Busca az.cmd en rutas comunes y lo agrega al PATH.
    """
    import shutil

    if shutil.which("az") or shutil.which("az.cmd"):
        return

    candidates = [
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\Microsoft SDKs\Azure\CLI2\wbin"),
        r"C:\Program Files (x86)\Microsoft SDKs\Azure\CLI2\wbin",
        r"C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin",
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft SDKs\Azure\CLI2\wbin"),
    ]

    for az_dir in candidates:
        if os.path.exists(os.path.join(az_dir, "az.cmd")):
            os.environ["PATH"] = az_dir + os.pathsep + os.environ.get("PATH", "")
            return


def create_project_client() -> AIProjectClient:
    _ensure_az_in_path()

    project_endpoint = os.getenv("PROJECT_ENDPOINT")

    if not project_endpoint:
        raise RuntimeError("Falta variable de entorno PROJECT_ENDPOINT.")

    if "/api/projects/" not in project_endpoint:
        raise RuntimeError(
            "PROJECT_ENDPOINT parece incorrecto. Debe tener la forma: "
            "https://<resource>.services.ai.azure.com/api/projects/<project-name>. "
            f"Valor actual: {project_endpoint}"
        )

    # Si el .env tiene las 3 variables de Service Principal con valores reales,
    # usa ClientSecretCredential (no requiere az login).
    # Si no, usa DefaultAzureCredential (requiere az login).
    tenant_id     = (os.getenv("AZURE_TENANT_ID")     or "").strip()
    client_id     = (os.getenv("AZURE_CLIENT_ID")     or "").strip()
    client_secret = (os.getenv("AZURE_CLIENT_SECRET") or "").strip()

    # Valida que sean GUIDs reales (36 chars con guiones), no placeholders vacíos
    import re
    _guid_re = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)
    use_sp = (
        _guid_re.match(tenant_id or "") and
        _guid_re.match(client_id or "") and
        len(client_secret) > 0
    )

    if use_sp:
        from azure.identity import ClientSecretCredential
        credential = ClientSecretCredential(
            tenant_id=tenant_id,
            client_id=client_id,
            client_secret=client_secret,
        )
    else:
        credential = DefaultAzureCredential()

    return AIProjectClient(
        endpoint=project_endpoint,
        credential=credential,
    )


def create_agent(project: AIProjectClient):
    model_name = os.getenv("MODEL_DEPLOYMENT_NAME")

    if not model_name:
        raise RuntimeError("Falta variable de entorno MODEL_DEPLOYMENT_NAME.")

    return project.agents.create_version(
        agent_name="PI-WebAPI-Agent",
        definition=PromptAgentDefinition(
            model=model_name,
            instructions=AGENT_INSTRUCTIONS,
            tools=build_tools(),
        ),
    )


def run_agent_turn(
    openai_client,
    conversation_id: str,
    agent,
    user_text: str,
) -> str:
    """
    Ejecuta una pregunta del usuario y procesa llamadas a herramientas
    hasta obtener respuesta final.
    """
    response = openai_client.responses.create(
        input=user_text,
        conversation=conversation_id,
        extra_body={
            "agent_reference": {
                "name": agent.name,
                "type": "agent_reference",
            }
        },
    )

    for _ in range(MAX_TOOL_LOOPS):
        tool_outputs: ResponseInputParam = []

        for item in response.output:
            if getattr(item, "type", None) != "function_call":
                continue

            fn_name = item.name
            call_id = item.call_id  # guardado antes del try para garantizar append

            try:
                args = json.loads(item.arguments or "{}")

                print(
                    f"\n[TOOL CALL] {fn_name}"
                    f"({json.dumps(args, ensure_ascii=False)})"
                )

                if fn_name not in TOOL_DISPATCH:
                    result = json.dumps(
                        {
                            "error": f"Herramienta no registrada: {fn_name}",
                        },
                        ensure_ascii=False,
                    )
                else:
                    result = TOOL_DISPATCH[fn_name](**args)

            except Exception as ex:
                result = json.dumps(
                    {
                        "error": str(ex),
                        "tool": fn_name,
                    },
                    ensure_ascii=False,
                )

            print(
                f"[TOOL RESULT] "
                f"{result[:1000]}"
                f"{'...' if len(result) > 1000 else ''}\n"
            )

            # SIEMPRE se agrega output para cada function_call —
            # si falta uno el API devuelve 400 "No tool output found".
            tool_outputs.append(
                FunctionCallOutput(
                    type="function_call_output",
                    call_id=call_id,
                    output=result,
                )
            )

        if not tool_outputs:
            return response.output_text

        response = openai_client.responses.create(
            input=tool_outputs,
            conversation=conversation_id,
            extra_body={
                "agent_reference": {
                    "name": agent.name,
                    "type": "agent_reference",
                }
            },
        )

    return (
        response.output_text
        or "No se pudo completar la respuesta después de varias llamadas a herramientas."
    )


def main():
    project = create_project_client()

    # IMPORTANTE:
    # No agregar default_query={"api-version": "v1"} aquí.
    # get_openai_client() ya usa la ruta /openai/v1.
    openai_client = project.get_openai_client()

    conversation = openai_client.conversations.create()
    agent = create_agent(project)

    print("Agente PI Web API listo.")
    print("Escribe una pregunta o 'salir'.")
    print("Ejemplos:")
    print("- ¿Qué hijos hay bajo la ruta raíz?")
    print("- Busca activos que contengan SPI en Plant 2")
    print("- Dame los atributos de <ruta AF>")
    print(
        "- Consulta TAG_001 de 2026-05-05 08:00:00 "
        "a 2026-05-05 12:00:00 y resume promedio mínimo y máximo"
    )

    try:
        while True:
            user_text = input("\nTú: ").strip()

            if user_text.lower() in {
                "salir",
                "exit",
                "quit",
            }:
                break

            if not user_text:
                continue

            answer = run_agent_turn(
                openai_client=openai_client,
                conversation_id=conversation.id,
                agent=agent,
                user_text=user_text,
            )

            print(f"\nAgente: {answer}")

    finally:
        # Para pruebas, se limpian recursos al salir.
        # Si quieres conservar el agente en Foundry, comenta este bloque.
        try:
            project.agents.delete_version(
                agent_name=agent.name,
                agent_version=agent.version,
            )
        except Exception:
            pass

        try:
            openai_client.conversations.delete(
                conversation_id=conversation.id,
            )
        except Exception:
            pass


if __name__ == "__main__":
    main()