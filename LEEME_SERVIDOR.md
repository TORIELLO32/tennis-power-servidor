# Servidor de salas y de compras · TENNIS POWER (E3.21 · protocolo 3, acepta el 2)

El 1 contra 1 en línea necesita este pequeño servidor. Desde la E3.18 también **verifica las compras de App Store** antes de que el juego las acredite.

No guarda partidas, cuentas, monedas ni contraseñas.

**Qué hace**

- **Salas privadas:** crea salas con un código de 5 letras y deja entrar a una sola persona más.
- **Preparación:** cada jugador elige su personaje y toca LISTO. Cuando los dos están listos, el partido empieza.
- **Partido:** revisa y reenvía los controles de uno a otro (unos 60 mensajes pequeños por segundo).
- **Resultado por consenso:** al terminar, los dos juegos mandan su final. Si coinciden, el servidor lo confirma a los dos. Si no coinciden, el partido queda **sin resultado**.
- **Reconexión:** si alguien pierde la red un momento, le guarda el lugar 20 segundos.
- **Revancha y salida:** organiza la revancha y avisa si el rival sale.
- **E3.18 · Mejoras en línea:** cada jugador manda los NIVELES (0..5) de sus mejoras de multijugador. El servidor solo acepta enteros en ese rango y se los reparte a los dos juegos en el inicio del partido; cada juego calcula los mismos multiplicadores con la misma tabla.
- **E3.18 · Compras:** `POST /iap/verify` comprueba una compra firmada por Apple (ver abajo).
- **E3.20 · Ritmo:** cada mensaje de controles puede llevar `a` = [holgura media ×10, holgura mala, retardo, ping] del juego que lo manda. El servidor solo lo reenvía si son enteros pequeños en rango; con eso el otro juego ajusta su ritmo y su retardo en pleno partido. `/health` dice `"srv":"E3.21"` desde la E3.21.
- **E3.21 · Registro permanente de compras:** `POST /iap/claim` y `POST /iap/ack` (ver abajo). Cada compra se entrega una sola vez y a un solo jugador. Necesita una base PostgreSQL (`DATABASE_URL`); sin ella verifica pero no autoriza entregas.

## Versiones (protocolo)

- **3 (E3.18):** como el 2 + niveles de mejoras en línea (`ups`) en `create`, `join`, `char` y en el inicio (`start.ups`).
- **2 (E3.17):** se sigue aceptando. El build 1.0 (2) de TestFlight entra y juega igual, siempre sin mejoras en línea.
  - El saludo conserva `proto: 2` para él y añade `protos: [2, 3]` para el nuevo.
- Dos jugadores solo comparten sala si tienen la **misma versión del juego** (el juego lo dice si no).

## Cómo funciona el partido (lockstep)

1. Los dos juegos simulan **el mismo partido**, con las mismas reglas, la misma semilla y los valores base de los personajes.
2. Solo viajan los **controles**, numerados por tick (1/60 s) y con el **número de partido**. Un mensaje de un partido anterior nunca entra en la revancha.
3. Cada control se aplica con un **retardo de entrada**. Empieza igual para los dos, calculado con el ping real (de 3 a 15 ticks, 50–250 ms). **E3.20:** durante el partido cada juego ajusta el suyo según cómo le llegan sus controles al rival (de 3 a 20 ticks).
4. **E3.20:** si un control del rival se atrasa por un tirón de la red, el juego lo **prevé** (el rival sigue haciendo lo mismo) hasta 200 ms. Cuando llega el real, vuelve a la última foto confirmada y lo re-simula: el estado final es exactamente el mismo. Si el retraso pasa de 200 ms, **espera** y avisa «Esperando a tu rival…».
5. Cada medio segundo, el invitado manda una **huella** de su estado. Si no coincide con la del anfitrión, el anfitrión le manda una **foto** del estado.
   - El invitado solo acepta fotos con la **forma exacta** de su simulador: clases de una lista fija, las mismas variables y los mismos tipos.

**Velocidad.** El partido en línea va a la misma velocidad que uno normal: 1 control y 1 tick por cuadro. Solo se pone al día tras una espera.

Esto se corrigió en E3.17. Antes, dos juegos podían empujarse uno al otro hasta ir casi al doble de velocidad.

## Qué protege y qué NO

**Lo que sí revisa el servidor:**

- Que cada jugador pertenezca a su sala y solo mande controles de su propio lado.
- La forma, el tipo, el tamaño y los rangos de cada mensaje.
- El número de partido y el orden de los ticks. Los duplicados y los atrasados se descartan, y nadie puede ir más de 90 ticks por delante del otro.
- Las transiciones válidas: sala → partido → final → revancha.
- Que el final se procese **una sola vez**.
- Los límites:
  - salas y conexiones en total, y conexiones por IP;
  - mensajes por segundo: con más de 240 se cierra la conexión;
  - códigos equivocados: 40 por IP cada 10 minutos.
- Que los códigos sean aleatorios. Son 33 millones de combinaciones, con el freno de intentos de arriba.
- La **ficha privada** de cada jugador para reconectar. Es aleatoria y nunca se le manda al rival.
- **E3.18 · Mejoras en línea:** solo se aceptan exactamente cuatro atributos con enteros 0..5.
  - Decimales, negativos, más de 5 o claves de más: se rechazan y el jugador queda sin mejoras.
  - Los multiplicadores no viajan: cada juego los calcula de la tabla. Así nadie puede mandar «velocidad ×10».

**Lo que NO es (dicho tal cual):**

- **El servidor no simula el partido.** Un juego modificado podría mandar controles «imposibles pero bien formados», y el anfitrión podría mandar una foto falsa con la forma correcta.
  - El final por consenso evita que **uno solo** imponga el resultado.
  - Pero si el anfitrión engaña al invitado con fotos falsas, los dos podrían terminar de acuerdo en un resultado falso.
  - La protección completa exige simular el partido en el servidor (Godot sin pantalla), y eso no cabe bien en el plan gratuito (0.1 CPU). Es la ruta futura si algún día el online da premios.
- **E3.18 · El servidor no puede saber si un jugador PAGÓ sus mejoras en línea**: no hay cuentas, y el progreso vive en cada teléfono.
  - Un juego modificado podría declarar niveles altos sin haberlos comprado, pero nunca más allá del máximo (5).
  - Comprobarlo exigiría cuentas y un progreso guardado en el servidor (fase futura).
- **`Origin`, el código de sala y la versión del juego no son autenticación.**
  - La cabecera `Origin` solo frena que otras páginas web usen el servidor. La app de iPhone no la manda y siempre se acepta.
  - El código de sala solo sirve para encontrar la sala.
- El online **no da** monedas, XP, premios ni progreso, y se juega con los valores base (sin mejoras compradas). Por eso esta protección se considera proporcionada para las pruebas privadas.

## Verificación de compras (E3.18) · `POST /iap/verify`

El iPhone manda `{"jws": "<transacción firmada por Apple>", "product": "<ID del producto>"}`. El servidor responde `{"verified": true|false, "reason", "product", "transactionId", "environment", "revoked"}`.

Comprueba, sin claves secretas (`verificar_compras.js`):

1. **Formato:** JWS ES256 con cadena de 3 certificados (`x5c`).
2. **Raíz:** que sea exactamente **Apple Root CA - G3**, por su huella SHA-256 `63343ABF…3E9179`, publicada por Apple en [la lista de certificados raíz](https://support.apple.com/en-am/121672).
3. **Cadena:** cada certificado firmado por el siguiente y vigente en la fecha de la transacción.
4. **Marcas de Apple:** los OID `1.2.840.113635.100.6.11.1` (hoja) y `1.2.840.113635.100.6.2.1` (intermedio).
5. **Firma** de la transacción.
6. **Contenido:**
   - app `com.eduardotoriello.tennispower`;
   - producto pedido;
   - consumible;
   - entorno `Sandbox` (TestFlight) o `Production`;
   - identificador de transacción;
   - si está **reembolsada**.

Detalles:

- **Límite:** 30 verificaciones por minuto e IP.
- **Registros:** solo «compra: verificada/rechazada (motivo)», nunca la transacción.
- **Quién acredita:** el **teléfono**, una vez por `transactionId`, y guarda la lista en su progreso. El servidor no guarda nada.
- **Pruebas:** usan una cadena **de prueba** (`pruebas/`). El servidor solo la acepta con `IAP_ALLOW_TEST_ROOT=1`, que **nunca** se pone en Render.

## Registro permanente de compras (E3.21) · `POST /iap/claim` y `POST /iap/ack`

Archivo: `registro_compras.js`. Pruebas: `node prueba_compras.js` (con `TEST_DATABASE_URL` también prueba PostgreSQL).

**Por qué:** antes solo el teléfono recordaba qué compras había entregado. Un respaldo viejo, una reinstalación u otro teléfono con el mismo Apple ID podían volver a recibir la misma compra, y nadie podía recuperar una entrega interrumpida con seguridad.

**Cómo funciona:**

1. El juego manda la transacción firmada por Apple y su **identificador de jugador** (32 letras al azar que se crean una vez y viajan dentro del progreso y del código de exportar; no hay cuenta, correo ni contraseña).
2. `/iap/claim` verifica la firma (igual que `/iap/verify`) y la **registra** en PostgreSQL a nombre de ese jugador, con su contenido fijo (tabla `PRODUCTOS`: un identificador de Apple nunca cambia de contenido). Si ya era de otro jugador, responde `otro_jugador` y no se entrega.
3. El juego suma y **guarda** su progreso. Solo entonces llama a `/iap/ack` con `entregada`.
4. Si Apple avisa un reembolso, la fila pasa a `reembolso_pendiente`; el juego retira lo que esa compra dio y confirma `reembolso_aplicado`.

**Estados:** `reclamada` → `entregada`; `reembolso_pendiente` → `reembolso_aplicado`; `reembolsada_sin_entregar`.

**Dónde se guarda:** solo en PostgreSQL (`DATABASE_URL`). El disco del plan gratis de Render se borra al reiniciar, así que ahí nunca se usa un archivo (`IAP_LEDGER_FILE` es solo para pruebas locales y Render lo rechaza). Sin base, `/iap/claim` responde 503 `registro_sin_configurar` y el teléfono deja la compra pendiente (no se pierde).

**Base gratis recomendada:** Neon (plan Free: 1 GB por proyecto y 100 horas de cómputo al mes; se duerme a los 5 minutos sin uso y despierta sola). Cada compra ocupa menos de 1 KB: miles de compras caben de sobra. Ver `GUIA_RENDER.md` → «Registro de compras».

**Juegos anteriores (builds 3 a 5):** siguen usando `/iap/verify`. Si la transacción ya está registrada a un jugador, ahora responden «no verificada» (así no la acreditan otra vez); si no está, se anota como entregada a «legado».

## Reinicios y límites del plan gratis

- Las salas viven en la **memoria** de este proceso. Debe correr **una sola instancia** (el plan gratis de Render no permite más).
- Si el servidor se reinicia o se vuelve a desplegar, las salas y partidos en curso **se pierden**. Los juegos lo detectan y dicen «el partido terminó sin resultado».
- Salas sin actividad:
  - En espera: se cierran a los 30 minutos.
  - Terminadas: a los 10 minutos.
  - Un partido sin controles durante 60 segundos termina sin resultado.
- **Render gratis** ([documentación](https://render.com/docs/free)):
  - Se **duerme tras 15 minutos** sin tráfico y tarda **~1 minuto** en despertar. El juego lo espera hasta 100 s mostrando «Despertando el servidor…», con CANCELAR.
  - 750 horas al mes y 5 GB de salida al mes.
  - **Sin tarjeta registrada, si se pasa no cobra: suspende** el servicio hasta el mes siguiente.
  - Puede reiniciarlo en cualquier momento.

## Consumo medido (pruebas en esta computadora)

| | Valor |
|---|---|
| Datos por partido | ~6 KB/s de entrada y ~6 KB/s de salida |
| Salida por hora de partido | ~21 MB (solo datos), ~47 MB con cabeceras TLS/TCP (estimado) |
| 5 GB al mes | ≈ 100–240 horas de partido |
| 20 partidos a la vez | 9 % de un núcleo de esta computadora (Render gratis da 0.1 CPU) |

**Capacidad teórica sin medir en Render:**

| Partidos simultáneos | Qué esperar |
|---|---|
| 2 | Sobra |
| 10 | Probablemente bien |
| 20 | Puede quedarse corto de CPU |

No se promete ninguna cantidad de jugadores hasta probarla en el servidor real.

**Vigilar el consumo:**

- En Render: **Dashboard → tu workspace → Billing** (ancho de banda del mes).
- Los registros (Logs) del servicio muestran cada 10 minutos una línea `resumen:` con salas, conexiones, partidos y MB enviados.
- `https://TU-SERVICIO.onrender.com/health` muestra salas, conexiones y partidos en ese momento.

## Probarlo en tu computadora

1. Instala Node.js 20 o más nuevo.
2. En la carpeta `server` ejecuta `npm install` y luego `npm start`. Debe aparecer `escuchando en 0.0.0.0:8090`.
3. Abre dos veces el juego de pruebas (Godot o la web de pruebas): usa `ws://localhost:8090` solo.

**Pruebas automáticas:** `npm test` (69 comprobaciones; E3.18 añade mejoras en línea, compatibilidad con el protocolo 2 y compras). Las pruebas del juego con este servidor real están en `tests/test_runner.gd` y se ejecutan con `--only=e317`.

`prueba_retardo.js` es **solo para pruebas**: un intermediario que añade retraso de red.

## Variables

Ver `.env.example`. No hay secretos.

| Variable | Para qué |
|---|---|
| `PORT` | Puerto (Render lo pone solo) |
| `HOST` | Interfaz de red |
| `NODE_VERSION` | Versión de Node en Render |
| `ALLOWED_ORIGINS` | Webs permitidas |
| `MAX_ROOMS`, `MAX_CONNECTIONS`, `MAX_CONN_PER_IP` | Límites |
| `RESUME_MS` | Cuánto se guarda el lugar de quien pierde la red |
| `IAP_BUNDLE_ID` | App cuyas compras se aceptan (por defecto `com.eduardotoriello.tennispower`) |
| `IAP_APP_APPLE_ID` | Opcional: número de la app; se comprueba en compras de Production |
| `IAP_PER_MIN` | Verificaciones por minuto e IP (30) |

## Despliegue

- **Render:** ver `GUIA_RENDER.md` en la entrega (paso a paso, sin tarjeta). `render.yaml` sirve como Blueprint.
- **Otros alojamientos con Docker** (Koyeb, Fly.io, un VPS): `Dockerfile`.
  - Koyeb pide tarjeta al registrarse, aunque su servicio gratuito no se cobra.

## Licencias

- `servidor_salas.js` y `prueba_*.js` son código original del proyecto.
- Usa la librería `ws` (licencia MIT), que se instala con `npm ci`.
