"""Small, local-only error metadata for Electron's shared diagnostic gateway.

No network client, source lines, frame locals, arguments or absolute paths are collected here.
"""
from __future__ import annotations


def exception_details(exc: BaseException) -> dict:
    frames = []
    tb = exc.__traceback__
    while tb is not None:
        filename = tb.tb_frame.f_code.co_filename.replace("\\", "/")
        marker = filename.rfind("/aditor/")
        relative = filename[marker + 1:] if marker >= 0 else filename if filename.startswith("aditor/") else ""
        if relative and ".." not in relative.split("/"):
            frames.append({"filename": relative, "function": tb.tb_frame.f_code.co_name[:160], "lineno": tb.tb_lineno})
        tb = tb.tb_next
    return {"type": type(exc).__name__[:100], "frames": frames[-30:]}
