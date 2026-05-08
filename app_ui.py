"""
PI Foundry Agent — Interfaz Hacker TUI
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
Requiere:
    pip install -r requirements.txt

Ejecutar:
    python app_ui.py
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.reactive import reactive
from textual.widgets import Footer, Input, RichLog, Static
from textual import on, work
from rich.text import Text


# ─── Code block detector ──────────────────────────────────────────────────────
CODE_BLOCK_RE = re.compile(r"```(?:python|py)\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)


# ─── ASCII Banner ─────────────────────────────────────────────────────────────
BANNER = [
    r"  ██╗  ██╗███████╗███╗   ███╗███████╗██╗  ██╗",
    r"  ██║ ██╔╝██╔════╝████╗ ████║██╔════╝╚██╗██╔╝",
    r"  █████╔╝ █████╗  ██╔████╔██║█████╗   ╚███╔╝ ",
    r"  ██╔═██╗ ██╔══╝  ██║╚██╔╝██║██╔══╝   ██╔██╗ ",
    r"  ██║  ██╗███████╗██║ ╚═╝ ██║███████╗██╔╝ ██╗",
    r"  ╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝",
    r"  ███████╗ ██████╗██╗███████╗███╗   ██╗ ██████╗███████╗",
    r"  ██╔════╝██╔════╝██║██╔════╝████╗  ██║██╔════╝██╔════╝",
    r"  ███████╗██║     ██║█████╗  ██╔██╗ ██║██║     █████╗  ",
    r"  ╚════██║██║     ██║██╔══╝  ██║╚██╗██║██║     ██╔══╝  ",
    r"  ███████║╚██████╗██║███████╗██║ ╚████║╚██████╗███████╗",
    r"  ╚══════╝ ╚═════╝╚═╝╚══════╝╚═╝  ╚═══╝ ╚═════╝╚══════╝",
    r"     PI Web API  ·  Azure AI Foundry  ·  v1.0  ·  Powered by · JA",
]

# ─── Textual CSS ──────────────────────────────────────────────────────────────
APP_CSS = """
Screen {
    background: #080c14;
    color: #c9d1d9;
}

/* ── Top status bar ───────────────────────────────────── */
#status-bar {
    dock: top;
    height: 1;
    background: #0d1117;
    color: #00ff41;
    padding: 0 2;
}

/* ── Main split ───────────────────────────────────────── */
#main {
    height: 1fr;
    width: 100%;
}

/* ── Chat panel (left 2/3) ────────────────────────────── */
#chat-panel {
    width: 2fr;
    background: #080c14;
    border-right: tall #1a2030;
}

#chat-log {
    height: 1fr;
    padding: 0 2;
    background: #080c14;
    scrollbar-color: #1a3020 #080c14;
    scrollbar-background: #080c14;
    scrollbar-background-hover: #080c14;
    scrollbar-color-hover: #00ff41;
}

/* ── Tool panel (right 1/3) ───────────────────────────── */
#tool-panel {
    width: 1fr;
    background: #0b0f18;
}

#tool-header {
    height: 1;
    background: #0f1521;
    color: #00c8ff;
    padding: 0 2;
    text-style: bold;
}

#tool-log {
    height: 1fr;
    padding: 0 1;
    background: #0b0f18;
    scrollbar-color: #102030 #0b0f18;
    scrollbar-background: #0b0f18;
    scrollbar-color-hover: #00c8ff;
}

/* ── Input row (bottom) ───────────────────────────────── */
#input-row {
    dock: bottom;
    height: 3;
    background: #0d1117;
    border-top: tall #1a2030;
    align: left middle;
}

#prompt-glyph {
    width: 6;
    color: #00ff41;
    text-style: bold;
    content-align: left middle;
    padding: 0 1;
    height: 3;
}

#user-input {
    width: 1fr;
    background: #0d1117;
    color: #e6edf3;
    border: none;
    height: 1;
    padding: 0 0;
}

#user-input:focus {
    border: none;
    background: #0d1117;
}

Input.-invalid {
    border: none;
}

/* ── Footer ───────────────────────────────────────────── */
Footer {
    background: #0d1117;
    color: #3d4f5c;
}

Footer > FooterKey {
    color: #00ff41;
    background: #0d1117;
}

Footer > FooterKey .footer-key--key {
    background: #1a3020;
    color: #00ff41;
}
"""


# ─── App ──────────────────────────────────────────────────────────────────────
class PIAgentTUI(App):
    """PI Web API Foundry Agent — Hacker Terminal UI."""

    CSS = APP_CSS

    BINDINGS = [
        Binding("ctrl+c", "quit", "Salir", priority=True),
        Binding("ctrl+l", "clear", "Limpiar"),
        Binding("ctrl+e", "execute_code", "Ejecutar código"),
        Binding("escape", "quit", "Salir"),
    ]

    is_ready: reactive[bool] = reactive(False)
    is_busy: reactive[bool] = reactive(False)

    # ── Widget shortcuts ───────────────────────────────────────────────────────

    @property
    def chat(self) -> RichLog:
        return self.query_one("#chat-log", RichLog)

    @property
    def tools(self) -> RichLog:
        return self.query_one("#tool-log", RichLog)

    @property
    def status_bar(self) -> Static:
        return self.query_one("#status-bar", Static)

    @property
    def user_input(self) -> Input:
        return self.query_one("#user-input", Input)

    # ── Layout ─────────────────────────────────────────────────────────────────

    def compose(self) -> ComposeResult:
        yield Static("", id="status-bar")

        with Horizontal(id="main"):
            with Vertical(id="chat-panel"):
                yield RichLog(id="chat-log", highlight=True, markup=True, wrap=True)
            with Vertical(id="tool-panel"):
                yield Static("◈  TOOL ACTIVITY", id="tool-header")
                yield RichLog(id="tool-log", highlight=True, markup=True, wrap=True)

        with Horizontal(id="input-row"):
            yield Static("  ❯", id="prompt-glyph")
            yield Input(placeholder="Escribe tu pregunta aquí…", id="user-input")

        yield Footer()

    # ── Startup ────────────────────────────────────────────────────────────────

    def on_mount(self) -> None:
        self._set_status("INICIANDO", "yellow")
        self._write_banner()
        self.initialize_agent()

    def _write_banner(self) -> None:
        self.chat.write("")
        for line in BANNER:
            self.chat.write(Text(line, style="bold bright_green"))
        self.chat.write("")
        self.chat.write(
            Text.assemble(
                ("  ◈ ", "bold cyan"),
                ("Conectando con Azure AI Foundry…\n", "white"),
            )
        )

    # ── Status bar ─────────────────────────────────────────────────────────────

    def _set_status(self, label: str, color: str = "bright_green") -> None:
        model = os.getenv("MODEL_DEPLOYMENT_NAME", "—")
        conv = getattr(self, "_conversation", None)
        conv_id = (conv.id[:18] + "…") if conv else "—"
        self.status_bar.update(
            f"  ⬡ PI FOUNDRY AGENT"
            f"  │  [{color}]■ {label}[/{color}]"
            f"  │  [dim]MODELO[/dim] [cyan]{model}[/cyan]"
            f"  │  [dim]SESSION[/dim] [cyan]{conv_id}[/cyan]"
        )

    # ── Agent initialization ───────────────────────────────────────────────────

    @work(thread=True)
    def initialize_agent(self) -> None:
        from foundry_pi_agent_app import create_project_client, create_agent

        try:
            self._project = create_project_client()
            self._openai_client = self._project.get_openai_client()
            self._conversation = self._openai_client.conversations.create()
            self._agent = create_agent(self._project)
            self.call_from_thread(self._agent_ready)
        except Exception as exc:
            self.call_from_thread(self._agent_error, str(exc))

    def _agent_ready(self) -> None:
        self.is_ready = True
        self._set_status("CONECTADO")
        self.chat.write(
            Text.assemble(
                ("  ◈ ", "bold cyan"),
                ("Agente listo. Puedes empezar a consultar.\n", "bright_green"),
            )
        )
        self.chat.write(Text("  Ejemplos:", style="dim"))
        self.chat.write(Text("  • ¿Enumera las lineas de producción?", style="dim white"))
        self.chat.write(Text("  • Dame los TAGS mas importantes de la Paste Printer en Linea 1 Left", style="dim white"))
        self.chat.write(
            Text("  • Grafica los datos de la Paste Printer en Linea 1 Left del mes de mayo 2026", style="dim white")
        )
        self.chat.write(Text(""))
        self.user_input.focus()

    def _agent_error(self, error: str) -> None:
        self._set_status("ERROR DE CONEXIÓN", "red")
        self.chat.write(
            Text.assemble(
                ("\n  ✖ ERROR: ", "bold red"),
                (error[:300] + "\n", "red"),
            )
        )

        is_auth_error = any(
            kw in error
            for kw in ("DefaultAzureCredential", "token", "credential", "401", "403", "AADSTS")
        )

        if is_auth_error:
            self.chat.write(Text("\n  DIAGNÓSTICO DE AUTENTICACIÓN", style="bold yellow"))
            self.chat.write(Text("  ─────────────────────────────────────────────────────", style="dim"))
            self.chat.write(Text("  Opción A — Azure CLI (recomendado):", style="bold cyan"))
            self.chat.write(Text("    1. Abre una terminal nueva", style="white"))
            self.chat.write(Text("    2. Ejecuta:  az login", style="bright_green"))
            self.chat.write(Text("    3. Cierra esta app y vuelve a abrirla\n", style="white"))
            self.chat.write(Text("  Opción B — Service Principal (sin az login):", style="bold cyan"))
            self.chat.write(Text("    Agrega estas 3 variables a tu .env:", style="white"))
            self.chat.write(Text("    AZURE_TENANT_ID=<tu-tenant-id>", style="bright_green"))
            self.chat.write(Text("    AZURE_CLIENT_ID=<app-registration-client-id>", style="bright_green"))
            self.chat.write(Text("    AZURE_CLIENT_SECRET=<client-secret-value>\n", style="bright_green"))
            self.chat.write(Text("  ¿No tienes el Service Principal?", style="dim"))
            self.chat.write(Text("  Pide a tu admin de Azure que ejecute:", style="dim white"))
            self.chat.write(
                Text("  az ad sp create-for-rbac --name PI-Foundry-Agent --role contributor", style="dim bright_green")
            )
        else:
            self.chat.write(Text("  Verifica:", style="dim"))
            self.chat.write(
                Text("  • Archivo .env con PROJECT_ENDPOINT y MODEL_DEPLOYMENT_NAME", style="dim white")
            )
            self.chat.write(Text("  • az login ejecutado antes de iniciar la app", style="dim white"))
        self.chat.write(Text(""))

    # ── Input handling ─────────────────────────────────────────────────────────

    @on(Input.Submitted, "#user-input")
    def on_submit(self, event: Input.Submitted) -> None:
        text = event.value.strip()
        event.input.value = ""

        if not text:
            return

        if text.lower() in ("salir", "exit", "quit"):
            self.action_quit()
            return

        if not self.is_ready:
            self._sys_msg("Conectando, espera un momento…", "yellow")
            return

        if self.is_busy:
            self._sys_msg("El agente ya está procesando. Espera la respuesta.", "yellow")
            return

        ts = datetime.now().strftime("%H:%M:%S")
        self.chat.write(
            Text.assemble(
                (f"\n  [{ts}] ", "dim"),
                ("TÚ  ▶  ", "bold cyan"),
                (text + "\n", "bright_white"),
            )
        )

        self.is_busy = True
        self._set_status("PENSANDO…", "yellow")
        self.user_input.disabled = True
        self.query_agent(text)

    # ── Agent query (background thread) ───────────────────────────────────────

    @work(thread=True)
    def query_agent(self, user_text: str) -> None:
        import foundry_pi_agent_app as backend
        from foundry_pi_agent_app import run_agent_turn

        # Intercept tool calls to show activity in the right panel
        original = dict(backend.TOOL_DISPATCH)

        def wrap(fn_name: str, fn):
            def interceptor(**kwargs):
                preview = ", ".join(
                    f"{k}={repr(v)[:40]}" for k, v in kwargs.items()
                )
                self.call_from_thread(self._log_tool_call, fn_name, preview)
                result = fn(**kwargs)
                self.call_from_thread(self._log_tool_result, fn_name, result)
                return result

            return interceptor

        for name, fn in original.items():
            backend.TOOL_DISPATCH[name] = wrap(name, fn)

        try:
            answer = run_agent_turn(
                openai_client=self._openai_client,
                conversation_id=self._conversation.id,
                agent=self._agent,
                user_text=user_text,
            )
        except Exception as exc:
            answer = f"[ERROR] {exc}"
        finally:
            backend.TOOL_DISPATCH.update(original)

        self.call_from_thread(self._show_response, answer)

    # ── Tool activity panel ────────────────────────────────────────────────────

    def _log_tool_call(self, fn_name: str, preview: str) -> None:
        ts = datetime.now().strftime("%H:%M:%S")
        self.tools.write(
            Text.assemble(
                (f"[{ts}] ", "dim"),
                ("⚡ ", "bold yellow"),
                (fn_name + "\n", "yellow"),
            )
        )
        if preview:
            self.tools.write(Text("   " + preview[:72], style="dim"))

    def _log_tool_result(self, fn_name: str, result: str) -> None:
        ts = datetime.now().strftime("%H:%M:%S")
        preview = result[:90].replace("\n", " ")
        self.tools.write(
            Text.assemble(
                (f"[{ts}] ", "dim"),
                ("✓ ", "bold bright_green"),
                (fn_name + "\n", "green"),
            )
        )
        self.tools.write(Text("   " + preview + "…\n", style="dim"))

    # ── Response rendering ─────────────────────────────────────────────────────

    def _show_response(self, answer: str) -> None:
        ts = datetime.now().strftime("%H:%M:%S")
        self.chat.write(
            Text.assemble(
                (f"  [{ts}] ", "dim"),
                ("AGENTE  ◀  ", "bold bright_green"),
            )
        )

        # Render text + styled code blocks
        last_end = 0
        code_blocks: list[str] = []

        for match in CODE_BLOCK_RE.finditer(answer):
            # Text before this block
            for line in answer[last_end:match.start()].split("\n"):
                self.chat.write(Text("  " + line, style="white"))
            # Code block
            code = match.group(1)
            code_blocks.append(code)
            self.chat.write(Text("  ┌─ python " + "─" * 45, style="bold yellow"))
            for line in code.split("\n"):
                self.chat.write(Text("  │  " + line, style="cyan"))
            self.chat.write(Text("  └" + "─" * 55, style="bold yellow"))
            last_end = match.end()

        # Remaining text after last block
        for line in answer[last_end:].split("\n"):
            self.chat.write(Text("  " + line, style="white"))

        # If code detected, store and show execution hint
        if code_blocks:
            self._pending_code = code_blocks[-1]
            self.chat.write(
                Text.assemble(
                    ("\n  ◈ ", "bold yellow"),
                    ("Código Python detectado → ", "yellow"),
                    ("Ctrl+E", "bold bright_yellow"),
                    (" para ejecutar y graficar\n", "yellow"),
                )
            )

        self.chat.write(Text(""))
        self.is_busy = False
        self._set_status("CONECTADO")
        self.user_input.disabled = False
        self.user_input.focus()

    # ── Code execution ─────────────────────────────────────────────────────────

    def action_execute_code(self) -> None:
        code = getattr(self, "_pending_code", None)
        if not code:
            self._sys_msg("No hay código Python pendiente. Pide al agente que genere uno.", "yellow")
            return
        if self.is_busy:
            self._sys_msg("Espera a que termine la operación actual.", "yellow")
            return

        ts = datetime.now().strftime("%H:%M:%S")
        self.tools.write(
            Text.assemble(
                (f"\n[{ts}] ", "dim"),
                ("▶  EJECUTANDO CÓDIGO PYTHON\n", "bold yellow"),
            )
        )
        self.chat.write(
            Text.assemble(
                ("  ◈ ", "bold yellow"),
                ("Ejecutando código…\n", "yellow"),
            )
        )
        self._run_python_code(code)

    @work(thread=True)
    def _run_python_code(self, code: str) -> None:
        plot_file = os.path.join(tempfile.gettempdir(), "pi_agent_plot.png")

        # Remove old plot if exists
        if os.path.exists(plot_file):
            try:
                os.remove(plot_file)
            except Exception:
                pass

        # Inject plot-save logic around plt.show() / at the end
        preamble = f"_PI_PLOT_FILE = r'{plot_file}'\n"
        epilogue = (
            "\ntry:\n"
            "    import matplotlib.pyplot as _plt_auto\n"
            "    import matplotlib as _mpl_auto\n"
            "    if _mpl_auto.get_fignums() or _plt_auto.get_fignums():\n"
            "        _plt_auto.savefig(_PI_PLOT_FILE, bbox_inches='tight', dpi=150)\n"
            "        _plt_auto.show()\n"
            "except Exception:\n"
            "    pass\n"
        )

        modified = code.replace(
            "plt.show()",
            "plt.savefig(_PI_PLOT_FILE, bbox_inches='tight', dpi=150)\nplt.show()",
        )
        full_code = preamble + modified
        if "plt" in code and "plt.show()" not in code:
            full_code += epilogue

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
            stdout = result.stdout.strip()
            stderr = result.stderr.strip()
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

        plot_exists = os.path.exists(plot_file)
        self.call_from_thread(
            self._show_code_result,
            stdout,
            stderr,
            returncode,
            plot_file if plot_exists else None,
        )

    def _show_code_result(
        self,
        stdout: str,
        stderr: str,
        returncode: int,
        plot_file: str | None,
    ) -> None:
        ts = datetime.now().strftime("%H:%M:%S")

        if returncode == 0:
            self.tools.write(
                Text.assemble(
                    (f"[{ts}] ", "dim"),
                    ("✓  EJECUCIÓN OK\n", "bold bright_green"),
                )
            )
        else:
            self.tools.write(
                Text.assemble(
                    (f"[{ts}] ", "dim"),
                    (f"✖  ERROR (código {returncode})\n", "bold red"),
                )
            )

        if stdout:
            self.tools.write(Text("  OUTPUT:", style="dim yellow"))
            for line in stdout.split("\n")[:20]:
                self.tools.write(Text("  " + line, style="white"))

        if stderr and returncode != 0:
            self.tools.write(Text("  STDERR:", style="dim red"))
            for line in stderr.split("\n")[:15]:
                self.tools.write(Text("  " + line, style="red"))

        self.tools.write(Text(""))

        if plot_file:
            self.chat.write(
                Text.assemble(
                    ("  ◈ ", "bold bright_green"),
                    ("Gráfica generada → abriendo imagen…\n", "bright_green"),
                )
            )
            self.chat.write(Text(f"  {plot_file}", style="dim"))
            try:
                os.startfile(plot_file)  # type: ignore[attr-defined]
            except Exception as exc:
                self.chat.write(Text(f"  No se pudo abrir: {exc}", style="red"))
        elif returncode == 0:
            self.chat.write(
                Text.assemble(
                    ("  ◈ ", "bold bright_green"),
                    ("Código ejecutado. Resultado en el panel derecho.\n", "bright_green"),
                )
            )
        else:
            self.chat.write(
                Text.assemble(
                    ("  ✖ ", "bold red"),
                    ("El código terminó con error. Ver detalle en panel derecho.\n", "red"),
                )
            )

    # ── System message helper ──────────────────────────────────────────────────

    def _sys_msg(self, msg: str, color: str = "cyan") -> None:
        self.chat.write(
            Text.assemble(
                ("  ◈ ", "bold " + color),
                (msg + "\n", color),
            )
        )

    # ── Actions ────────────────────────────────────────────────────────────────

    def action_clear(self) -> None:
        self.chat.clear()
        self.tools.clear()
        self._sys_msg("Pantalla limpiada.", "dim")

    def action_quit(self) -> None:
        self._cleanup()
        self.exit()

    def _cleanup(self) -> None:
        agent = getattr(self, "_agent", None)
        project = getattr(self, "_project", None)
        openai_client = getattr(self, "_openai_client", None)
        conversation = getattr(self, "_conversation", None)

        if agent and project:
            try:
                project.agents.delete_version(
                    agent_name=agent.name,
                    agent_version=agent.version,
                )
            except Exception:
                pass

        if conversation and openai_client:
            try:
                openai_client.conversations.delete(
                    conversation_id=conversation.id,
                )
            except Exception:
                pass


# ─── Entry point ──────────────────────────────────────────────────────────────
if __name__ == "__main__":
    PIAgentTUI().run()
