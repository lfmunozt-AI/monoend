# Diseño técnico — Streaming diferido con buffer (presentación, no generación)

Autor: AG01 (Arquitecto) · Fecha: 2026-07-08 · Estado: **diseño, sin implementar**.
Implementación en `feature/streaming-buffer` tras aprobación de Luis.

## Restricción arquitectónica inamovible
El guardrail de cifras (`runGuardrail`) y el validator de política
(`validateConsigliereOutput`) necesitan la respuesta **COMPLETA** antes de que el
usuario vea una sola palabra. **El streaming es de PRESENTACIÓN, no de
generación.** Queda arquitectónicamente prohibido enviar tokens del modelo al
cliente antes de que ambas capas hayan validado el texto entero.

Consecuencia directa: el *token streaming* real de OpenAI → navegador **no es una
opción**. Cualquier "streaming" que veamos es una **simulación** sobre un texto ya
validado y conocido en su totalidad. La única pregunta de diseño es **dónde** vive
esa simulación: en el servidor (Opción A) o en el cliente (Opción B).

## Estado actual (baseline)
- `src/app/api/chat/route.ts` ya **bufferiza**: genera con `callLLMWithHistory`
  (no-stream) → `runGuardrail` → `validateConsigliereOutput` → persiste →
  `NextResponse.json({ response, conversationId, tokensUsed })`. El invariante ya
  se cumple.
- `chat/page.tsx` ya tiene el andamiaje de estados: `isStreaming`,
  `consigliereState` ('thinking' | 'responding' | 'alert' | 'idle'), pero hoy
  **pinta la respuesta de golpe** al recibir el JSON.
- No existe ninguna infraestructura SSE/`ReadableStream` en la app (grep limpio).
- La "burbuja del dashboard" para mensajes proactivos **aún no existe** como
  componente (`src/components/dashboard/` solo tiene IcaCircle, MetricCard,
  PowerLeakBadge).

---

## Servidor — dos opciones

### Opción A · El servidor devuelve el texto aprobado como stream
Tras validar, el route abre un `ReadableStream` y emite el `finalContent` en
chunks (por palabra/frase) con micro-delays server-side (`await sleep(Δ)` entre
chunks). El cliente lee el stream y va pintando.

### Opción B · El servidor devuelve JSON y el cliente simula el tipeo
El route se queda **como hoy** (`NextResponse.json`). El cliente recibe el texto
completo validado y ejecuta un *typewriter* 100% en el navegador.

### Análisis comparado

| Dimensión | Opción A (stream server) | Opción B (JSON + tipeo cliente) |
|---|---|---|
| **Duración de función serverless (Vercel)** | La función **permanece abierta durante toda la presentación**: generación + ~1.5–2s de micro-delays. Se paga GB-s por hacer `sleep()` entre palabras y se retiene un slot de concurrencia. Roza `maxDuration` en respuestas largas o red lenta. | **Duración = solo generación** (idéntica a hoy): la función cierra tras validar y persistir. El tiempo de tipeo ocurre en el navegador, **coste servidor cero**. ✅ |
| **Cancelación** | El cliente aborta → hay que cablear `request.signal`/cancelación del `ReadableStream` para no seguir emitiendo. Pero el texto **ya se generó y persistió** antes de streamear, así que abortar no ahorra generación; solo corta el goteo. Más superficie de error. | El texto ya llegó y está en el cliente. Cancelar = detener un timer local (`clearTimeout`/`AbortController` de UI). **Trivial**, sin servidor de por medio. ✅ |
| **Compatibilidad con el insert en DB** | El `insert` del mensaje del asistente ocurre **antes** de abrir el stream (el texto es íntegro; no hay insert incremental). Riesgo: si el stream muere a medias, en DB queda el mensaje completo pero el usuario vio un parcial → **inconsistencia** entre lo mostrado y lo guardado. | Insert igual que hoy, antes de responder. El cliente anima sobre el texto ya persistido: lo mostrado converge siempre a lo guardado. **Sin inconsistencia posible.** ✅ |
| **Rate limit** | Cuenta `role='user'`/día; independiente de la presentación. Igual en ambas. | Igual. Empate. |
| **Primera palabra ≤1.5s tras fin de generación** | Depende de flush del primer chunk + RTT; controlable pero suma coste serverless. | El cliente empieza a tipear **al instante** de recibir el JSON (≈RTT, típ. <300ms). Control total del pacing. ✅ |
| **Error a mitad de "stream"** | Clase de error real: la función puede caerse mientras emite → parcial sin cierre limpio, difícil de recuperar. | **No existe** esa clase: el tipeo es animación sobre texto completo ya en memoria; nada puede fallar a mitad. Los únicos errores (red/HTTP) ocurren **antes** de tipear y se manejan como hoy. ✅ |
| **Complejidad / infra** | Reintroduce `ReadableStream`, framing de chunks, parsing en cliente, manejo de backpressure y abort — todo para **simular**. | Un hook + un componente de presentación. La capa de transporte queda "tonta" (JSON). ✅ |

### Recomendación: **Opción B** (tipeo simulado en el cliente sobre el JSON validado)

**Argumentos decisivos:**
1. **Coste:** A paga cómputo serverless por dormir entre palabras; B no añade ni un
   milisegundo de función. A misma UX, B es gratis y A recurrente-caro.
2. **El invariante hace inútil el streaming real:** como el texto debe estar
   completo y validado antes de mostrarse, A **no transporta nada progresivo** —
   solo gotea algo ya conocido. No hay valor de producto en que ese goteo sea
   server-authoritative.
3. **Menos superficie de fallo:** B elimina de raíz la clase "error a mitad de
   stream" y la inconsistencia mostrado-vs-persistido.
4. **Control de la métrica:** el pacing de primera-palabra y de duración total se
   ajusta en el cliente sin round-trips.

**Cuándo reconsiderar A (fuera de alcance hoy):** solo si en el futuro se
**relaja el invariante** para permitir generación progresiva real con un guardrail
**incremental** (validar por frases mientras se generan). Eso viola la restricción
actual y queda para una Fase 2 explícita, no para este diseño.

---

## Cliente — diseño de presentación

### Piezas nuevas
- **`src/hooks/useTypewriter.ts`** — hook puro de presentación. Entrada: texto
  completo + opciones; salida: `{ visible, done, skip() }`. Revela por
  palabra/grafema con micro-delays jitterados. **Pacing adaptativo**: el delay por
  palabra se escala para que la duración total ≤ ~1.8s independientemente de la
  longitud (`delay = clamp(base, min, budget / nWords)`). Respeta
  `prefers-reduced-motion` → entrega el texto completo al instante. Limpia timers
  en `unmount` y al cambiar el texto de entrada.
- **`src/components/chat/TypewriterText.tsx`** — renderiza `visible` + cursor de
  tipeo parpadeante (CSS) mientras `!done`. Sin lógica de tiempo (usa el hook).
- **`src/components/dashboard/ConsigliereBubble.tsx`** — burbuja del dashboard
  para mensajes proactivos; reutiliza `TypewriterText` + estado 'thinking' del
  personaje. Fuente del texto: endpoint/props de proactividad (ya validado en
  servidor con las mismas capas antes de llegar aquí).

### Cambios en piezas existentes
- **`src/app/(dashboard)/chat/page.tsx`**: al recibir `{ response }`, en vez de
  fijar el contenido de golpe, montar `TypewriterText` para el **último** mensaje
  del asistente. Transiciones de `consigliereState`:
  `thinking` (fetch en vuelo, generación real) → `responding` (durante el tipeo) →
  `idle` (al `done`). La detección de "fuga"/alertas ya existente se dispara al
  terminar el tipeo, no antes.
- **`src/components/chat/ChatMessage.tsx`**: aceptar prop `animate?: boolean`. Solo
  el mensaje recién llegado anima; el **historial se pinta instantáneo** (nunca
  re-animar mensajes viejos al cargar `/api/chat/history`).

### Estados del personaje
- **`thinking`** — durante la **generación real** (fetch en vuelo). Aquí vive la
  latencia de verdad; animación CSS v1 del personaje "pensando".
- **`responding`** — durante la **presentación** (tipeo); cursor visible.
- **`idle`/`alert`** — al terminar; `alert` si el texto menciona una Fuga de Poder.

### Manejo de error a mitad de stream
Con Opción B **no hay stream servidor**, así que no hay error a mitad de tipeo. Los
únicos fallos son pre-tipeo (red/HTTP 4xx/5xx/401) y se manejan como hoy: toast de
error, `consigliereState='idle'`, sin mensaje del asistente. Requisito de robustez:
el typewriter debe ser **cancelable** (un mensaje nuevo o desmontar aborta el timer
anterior para no solapar dos animaciones).

---

## Métrica objetivo y cómo se cumple
- **Primera palabra visible ≤1.5s tras el fin de la generación:** trivial en B —
  el cliente arranca el tipeo al recibir el JSON (≈RTT, típ. <300ms), muy dentro
  del presupuesto. La latencia de generación vive en el estado `thinking`, antes
  de que empiece a contar esta métrica.
- **Percepción total ≤2s:** el pacing adaptativo cierra el tipeo en ~1.5–1.8s
  para el máximo de 120 palabras del Consigliere; en respuestas cortas es aún
  menor. `prefers-reduced-motion` → instantáneo (accesibilidad por encima del
  efecto).

## Plan de implementación por archivos
| Archivo | Cambio | Nota |
|---|---|---|
| `src/app/api/chat/route.ts` | **Ninguno** | Se mantiene JSON no-stream; el invariante ya se cumple. |
| `src/hooks/useTypewriter.ts` | **Nuevo** | Hook puro; pacing adaptativo; reduced-motion; cancelable. |
| `src/components/chat/TypewriterText.tsx` | **Nuevo** | Render progresivo + cursor. |
| `src/components/chat/ChatMessage.tsx` | Editar | Prop `animate`; solo el último asistente anima. |
| `src/app/(dashboard)/chat/page.tsx` | Editar | Orquestar estados y montar `TypewriterText`. |
| `src/components/dashboard/ConsigliereBubble.tsx` | **Nuevo** | Burbuja proactiva reutilizando el typewriter. |
| `src/hooks/__tests__/useTypewriter.test.ts` | **Nuevo** | Timing adaptativo, reduced-motion, cancelación. |

## Riesgos
1. **Fugas de timer**: no limpiar en `unmount`/nuevo mensaje → animaciones
   solapadas. Mitiga: cancelación en el hook.
2. **Re-animar historial**: cargar `/api/chat/history` no debe re-tipear mensajes
   viejos. Mitiga: `animate` solo en el mensaje recién recibido.
3. **Accesibilidad**: respetar `prefers-reduced-motion` es requisito, no opción.
4. **Carrera con `localStorage`**: el typewriter lee de estado React, no del
   `saveMessages` (ver m3 de la auditoría). No acoplar presentación a persistencia.
5. **Si se eligiera A** (documentado como rechazado): `maxDuration` de Vercel,
   coste de `sleep()` serverless, cableado de `AbortSignal`, e inconsistencia
   parcial-mostrado vs completo-en-DB.

## Decisión pendiente de Luis
Confirmar **Opción B**. Tras el visto bueno, implementar en `feature/streaming-buffer`
según el plan por archivos. El route no se toca; el trabajo es de capa de presentación.
