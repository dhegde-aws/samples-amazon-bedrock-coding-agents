"""MCP server exposing cost_analyzer tools over JSON-RPC 2.0 / HTTP."""

import argparse
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.environ.get("COST_ANALYZER_DIR", os.path.dirname(os.path.abspath(__file__))))
import cost_analyzer

SERVER_INFO = {
    "name": "cost-analyzer-mcp",
    "version": "1.0.0",
}
PROTOCOL_VERSION = "2024-11-05"


def handle_initialize(params):
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "serverInfo": SERVER_INFO,
        "capabilities": {"tools": {}},
    }


def handle_tools_list(params):
    return {"tools": cost_analyzer.list_tools()}


def handle_tools_call(params):
    name = params.get("name")
    arguments = params.get("arguments") or {}

    tool_names = {t["name"] for t in cost_analyzer.list_tools()}
    if name not in tool_names:
        return None, {"code": -32601, "message": f"Unknown tool: {name!r}"}

    try:
        result = cost_analyzer.dispatch(name, arguments)
    except (ValueError, TypeError) as exc:
        return None, {"code": -32602, "message": str(exc)}

    return {"content": [{"type": "text", "text": json.dumps(result)}], "isError": False}, None


METHODS = {
    "initialize": handle_initialize,
    "tools/list": handle_tools_list,
}


class MCPHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"status": "ok", "server": SERVER_INFO}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)

        try:
            request = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            self._send_json({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
            return

        req_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}

        if method == "tools/call":
            result, error = handle_tools_call(params)
            if error:
                self._send_json({"jsonrpc": "2.0", "id": req_id, "error": error})
            else:
                self._send_json({"jsonrpc": "2.0", "id": req_id, "result": result})
            return

        handler = METHODS.get(method)
        if handler is None:
            self._send_json({"jsonrpc": "2.0", "id": req_id, "error": {"code": -32601, "message": f"Unknown method: {method!r}"}})
            return

        result = handler(params)
        self._send_json({"jsonrpc": "2.0", "id": req_id, "result": result})

    def _send_json(self, obj):
        body = json.dumps(obj).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass


def main():
    parser = argparse.ArgumentParser(description="MCP server for cost_analyzer")
    parser.add_argument("--port", type=int, default=int(os.environ.get("MCP_PORT", "9000")))
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), MCPHandler)
    print(f"MCP server listening on {args.host}:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()