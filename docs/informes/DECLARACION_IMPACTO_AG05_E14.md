# Declaración de Impacto — AG05 · enmienda E14 y estado de go-live

**Agente:** AG05 (Documentación) · **Fecha:** 2026-08-20
**Rama:** `agent/05`, desde `origin/develop` (`2f01231`)
**Contrato:** `docs/CONTRATO_TRUTH_ENGINE.md` §15.1 — la Declaración de Impacto es artefacto del
repo (E11). Este archivo la cumple.

---

## 1 · Alcance

**Entrega solo documental. Cero archivos de `src/`, `tests/`, `scripts/` o `supabase/` tocados.**

```
docs/CONTRATO_TRUTH_ENGINE.md
docs/ESTADO_ACTUAL.md
docs/informes/DECLARACION_IMPACTO_AG05_E14.md   (este archivo, nuevo)
```

Ningún test tocado: cero asertos modificados, debilitados o eliminados, cero fixtures sustituidos
(V11). Ninguna función tocada.

## 2 · Cambios en el contrato

El cuerpo (§0-§15) **no se reescribe** (regla de §16). Lo nuevo entra como sub-bloque fechado o como
enmienda; las tablas originales quedan intactas encima.

| Cambio | Naturaleza |
|---|---|
| **§9.1** — tabla canónica **V1-V21**, cada invariante con enunciado, origen y enmienda de entrada | **Añade.** La tabla original de §9 (V1-V10) se conserva, marcada como histórica, con puntero a 9.1 |
| **§15.1** — reglas de proceso añadidas por enmienda (E6, E11×2, E14), consolidadas | **Añade.** Los pasos 1-8 del 5 de agosto quedan intactos |
| **E14** — V17, V18, V19 con su origen; resolución de la colisión de numeración; regla "ningún invariante nace en un prompt" | **Añade** |
| **E12** — nota de estado: la M1 de doble conteo queda **cerrada** por V17 | **Corrige el estado**, no el texto: la enmienda se conserva íntegra y se le añade la nota fechada |

### 2.1 · Por qué E14 y no "E11"

El encargo pedía registrar los invariantes como "E11". **E11, E12 y E13 ya existen** desde el 18 de
agosto. Reutilizar el número habría creado dos enmiendas distintas con la misma etiqueta —
exactamente el defecto que esta entrega viene a cerrar, y que E7/E8 tuvieron que arreglar para
V11-V13. Se registra como **E14**, con nota de numeración visible al principio de la enmienda para
quien la busque por el número del encargo.

### 2.2 · Por qué V20/V21 y no al revés

La regla de §15.1 dice "renumera el más reciente". En esta colisión concreta se renumeran los **más
antiguos** (los de AG01, ronda 1), y la desviación se declara en la propia enmienda:

- **Luis fijó V17-V19 explícitamente** el 20 de agosto, con enunciado literal para cada uno.
- Los números **V18 y V19 de AG08 están cableados**: `src/app/api/chat/route.ts:807` cita V18 con el
  significado "M10 sensor", y los tests de las compuertas citan V19. Los de AG01 solo aparecen en
  informes de revisión.
- Renumerar el lado cableado invalidaría referencias vivas en código y batería; renumerar el otro no
  rompe nada.

La regla general queda enunciada para la próxima colisión: se mueve el número más reciente **y el
que menos referencias vivas tenga**.

## 3 · Auditoría de numeración — qué se revisó

`grep -rn "V1[0-9]\|V[1-9]\b" docs/ src/ --include="*.md" --include="*.ts"`, más lectura de los
siete informes de revisión y de los reportes Fase 4 de AG08.

| Hallazgo | Resolución |
|---|---|
| **V17** usado por AG01 (ronda 1) para "ninguna capa reintroduce una cifra eliminada"; Luis lo asigna a la regla aritmética | V17 = aritmética · el de AG01 → **V20** |
| **V18** usado por AG01 (ronda 1) para "bloque de datos verificados consistente" **y** por AG08 (rondas 4-6) para "ningún mandamiento edita prosa" | V18 = M10 sensor · el de AG01 → **V21** |
| **V19** usado solo por AG08 ("un agregado ambiguo no descarta el resto") | Sin colisión, se confirma |
| La regla aritmética no tenía número propio: los informes la citaban como "V13/V19" | Recibe **V17** |
| V1-V16 | Sin duplicados. V11 aparece extendido por E11; se refleja en 9.1 en una sola fila |

Resultado: **ningún invariante sin número, ningún número con dos significados.** Los informes
anteriores al 20 de agosto **no se reescriben** — E14 incluye la tabla de traducción para leerlos.

## 4 · Cambios en `docs/ESTADO_ACTUAL.md`

Reescrito al estado de go-live. Se retira la "hoja de ruta al piloto del 17 de agosto" (fecha
pasada, condiciones ya resueltas o reclasificadas) y la tabla de deuda del 18 de agosto, cuyo primer
punto —la M1— está cerrado por V17.

Se añade: compuertas con p95, runbook por bloques, bases separadas verificadas, deuda de dogfooding
con la distinción explícita entre lo que se acepta para la semana en solitario y lo que **bloquea a
los 10 externos** (logout y modo mantenimiento).

## 5 · Verificación de los datos publicados

Lo que aporta el encargo se registra como tal; lo verificable se verificó.

| Dato | Cómo se verificó |
|---|---|
| `develop` = `2f01231`; siete rondas de revisión con informe propio | `git log`, `ls docs/informes/` |
| `origin/agent/08` @ `475bf8e` aprobado en ronda 7 y **sin mergear** | `git branch -r --contains 475bf8e` → solo `origin/agent/08` |
| Proyecto `monoend-dev` (`elcvgbgesbnznxwcksyo`), creado el 20 de agosto | Listado de proyectos Supabase |
| Dev con 18 tablas y **RLS activo en todas** | `pg_class.relrowsecurity` + recuento de políticas |
| **Migración 023** — `anon` sin DML en ninguna tabla de usuario; solo `SELECT` en `supported_languages` | `information_schema.role_table_grants`, **en los dos entornos**: coinciden |
| Políticas aún `TO public` en `messages`, `conversations`, `goals`, `user_financial_state` | `pg_policies.roles` |
| `user_financial_state` sin GRANT para `authenticated` | `role_table_grants` — solo `service_role` |
| **022 y 023 no existen como archivo** en ningún branch | `git ls-tree` sobre `supabase/migrations/` en `develop`, `agent/01`, `agent/08`, `agent/06`, `agent/03` |
| Colisión de numeración reportada en rondas 4, 5 y 7 | Lectura de los tres informes (R4 en cada uno) |
| Origen de V18 (M10 editor) y V19 (agregado ambiguo) | `CORRECCIONES_AG08_m10_sensor_no_editor.md` §1 · `CORRECCIONES_AG08_aritmetica_decide_agregado.md` §3 |
| Riesgo de cifra incorrecta "el más bajo de la serie", sin bloqueante de piloto | `REVISION_AG01_qa_testdev10_ronda7.md` §1 y §6 |

**Aportado por Luis, no verificable desde el repo** (se publica como dato del encargo): p95 de 5,7 s
sobre gate de 8 s; G1a/G1b/G1c en verde; el 13% de respuestas francamente cálidas; el defecto de
logout con RLS ya verificado correcto; el estado de los `attempts` al abrir chat nuevo; y el cierre
de los bloques 1, 4 y 5 del runbook. Los tres últimos puntos de infraestructura sí se contrastaron
contra el esquema real (fila anterior).

## 6 · Validación

`npm run build`:

- ✅ **Compilación correcta** y **TypeScript limpio**.
- ❌ Falla después en el prerender de `/login`: `@supabase/ssr` exige URL y API key y **no hay
  `.env.local` en el worktree** (solo `.env.example`). Es **entorno, no código** — el mismo
  resultado que AG01 registra en sus rondas sobre este repo.
- El diff **no toca ningún archivo de código**, así que no puede influir en ese resultado.

Advertencia preexistente y ajena: `middleware` deprecado en Next.js 16 (asignado a AG03).

## 7 · Consecuencias para otros agentes

- **Todos** — el prompt de implementación **no inventa invariantes: cita §9.1**. Si hace falta uno
  que no está, la enmienda se escribe **antes** de que la tanda arranque (§15.1, E14).
- **AG01** — a partir de ahora hay especificación contra la que juzgar: §9.1, V1-V21. Los informes
  de las rondas 1-7 se leen con la tabla de traducción de E14 ("V17" = V20, "V18 el mío" = V21).
- **AG08 / quien haga el merge** — antes del bloque 2 del runbook: mergear `475bf8e` y **volcar las
  migraciones 022 y 023 a `supabase/migrations/`**, que hoy solo existen en la BD.
