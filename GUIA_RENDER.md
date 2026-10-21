# Servidor de salas en Render (gratis, sin tarjeta) · TENNIS POWER E3.17

Objetivo: que el multijugador funcione entre dos iPhones en redes distintas **sin depender de tu computadora**.

**Costo:** 0. **No registres tarjeta en Render.** Así Render no puede cobrarte: si un mes se pasara del límite gratuito, **suspende** el servicio hasta el mes siguiente, en lugar de cobrar ([Render · Deploy for Free](https://render.com/docs/free)).

## Qué vas a necesitar

- Tu cuenta de **GitHub** (TORIELLO32).
- Una cuenta gratuita de **Render** (puedes entrar con GitHub).
- La carpeta `TennisPower_E3_17_servidor` (dentro del ZIP del mismo nombre). Trae solo el servidor y no tiene contraseñas ni claves.

## Pasos

### 1. Repositorio en GitHub

1. En GitHub: **New repository**.
2. Nombre: `tennis-power-servidor`.
3. Elige **Public**. No contiene secretos y Render lo puede leer sin permisos extra.
4. Crea el repositorio y usa **uploading an existing file**.
5. Arrastra **todos los archivos** de la carpeta `TennisPower_E3_17_servidor` y confirma con **Commit changes**.

### 2. Servicio en Render

1. Crea tu cuenta en https://render.com con **GitHub** o con correo. No hace falta tarjeta.
2. **New → Web Service → Public Git Repository** y pega `https://github.com/TORIELLO32/tennis-power-servidor`.
3. Llena así:

| Campo | Valor |
|---|---|
| Name | `tennis-power-salas` |
| Region | **Ohio (US East)** (cerca de México) |
| Branch | `main` |
| Root Directory | (vacío) |
| Runtime / Language | **Node** |
| Build Command | `npm ci --omit=dev` |
| Start Command | `npm start` |
| Instance Type | **Free** |

4. En **Advanced**:
   - **Health Check Path:** `/health`
   - Variable de entorno **`NODE_VERSION`** = `22`
5. Pulsa **Create Web Service** y espera a que diga **Live**.

### 3. Comprobar

1. Abre `https://NOMBRE.onrender.com/health`. Render te da la dirección exacta arriba, en el servicio.
2. Debe mostrar algo como:
   ```
   {"ok":true,"juego":"TENNIS POWER","proto":2,...}
   ```

### 4. Poner la dirección en el juego

En `data/online.json` del proyecto:

```
"server_url_public": "wss://NOMBRE.onrender.com"
```

Usa `wss://` en lugar de `https://`. Esa dirección **no es secreta** y es la que va dentro de la app.

## Cosas del plan gratis que verás en el juego

- **Se duerme tras 15 minutos sin uso.**
  - El primero que entre a MULTIJUGADOR verá «Despertando el servidor… (puede tardar hasta 1 minuto)» con **CANCELAR**.
  - En cuanto despierta, la sala se crea sola.
- **Mientras haya un partido**, los mensajes lo mantienen despierto.
- **Límites:** 750 horas al mes y 5 GB de salida al mes.
  - Un partido gasta unos 20–50 MB por hora, así que alcanza para unas 100–240 horas de partido al mes (estimado).
- **Para revisar el consumo:**
  - En Render: **Billing** (ancho de banda) y **Logs** del servicio. Cada 10 minutos aparece una línea `resumen:`.
  - `https://NOMBRE.onrender.com/health` muestra salas, conexiones y partidos en ese momento.
- **Si Render reinicia el servicio**, los partidos en curso terminan «sin resultado» y hay que crear otra sala. Las salas no se guardan en disco.
- **No actives** más instancias, discos ni complementos: el plan gratis no los necesita, y las salas viven en una sola instancia.

## Mantenerlo

- **Actualizar el servidor:** sube los archivos nuevos al mismo repositorio. Render vuelve a desplegar solo, porque `autoDeploy` está activo.
- **Crecer después:** el plan de pago de Render evita que se duerma. Con `Dockerfile` también sirve un VPS u otro alojamiento.
- **Juego publicado:** si algún día el online da premios, conviene simular el partido en el servidor (ver `server/LEEME_SERVIDOR.md`, «Qué protege y qué NO»).
