# PI Web API + Azure AI Foundry Agent

Este paquete incluye:

- `foundry_pi_agent_app.py`: aplicación Python que crea un agente en Azure AI Foundry con herramientas para consultar tu PI Web API en tiempo real.
- `fabric_pi_lakehouse_notebook.py`: código para Microsoft Fabric Notebook que guarda los datos como tablas Delta en Lakehouse.
- `requirements.txt`: dependencias.
- `.env.example`: variables de entorno.

## Ejecutar agente local

```bash
pip install -r requirements.txt
az login
cp .env.example .env
python foundry_pi_agent_app.py
```

El agente no llama la API "mágicamente" desde el portal: Foundry decide qué función usar, y esta aplicación Python ejecuta la llamada HTTP y regresa el resultado al modelo.
