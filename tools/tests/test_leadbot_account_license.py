import importlib.util
import json
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread
import unittest

spec = importlib.util.spec_from_file_location('leadbot', Path(__file__).parents[1]/'leadbot'/'leadbot.py')
bot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bot)

class AccountLicenseTest(unittest.TestCase):
    def test_signed_key_is_registered_at_account_api(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                requests.append((self.path,json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"registered":true}')
            def log_message(self,*args): pass
        server=HTTPServer(('127.0.0.1',0),Handler)
        thread=Thread(target=server.serve_forever,daemon=True)
        thread.start()
        try:
            bot.register_account_license({'account_api_url':f'http://127.0.0.1:{server.server_port}/account'},'signed-test-key')
            self.assertEqual(requests,[('/account/subscriptions/issued-license',{'key':'signed-test-key'})])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

if __name__=='__main__': unittest.main()
