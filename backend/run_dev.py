"""Dev runner: starts uvicorn with reload watching only our source files.

Avoids the shell-glob-expansion quirk on Windows where ``*.py`` and
``venv/*`` get expanded by the parent process before uvicorn's argparser
sees them. By calling ``uvicorn.run`` directly with Python list args,
the patterns stay verbatim.

Excludes ``venv/`` and ``__pycache__/`` so a PaddleOCR call that
touches a model cache or compiled extension under ``venv/`` doesn't
trigger a mid-request worker restart.
"""
import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=8000,
        reload=True,
        reload_dirs=["."],
        reload_includes=["*.py"],
        reload_excludes=[
            "venv/*",
            "**/__pycache__/*",
            "*.pyc",
            "*.dat",
            "*.log",
        ],
    )
