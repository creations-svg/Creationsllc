# Radar Bursátil USA — guía rápida

Aplicación web en español para analizar, simular y seguir operaciones en acciones y ETF de EE. UU. desde Colombia (pensada para usarla junto con eToro).

> Herramienta de análisis y seguimiento. **No es asesoría de inversión** y **no ejecuta órdenes reales**.

## 1. Ponerla en marcha (modo demostración)

Requisitos: Node.js 18 o superior. No hay dependencias que instalar.

```bash
cd radar-bursatil
npm start          # http://localhost:3000
npm test           # 20 pruebas: lógica y API de extremo a extremo
```

Sin claves configuradas, la app funciona en **modo demostración**: cotizaciones e historial sintéticos, marcados como «Simulada (demo)» y con un aviso visible. Si se abre `public/index.html` sin servidor, todo corre en el navegador y los datos se guardan solo en ese dispositivo.

## 2. Activar datos reales

Configura las claves como **variables de entorno del servidor**. Nunca llegan al navegador.

| Variable | Para qué | Dónde obtenerla |
|---|---|---|
| `FINNHUB_API_KEY` | Cotizaciones, fechas de resultados | finnhub.io (plan gratuito) |
| `ALPHAVANTAGE_API_KEY` | Historial diario **ajustado** (simulador y radar) | alphavantage.co (la serie ajustada puede requerir un plan de pago) |

Cada cotización se etiqueta según su antigüedad: **Tiempo real** (≤ 2 min con el mercado abierto), **Retrasada**, **De cierre**, **Simulada** o **Manual**. Una cotización simulada nunca cambia el estado de una operación real.

La tasa USD/COP se toma de open.er-api.com como referencia. También puedes fijarla a mano en Ajustes. eToro aplica su propia tasa y su comisión de conversión, así que los valores en COP son informativos.

## 3. Activar notificaciones

La bandeja de la app y las notificaciones del navegador (con la app abierta) funcionan sin configuración. Para recibir avisos en el celular con la app cerrada, activa uno o más canales del servidor:

| Variables | Canal |
|---|---|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram: crea un bot con @BotFather y obtén tu chat id |
| `NTFY_TOPIC` (opcional `NTFY_SERVER`) | Push con la app ntfy: suscríbete al mismo tema, usa un nombre difícil de adivinar |
| `NOTIFY_WEBHOOK_URL` | POST JSON `{title, body, type, ticker, createdAt, key}`: conéctalo a Zapier, Make o n8n para correo o WhatsApp |

En **Ajustes → Enviar notificación de prueba** puedes comprobar los canales. Cada notificación guarda por qué canales salió, su estado y la hora de envío.

**Horario.** El radar se envía a las 8:00 a. m. hora de Colombia (se puede cambiar) y solo en días hábiles de NYSE: el calendario incluye festivos, Viernes Santo y cierres anticipados. Cada alerta tiene una clave única (`radar:AAAA-MM-DD`, `objetivo:<posición>`, `perdida:<posición>`), así que nunca se envía dos veces. Si el servidor estuvo apagado a las 8:00, la envía dentro de los 60 minutos siguientes.

**Vigilancia de posiciones.** Durante el horario extendido (4:00–20:00 hora de NY), el servidor revisa las posiciones abiertas cada `QUOTE_POLL_MINUTES` minutos (5 por defecto).

**Despliegue.** El servidor debe estar encendido para enviar alertas. Sirve cualquier servicio que ejecute Node con disco persistente (Render, Railway, Fly.io, un VPS). Configura `DATA_DIR` hacia el volumen persistente y sirve la app por HTTPS.

## 4. Cómo se usa la estrategia del +10 %

1. **Radar** (8:00 a. m.): hasta 3 acciones que cumplen tus filtros, con zona de entrada, objetivo, riesgo principal, próximos resultados y enlaces a las fuentes.
2. **Operaciones → Ficha de eToro**: registra el precio promedio real («Open rate»), el capital o el número de acciones y las comisiones. La app te muestra el **Take Profit** que debes poner en eToro:
   - bruto = entrada × 1,10 (compra a USD 200 → USD 220)
   - neto = precio necesario para ganar el 10 % después de las comisiones que ingresaste
3. Cuando el precio toca el objetivo, recibes una alerta y la operación pasa a **«Objetivo alcanzado»**. **Sigue abierta.**
4. Cuando la venta se ejecute en eToro, pulsa **«Registrar venta ejecutada»** e ingresa el precio real. Solo entonces queda **«Cerrada»**, se detienen sus alertas y el resultado del historial usa ese precio.

En **Práctica** (Simulador) el cierre es automático al tocar el objetivo, al precio objetivo, para probar la estrategia con capital virtual.

## 5. Simulador histórico: supuestos

- Velas diarias con precios ajustados por splits y dividendos.
- La señal se calcula al cierre y la compra se hace en la apertura siguiente, más el deslizamiento.
- El objetivo se trata como orden límite: si la vela abre por encima, se vende al precio objetivo, sin suponer una mejora.
- Pérdida con gap: se vende a la apertura.
- **Vela ambigua** (toca objetivo y pérdida el mismo día): se asume la pérdida primero y la operación se marca.
- Comisiones fija + % en cada orden. La peor caída se mide sobre el valor diario del portafolio.

## 6. Ejecución real

Está **desactivada y bloqueada**: el servidor la fuerza a `false` y la API no permite marcar un cierre como «integración». Para habilitarla haría falta una integración oficial del bróker (OAuth y API autorizada) y tu autorización expresa en cada operación. Esta versión no la incluye.

## 7. Datos por usuario

Cada dispositivo genera un identificador y el servidor guarda sus posiciones, preferencias e historial en `data/users/<id>.json`. Antes de exponer el servidor a Internet, ponlo detrás de un inicio de sesión (por ejemplo, un proxy con autenticación) o añade cuentas de usuario: el identificador por sí solo no es una contraseña.
