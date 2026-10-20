"""Sondas HTTP somente leitura/sem autenticação. Não enviam mensagens nem cobranças.
Uso: python -I tests/runtime-smoke.py https://portariaprime.vercel.app
Não substitui testes autenticados de autorização ou jornada completa.
"""
import json
import sys
import urllib.error
import urllib.request

base = sys.argv[1].rstrip('/')
checks = [
    ('/api/billing/order?id=00000000-0000-4000-8000-000000000000', 401),
    ('/api/jobs/tick', 401),
]
for path, expected in checks:
    try:
        response = urllib.request.urlopen(base + path, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        assert response.code == expected, (path, response.code)
        assert 'application/json' in response.headers.get('Content-Type', ''), path
        assert 'no-store' in response.headers.get('Cache-Control', ''), path
        payload = json.loads(response.read(8192))
        assert isinstance(payload.get('error'), str), path
    print(f'PASS {path}: {expected}, JSON, no-store')
