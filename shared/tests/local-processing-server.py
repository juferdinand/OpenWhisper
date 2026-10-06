#!/usr/bin/env python3
"""One-request owned loopback fixture. Never connect this server to a model or microphone."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
import socket
import time

parser = argparse.ArgumentParser()
parser.add_argument("--provider", choices=["lm_studio", "ollama"], default="lm_studio")
parser.add_argument("--status", type=int, default=200)
parser.add_argument("--delay", type=float, default=0)
parser.add_argument("--body-delay", type=float, default=0)
parser.add_argument("--host", choices=["127.0.0.1", "::1"], default="127.0.0.1")
parser.add_argument("--response", choices=["valid", "invalid", "oversized", "chunked-oversized"], default="valid")
args = parser.parse_args()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 100000:
            self.send_error(400)
            return
        payload = json.loads(self.rfile.read(length))
        print(json.dumps({"path": self.path, "body": payload, "authorization": self.headers.get("Authorization")}), flush=True)
        time.sleep(args.delay)
        if args.response in ["oversized", "chunked-oversized"]:
            body = b"x" * 1048577
        elif args.response == "invalid":
            body = b"private fixture server detail"
        elif args.provider == "lm_studio":
            body = json.dumps({"choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": "A structured fixture plan."}}]}).encode()
        else:
            body = json.dumps({"done": True, "done_reason": "stop", "message": {"role": "assistant", "content": "A structured fixture plan."}}).encode()
        try:
            self.send_response(args.status)
            self.send_header("Content-Type", "application/json")
            if args.response == "chunked-oversized":
                self.send_header("Transfer-Encoding", "chunked")
            else:
                self.send_header("Content-Length", str(len(body)))
            self.send_header("Location", "http://127.0.0.1:9/never-follow")
            self.end_headers()
            self.wfile.flush()
            time.sleep(args.body_delay)
            if args.response == "chunked-oversized":
                self.wfile.write(f"{len(body):x}\r\n".encode() + body + b"\r\n0\r\n\r\n")
            else:
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


class OwnedServer(HTTPServer):
    address_family = socket.AF_INET6 if args.host == "::1" else socket.AF_INET


with OwnedServer((args.host, 0), Handler) as server:
    server.timeout = 10
    print(server.server_port, flush=True)
    server.handle_request()
