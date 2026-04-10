# 🏎️ KardPad — Mario Kart Wii Controller

Convierte tu móvil en mando de Mario Kart Wii para **Dolphin Emulator**.

## Instalación

```bash
pip install websockets pynput
# Opcional (QR en terminal):
pip install "qrcode[pil]"
```

## Uso

```bash
cd KardPad
python server.py
```

Abre la URL que aparece en la terminal desde el navegador del móvil.
Asegúrate de que el PC y el móvil están en la **misma red Wi-Fi**.

---

## Configuración de Dolphin

En Dolphin → *Controllers* → **Wiimote 1** → *Emulated Wiimote*:

| KardPad | Wiimote (horizontal) |
|---------|----------------------|
| A (verde) | Botón A |
| B (rojo) | Botón B |
| DRIFT (L trigger) | Botón 1 |
| ITEM (R trigger) | Botón 2 |
| + (center) | Start / + |
| Shake / 💥 | Shake — lanza objetos y trucos |
| Inclinación | D-Pad (izq/der) |

Configura el perfil de teclado en Dolphin:
- **A** → `W`  · **B** → `S`  · **1** → `A`  · **2** → `D`
- **+** → `Enter`
- **Izq** → `Left`  · **Der** → `Right`
- **Shake** → `Space`

---

## Controles del mando

| Botón | Función |
|-------|---------|
| 🟢 A | Acelerar |
| 🔴 B | Frenar / marcha atrás |
| DRIFT | Power-slide (botón 1 del Wiimote) |
| ITEM | Mostrar objeto (botón 2) |
| 💥 TRUCO | Shake — lanza/recoge objetos, trucos en rampa |
| + | Pausa / confirmar en menú |
| Inclinación | Girar (modo Volante ON) |

## Puntero de menú

En los menús de Dolphin puedes activar el **Puntero** en Ajustes para mover el cursor con el dedo por la pantalla.

---

## Arquitectura

```
KardPad/
├── server.py          ← Servidor Python (HTTP + WebSocket)
├── static/
│   ├── index.html     ← Interfaz del mando (móvil)
│   ├── app.js         ← Lógica cliente: tilt, shake, botones, puntero
│   └── main.css       ← Estilos
└── requirements.txt
```

- **Puerto HTTP 3000**: sirve los archivos estáticos al móvil.
- **Puerto WS 8000**: recibe inputs en tiempo real.
- **pynput**: simula teclado y ratón en el PC → Dolphin los lee.
