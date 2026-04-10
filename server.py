#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════
#  KardPad — server.py  v1.0
#  Convierte un móvil en mando de Mario Kart para Dolphin Emulator.
#  Basado en la arquitectura de SmashPad (HTTP + WebSocket en paralelo).
#
#  Dependencias:  pip install websockets pynput
#  Opcional:      pip install qrcode pillow   (muestra QR en terminal)
# ═══════════════════════════════════════════════════════════════════════

import asyncio
import http.server
import json
import os
import socket
import threading
import time
from collections import defaultdict, deque

import websockets
from pynput import keyboard, mouse

# ───────────────────────────────────────────────────────────────────────
#  CONFIGURACIÓN DE PUERTOS Y RUTAS
# ───────────────────────────────────────────────────────────────────────

HTTP_PORT = 3000
WS_PORT   = 8000
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

# ───────────────────────────────────────────────────────────────────────
#  MAPA DE CONTROLES POR JUGADOR  (Dolphin: Wiimote horizontal)
#
#  Botones recomendados en Dolphin → Wiimote 1 (modo horizontal):
#    A → W  |  B → S  |  1 → A  |  2 → D  |  + (Start) → Enter
#    Agitar → Espacio  |  Arriba → Up  |  Abajo → Down
#    Izq → Left  |  Der → Right
# ───────────────────────────────────────────────────────────────────────

KART_KEY_MAP = {
    1: {
        "ACCELERATE": "w",                   # Botón A  — acelerar
        "BRAKE":      "s",                   # Botón B  — frenar/marcha atrás
        "DRIFT":      "a",                   # Botón 1  — drift / power-slide
        "ITEM":       "d",                   # Botón 2  — mostrar objeto
        "USE_ITEM":   keyboard.Key.space,    # Shake    — lanzar objeto / truco
        "START":      keyboard.Key.enter,    # Botón +  — pausa / confirmar
    },
    2: {
        "ACCELERATE": "i",
        "BRAKE":      "k",
        "DRIFT":      "j",
        "ITEM":       "l",
        "USE_ITEM":   keyboard.Key.tab,
        "START":      keyboard.Key.backspace,
    },
    3: {
        "ACCELERATE": keyboard.Key.up,
        "BRAKE":      keyboard.Key.down,
        "DRIFT":      keyboard.Key.left,
        "ITEM":       keyboard.Key.right,
        "USE_ITEM":   keyboard.Key.ctrl_l,
        "START":      keyboard.Key.shift_l,
    },
    4: {
        "ACCELERATE": keyboard.Key.f5,
        "BRAKE":      keyboard.Key.f6,
        "DRIFT":      keyboard.Key.f7,
        "ITEM":       keyboard.Key.f8,
        "USE_ITEM":   keyboard.Key.f9,
        "START":      keyboard.Key.f10,
    },
}

# Teclas de dirección para inclinación (compartidas entre jugadores
# porque Dolphin las separa por slot; cambiar si hay colisiones)
TILT_KEYS = {
    1: { "LEFT": keyboard.Key.left,  "RIGHT": keyboard.Key.right },
    2: { "LEFT": keyboard.Key.left,  "RIGHT": keyboard.Key.right },
    3: { "LEFT": keyboard.Key.left,  "RIGHT": keyboard.Key.right },
    4: { "LEFT": keyboard.Key.left,  "RIGHT": keyboard.Key.right },
}

# ───────────────────────────────────────────────────────────────────────
#  PARÁMETROS DE INCLINACIÓN
# ───────────────────────────────────────────────────────────────────────

TILT_DEADZONE    = 0.15   # Ignorar inclinaciones menores a este valor
TILT_THRESHOLD   = 0.28   # A partir de aquí se activa la tecla de dirección
TILT_SMOOTH_LEN  = 4      # Muestras para la media móvil

# ───────────────────────────────────────────────────────────────────────
#  PARÁMETROS DE SHAKE (sacudir = truco/objeto)
# ───────────────────────────────────────────────────────────────────────

SHAKE_DEBOUNCE_MS = 220   # Tiempo mínimo entre dos shakes consecutivos

# ───────────────────────────────────────────────────────────────────────
#  INSTANCIAS DE pynput (un solo par para todo el servidor)
# ───────────────────────────────────────────────────────────────────────

kb    = keyboard.Controller()
mouse_ctrl = mouse.Controller()

# ───────────────────────────────────────────────────────────────────────
#  ESTADO GLOBAL POR JUGADOR
# ───────────────────────────────────────────────────────────────────────

# Teclas de botones digitales activas:   active_keys[player_id] = set()
active_keys: dict[int, set] = defaultdict(set)

# Tecla de dirección activa por inclinación: "LEFT" | "RIGHT" | None
active_tilt_dir: dict[int, str | None] = defaultdict(lambda: None)

# Buffer de suavizado de inclinación:   tilt_buffer[player_id] = deque
tilt_buffer: dict[int, deque] = defaultdict(lambda: deque(maxlen=TILT_SMOOTH_LEN))

# Timestamp del último shake por jugador
last_shake_ts: dict[int, float] = defaultdict(float)

# Lock para las llamadas a pynput (no es completamente thread-safe)
pynput_lock = threading.Lock()

# ───────────────────────────────────────────────────────────────────────
#  HELPERS DE TECLADO / RATÓN (thread-safe)
# ───────────────────────────────────────────────────────────────────────

def _press(key):
    """Presiona una tecla (str o Key) de forma segura."""
    with pynput_lock:
        try:
            kb.press(key)
        except Exception as e:
            print(f"  [KB] Error al presionar {key}: {e}")

def _release(key):
    """Suelta una tecla (str o Key) de forma segura."""
    with pynput_lock:
        try:
            kb.release(key)
        except Exception as e:
            print(f"  [KB] Error al soltar {key}: {e}")

def _mouse_move(dx: float, dy: float):
    """Mueve el cursor del ratón de forma relativa (dx, dy en píxeles)."""
    with pynput_lock:
        try:
            mouse_ctrl.move(int(dx), int(dy))
        except Exception as e:
            print(f"  [MOUSE] Error al mover: {e}")

def _mouse_click(action: str):
    """Presiona o suelta el botón izquierdo del ratón."""
    with pynput_lock:
        try:
            if action == "press":
                mouse_ctrl.press(mouse.Button.left)
            else:
                mouse_ctrl.release(mouse.Button.left)
        except Exception as e:
            print(f"  [MOUSE] Error click {action}: {e}")

# ───────────────────────────────────────────────────────────────────────
#  LIBERACIÓN TOTAL DE INPUTS DE UN JUGADOR
# ───────────────────────────────────────────────────────────────────────

def _release_all(player_id: int):
    """
    Suelta todas las teclas activas del jugador: botones digitales,
    dirección por inclinación y resetea buffers.
    """
    # Botones digitales
    for key in list(active_keys[player_id]):
        _release(key)
    active_keys[player_id].clear()

    # Dirección por inclinación
    tilt_dir = active_tilt_dir[player_id]
    if tilt_dir:
        tilt_key = TILT_KEYS.get(player_id, {}).get(tilt_dir)
        if tilt_key:
            _release(tilt_key)
    active_tilt_dir[player_id] = None

    # Resetear buffers
    tilt_buffer[player_id].clear()

    print(f"  [P{player_id}] 🔓 Inputs liberados")

# ───────────────────────────────────────────────────────────────────────
#  PROCESADORES DE INPUT
# ───────────────────────────────────────────────────────────────────────

def handle_button(player_id: int, name: str, action: str):
    """Gestiona un input digital (press / release) de un botón nombrado."""
    key_map = KART_KEY_MAP.get(player_id, {})
    key = key_map.get(name)
    if key is None:
        return  # Botón no mapeado para este jugador

    if action == "press":
        if key not in active_keys[player_id]:
            active_keys[player_id].add(key)
            _press(key)
    elif action == "release":
        if key in active_keys[player_id]:
            active_keys[player_id].discard(key)
            _release(key)


def handle_tilt(player_id: int, value: float):
    """
    Gestiona la inclinación del móvil (-1.0 izq … +1.0 der).
    Aplica deadzone, media móvil y activa la tecla de dirección correcta.
    """
    # 1. Añadir al buffer de suavizado
    tilt_buffer[player_id].append(value)

    # 2. Media móvil
    buf = tilt_buffer[player_id]
    smoothed = sum(buf) / len(buf)

    # 3. Deadzone: valores pequeños → centro
    if abs(smoothed) < TILT_DEADZONE:
        smoothed = 0.0

    # 4. Determinar nueva dirección deseada
    new_dir: str | None = None
    if smoothed > TILT_THRESHOLD:
        new_dir = "RIGHT"
    elif smoothed < -TILT_THRESHOLD:
        new_dir = "LEFT"

    # 5. Comparar con la dirección activa y actualizar si cambió
    old_dir = active_tilt_dir[player_id]
    if new_dir == old_dir:
        return  # Sin cambios

    tilt_keys = TILT_KEYS.get(player_id, {})

    # Soltar la dirección anterior
    if old_dir:
        old_key = tilt_keys.get(old_dir)
        if old_key:
            _release(old_key)

    # Activar la nueva dirección
    if new_dir:
        new_key = tilt_keys.get(new_dir)
        if new_key:
            _press(new_key)

    active_tilt_dir[player_id] = new_dir


def handle_shake(player_id: int, intensity: float):
    """
    Gestiona un evento de sacudida (shake).
    Aplica debounce para evitar múltiples triggers por un solo movimiento.
    """
    now = time.time()
    elapsed_ms = (now - last_shake_ts[player_id]) * 1000

    if elapsed_ms < SHAKE_DEBOUNCE_MS:
        return  # Demasiado pronto, ignorar

    last_shake_ts[player_id] = now

    # Shake = tecla USE_ITEM (pulso corto)
    key_map = KART_KEY_MAP.get(player_id, {})
    key = key_map.get("USE_ITEM")
    if key:
        _press(key)
        # Soltar en un hilo separado para no bloquear el bucle WebSocket
        threading.Timer(0.08, _release, args=(key,)).start()
        print(f"  [P{player_id}] 💥 Shake! (intensidad {intensity:.2f})")


def handle_pointer_move(player_id: int, x: float, y: float, screen_w: int, screen_h: int):
    """
    Mueve el cursor del ratón según la posición normalizada (0-1)
    del puntero táctil (útil en los menús de Dolphin).
    """
    # Convertir coordenadas normalizadas a píxeles absolutos
    abs_x = int(x * screen_w)
    abs_y = int(y * screen_h)
    with pynput_lock:
        try:
            mouse_ctrl.position = (abs_x, abs_y)
        except Exception:
            pass

# ───────────────────────────────────────────────────────────────────────
#  DETECCIÓN DE IP LOCAL
# ───────────────────────────────────────────────────────────────────────

def get_local_ip() -> str:
    """Devuelve la IP local de la máquina (truco sin hacer conexión real)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

# ───────────────────────────────────────────────────────────────────────
#  MANEJADOR WEBSOCKET
# ───────────────────────────────────────────────────────────────────────

# Resolución de pantalla por defecto para el puntero (actualizable desde el cliente)
SCREEN_W = 1920
SCREEN_H = 1080

async def handle_connection(websocket):
    """Gestiona todo el ciclo de vida de una conexión WebSocket."""
    player_id = None
    remote = websocket.remote_address

    print(f"\n[WS] 🔌 Conexión nueva desde {remote[0]}:{remote[1]}")

    try:
        # ── Handshake: el cliente envía { "player": N } ──────────────
        raw = await asyncio.wait_for(websocket.recv(), timeout=10)
        msg = json.loads(raw)
        player_id = int(msg.get("player", 1))
        if player_id not in range(1, 5):
            player_id = 1

        await websocket.send(json.dumps({
            "status":  "connected",
            "player":  player_id,
            "mode":    "kart",
        }))
        print(f"  [P{player_id}] 🎮 Conectado ({remote[0]})")

        # ── Bucle principal ──────────────────────────────────────────
        async for raw in websocket:
            try:
                data = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                continue

            msg_type = data.get("type")

            if msg_type == "button":
                # { "type": "button", "name": "ACCELERATE", "action": "press" }
                handle_button(player_id, data.get("name", ""), data.get("action", ""))

            elif msg_type == "tilt":
                # { "type": "tilt", "axis": "roll", "value": -0.35 }
                handle_tilt(player_id, float(data.get("value", 0)))

            elif msg_type == "shake":
                # { "type": "shake", "intensity": 0.8 }
                handle_shake(player_id, float(data.get("intensity", 1.0)))

            elif msg_type == "pointer_move":
                # { "type": "pointer_move", "x": 0.5, "y": 0.3 }
                handle_pointer_move(
                    player_id,
                    float(data.get("x", 0.5)),
                    float(data.get("y", 0.5)),
                    data.get("screen_w", SCREEN_W),
                    data.get("screen_h", SCREEN_H),
                )

            elif msg_type == "pointer_click":
                # { "type": "pointer_click", "action": "press" }
                _mouse_click(data.get("action", "press"))

    except asyncio.TimeoutError:
        print(f"  [WS] ⏱ Timeout esperando handshake de {remote[0]}")
    except websockets.exceptions.ConnectionClosedOK:
        pass
    except websockets.exceptions.ConnectionClosedError as e:
        print(f"  [P{player_id}] ⚠ Conexión cerrada con error: {e}")
    except Exception as e:
        print(f"  [P{player_id}] ❌ Error inesperado: {e}")
    finally:
        if player_id is not None:
            _release_all(player_id)
            print(f"  [P{player_id}] 👋 Desconectado")

# ───────────────────────────────────────────────────────────────────────
#  SERVIDOR HTTP (archivos estáticos)
# ───────────────────────────────────────────────────────────────────────

class StaticHandler(http.server.SimpleHTTPRequestHandler):
    """Sirve los archivos de /static al navegador del móvil."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def log_message(self, format, *args):
        pass  # Silenciar logs HTTP en la terminal


def start_http_server():
    """Arranca el servidor HTTP en un hilo demonio."""
    httpd = http.server.HTTPServer(("0.0.0.0", HTTP_PORT), StaticHandler)
    print(f"[HTTP] Servidor estático en puerto {HTTP_PORT}")
    httpd.serve_forever()

# ───────────────────────────────────────────────────────────────────────
#  QR OPCIONAL EN TERMINAL
# ───────────────────────────────────────────────────────────────────────

def print_qr(url: str):
    """Imprime un QR en la terminal si qrcode está disponible."""
    try:
        import qrcode
        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.make(fit=True)
        qr.print_ascii(invert=True)
    except ImportError:
        pass  # qrcode no instalado — ignorar

# ───────────────────────────────────────────────────────────────────────
#  PUNTO DE ENTRADA
# ───────────────────────────────────────────────────────────────────────

async def main():
    local_ip = get_local_ip()
    url = f"http://{local_ip}:{HTTP_PORT}"

    print("╔══════════════════════════════════════════════╗")
    print("║          KardPad — Mario Kart Server         ║")
    print("╠══════════════════════════════════════════════╣")
    print(f"║  Mando:    {url:<34} ║")
    print(f"║  WS:       ws://{local_ip}:{WS_PORT:<27} ║")
    print("╠══════════════════════════════════════════════╣")
    print("║  1. Conecta el móvil a la misma Wi-Fi        ║")
    print("║  2. Abre la URL en el navegador del móvil    ║")
    print("║  3. Arranca Dolphin y carga Mario Kart Wii   ║")
    print("║  Ctrl+C para salir                           ║")
    print("╚══════════════════════════════════════════════╝\n")

    print_qr(url)

    # Hilo HTTP
    http_thread = threading.Thread(target=start_http_server, daemon=True)
    http_thread.start()

    # Servidor WebSocket principal
    print(f"[WS]  Escuchando en ws://0.0.0.0:{WS_PORT}\n")
    async with websockets.serve(handle_connection, "0.0.0.0", WS_PORT):
        await asyncio.Future()  # Ejecutar indefinidamente


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\n[KardPad] Servidor detenido. ¡Hasta la próxima! 🏁")
