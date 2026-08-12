"""Workflow wrangling tools for ComfyUI."""

__version__ = "0.4.0"

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

try:
    from .flow_wrangler_ai import register_routes

    register_routes()
except (ImportError, ModuleNotFoundError):
    # Direct metadata imports (including release tests) do not run inside the
    # ComfyUI package context and therefore have no PromptServer to register.
    pass

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY", "__version__"]
