# Estado actual — go-live

**Actualizado:** 2026-08-20 (AG05)
**Referencia de comportamiento:** `docs/CONTRATO_TRUTH_ENGINE.md` — §9.1 (tabla canónica de
invariantes V1-V21), §15.1 (reglas de proceso) y §16 Enmiendas **E1-E14**

---

## 1 · Compuertas de piloto

| Gate | Qué mide | Estado |
|---|---|---|
| **G1a** | 0 errores aritméticos del calculador | ✅ **VERDE** |
| **G1b** | 0 respuestas con cifras no trazables o que contradigan la cifra calculada | ✅ **VERDE** — cerrado con verificación independiente de AG01 (12 turnos, incluidas dos secuencias que AG08 no probó) |
| **G1c** | Reconciliación cross-turno bidireccional (T1→T2 y T2→T1) | ✅ **VERDE** |
| **p95 de latencia** | Gate de 8 s | ✅ **VERDE — 5,7 s** |
| **G2-G8** | — | ⏳ **Se miden durante el piloto**, no antes |

En la última ronda de revisión adversarial (la séptima), el riesgo de **cifra incorrecta es el más
bajo de toda la serie: AG01 no encontró ni una**. Lo que queda abierto degrada el tono, no las
cifras — y está listado abajo como deuda aceptada.

## 2 · Runbook de go-live

| # | Bloque | Estado |
|---|---|---|
| 1 | **QA con trampas** | ✅ **CERRADO** |
| 2 | **`develop` → `main`** | ⏳ **PENDIENTE** |
| 3 | **Dominio `monoend.andgcore.com`** | ⏳ **PENDIENTE** |
| 4 | **Separación de bases de datos** | ✅ **CERRADO** |
| 5 | **Auditoría RLS** | ✅ **CERRADO** |

Los dos pendientes son de despliegue, no de comportamiento: el motor ya está en `develop` y
verificado. **Nada de lo que este documento da por cerrado llega a un usuario real hasta que el
bloque 2 se ejecute.**

### Bases de datos separadas (bloque 4) — verificado contra el esquema real

| Entorno | Proyecto Supabase | Estado |
|---|---|---|
| **Producción** | `sovereign-cfo` · `jmbzjcrgxetqfkqopfgr` | 18 tablas, RLS activo en todas |
| **Desarrollo** | `monoend-dev` · `elcvgbgesbnznxwcksyo` | Las **21 migraciones** aplicadas; 18 tablas, RLS activo en todas; **permisos igualados a producción** |

**Migración 023 — revoke de `anon`:** verificado en ambos entornos el 20 de agosto. `anon` **no
tiene `SELECT`/`INSERT`/`UPDATE`/`DELETE` sobre ninguna tabla de usuario**; la única excepción es
`SELECT` sobre `supported_languages`, que es catálogo público. Los dos entornos coinciden tabla por
tabla.

Esto cierra el hallazgo que este documento abrió el 18 de agosto: la política de `messages` es
`FOR ALL TO public` y `public` incluye a `anon`, así que **el GRANT era la única barrera**. Ahora el
revoke es explícito y está aplicado, no heredado de un default.

### Auditoría RLS (bloque 5) — resultado

- **RLS activo en las 18 tablas de `public`**, en producción y en desarrollo.
- `response_telemetry` y `telemetry_alerts`: RLS activo y **cero políticas**, con `revoke all` a
  `anon` y `authenticated`. Es el cierre correcto — solo entra `service_role`. Queda escrito para
  que nadie "arregle" la ausencia de políticas añadiendo una.
- **Deuda menor, no bloqueante:** las políticas de `messages`, `conversations`, `goals` y
  `user_financial_state` siguen siendo `TO public` en vez de `TO authenticated`. Con el revoke de
  023 aplicado no hay exposición; recrearlas acotadas al rol es defensa en profundidad barata.
- **Incoherencia menor a decidir:** `user_financial_state` tiene política de `SELECT`
  (`auth.uid() = user_id`) pero el rol `authenticated` **no tiene GRANT** sobre la tabla — hoy solo
  la alcanza `service_role` desde el servidor. La política sugiere una lectura desde cliente que el
  GRANT no concede. Decidir cuál de las dos es la verdad y alinear la otra.

**Nota de proceso — las migraciones 022 y 023 no tienen archivo en el repo.** El árbol llega a
`021_user_financial_state.sql`; los cambios de permisos se aplicaron directamente en Supabase. El
esquema real y el repo dicen cosas distintas, que es la situación que el protocolo de migraciones de
`CLAUDE.md` existe para evitar — en la dirección inversa a la habitual. **Volcar 022 y 023 a
`supabase/migrations/` antes del bloque 2**, o el próximo entorno que se levante desde el repo
nacerá con los permisos viejos.

## 3 · Qué hay en `develop`

Cabeza: `2f01231` (PR #63). Siete rondas de revisión adversarial AG01↔AG08 desde el 14 de agosto,
todas con informe propio en `docs/informes/`.

| Entró | Qué cierra |
|---|---|
| Tanda 1 — spans y fronteras posicionales | V11-V13 (E2) |
| Tanda 2 — reconciliación cross-turno | **G1c** |
| Tanda 3 — doble conteo y atribución | V15, V16 parcial (E9) |
| Memoria a nivel de usuario (migración 021) | E10 — los hechos son del usuario, el diálogo de la conversación |
| **La aritmética decide el agregado** | **V17** — cierra del todo la M1 de E12, que era condición bloqueante de piloto |
| **M10 pasa de editor a sensor** | **V18** — ningún mandamiento edita prosa |
| **Un agregado ambiguo no descarta el resto** | **V19** |
| Un plazo suelto no crea crédito fantasma | Regresión de V19/V13 |

**Sin mergear:** `origin/agent/08` @ `475bf8e` (snapshot único para derivadas · sin jerga interna ·
anti-repetición de estructura propia) está **aprobado con reservas** por AG01 en la ronda 7 y
**todavía no está en `develop`**. Su reporte Fase 4
(`docs/informes/CORRECCIONES_AG08_snapshot_y_tono.md`) tampoco. Entra antes que el bloque 2.

## 4 · Piloto

1. **Una semana con datos reales de Luis** (dogfooding en solitario).
2. **Los 10 externos, después** — y no antes de cerrar los dos bloqueantes marcados abajo.

## 5 · Deuda conocida y aceptada para la semana de dogfooding

Ninguna de estas afecta a las cifras. Se aceptan **para la semana en solitario**; dos de ellas
**bloquean a los 10 externos**.

### Tono — el frente abierto real

Solo el **13% de las respuestas medidas fueron francamente cálidas**. Dos causas identificadas:

- **Jerga interna filtrándose** al texto del usuario: `"meta activa"`, `"dominio financiero"`.
- **Repetición de estructura** propia del modelo — mismas aperturas, mismo esqueleto de párrafo
  turno tras turno.

Es el número más incómodo de este documento y conviene no maquillarlo: el motor de verdad está en
verde y **la voz no**. El ADN dice que toda respuesta cierra con una propuesta concreta, la petición
del dato que falta o la confirmación de cierre; un 13% de calidez es compatible con eso y aun así
insuficiente para que alguien quiera volver mañana.

### Logout no limpia el estado del cliente — **BLOQUEA A LOS 10 EXTERNOS**

Tras cerrar sesión y entrar con otra cuenta, **se ve el chat anterior en pantalla**. **RLS
verificado correcto** (`auth.uid() = user_id`): es **caché de cliente, no fuga de datos** — el
servidor no entrega nada de la otra cuenta. En la semana en solitario es inocuo: una sola cuenta.
Con diez personas es inaceptable, y además *parece* una fuga aunque no lo sea, que a efectos de
confianza cuesta lo mismo.

### Modo mantenimiento no construido — **BLOQUEA A LOS 10 EXTERNOS**

Requisito del protocolo de incidente. Sin él, la única forma de parar un incidente con usuarios
reales dentro es apagar sin avisar.

### `attempts` del conflicto se reinician mal

Los `attempts` del ciclo de conflicto **se incrementan al abrir un chat nuevo** en vez de
conservarse: el escape a `ASSUMED` dispararía un intento antes de lo debido. **Sin impacto en las
cifras** — afecta a cuándo el sistema deja de preguntar, no a qué calcula.

### Tanda 3 (sustracción) — pendiente a propósito

La sustracción de las 12 instrucciones `nota*`/`instruccion*` de `route.ts` (§11 del contrato)
**se ejecutará con datos de telemetría reales de la semana, no a ciegas**. La tesis del §13 es que
la naturalidad mejora **quitando** instrucciones que se pelean entre sí; medirlo con tráfico real es
justamente la forma de no sustituir una corazonada por otra.

## 6 · Lo que cambió hoy en el contrato (E14)

Los invariantes **V17, V18 y V19** —la aritmética decide el agregado, ningún mandamiento edita
prosa, nunca se pierde un dato extraíble— estaban **implementados y verificados desde hacía rondas,
pero fuera del contrato**. AG01 lo reportó siete rondas seguidas. Hoy entran a §9, junto con:

- **La tabla canónica V1-V21** (§9.1): la lista única contra la que se juzga. Ningún invariante sin
  número, ningún número con dos significados.
- **La colisión resuelta:** los dos invariantes que AG01 numeró V17/V18 en la ronda 1 pasan a
  **V20** y **V21**, porque los V18/V19 de AG08 ya están citados en el código y en la batería.
- **La regla que evita la próxima:** *ningún invariante nace en un prompt* (§15.1). Si una tanda
  necesita uno nuevo, entra al contrato en el mismo ciclo. El coste de no tenerla ya está pagado —
  una tanda completa perdida porque una instrucción de prompt quedó obsoleta frente al contrato y el
  agente ejecutó la versión vieja.
