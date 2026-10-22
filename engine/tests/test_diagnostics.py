from aditor.diagnostics import exception_details


def test_exception_details_exclude_locals_absolute_paths_and_source():
    namespace = {}
    code = compile("def fail():\n    password = 'never send this'\n    raise RuntimeError('test')\n", "C:/Users/Alice/project/engine/aditor/example.py", "exec")
    exec(code, namespace)
    try:
        namespace["fail"]()
    except RuntimeError as error:
        details = exception_details(error)
    assert details == {"type": "RuntimeError", "frames": [{"filename": "aditor/example.py", "function": "fail", "lineno": 3}]}
    assert "Alice" not in str(details)
    assert "password" not in str(details)


def test_ipc_failure_includes_a_bounded_real_python_traceback():
    import io
    import json
    from aditor.ipc import Server

    output = io.BytesIO()
    server = Server(io.BytesIO(), output)
    def fail(*args):
        raise RuntimeError("verification error")
    server._run("verification", fail, {}, None)
    response = json.loads(output.getvalue())
    assert response["type"] == "error"
    assert response["code"] == "internal"
    assert response["exception"]["type"] == "RuntimeError"
    assert any(frame["filename"] == "aditor/ipc.py" for frame in response["exception"]["frames"])
