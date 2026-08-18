# Declaración de Impacto — AG05 · enmiendas E11-E13 + estado actual

**Agente:** AG05 (Documentación) · **Fecha:** 2026-08-18
**Rama:** `agent/05`, desde `origin/develop` (`358c729`)
**Contrato:** `docs/CONTRATO_TRUTH_ENGINE.md` §15 pasos 3 y 8, con la regla que esta misma
entrega añade en **E11** — la Declaración de Impacto es artefacto del repo, no mensaje de commit.
Este archivo la cumple sobre sí misma.

---

## 1 · Alcance

**Entrega solo documental. Cero archivos de `src/`, `tests/`, `scripts/` o `supabase/` tocados.**

```
docs/CONTRATO_TRUTH_ENGINE.md
docs/ESTADO_ACTUAL.md
docs/informes/DECLARACION_IMPACTO_AG05_E11_E13.md   (este archivo, nuevo)
```

Ninguna función existente se tocó, ninguna se eliminó, **ningún test se tocó**: no hay asertos
modificados, debilitados ni eliminados, ni fixtures sustituidos (E11).

## 2 · Qué cambió en `docs/CONTRATO_TRUTH_ENGINE.md`

El cuerpo (§0-§15) **no se reescribió**, según la regla de §16. Todo entra por enmienda o por nota
de referencia fechada.

| Cambio | Naturaleza |
|---|---|
| **E11** (nueva) — §15 y §9: eliminar, debilitar o cambiar el aserto de un test exige justificación explícita en la Declaración de Impacto. Registro de las **cinco** ocurrencias de la serie, cada una con su informe. Regla de soporte: la Declaración de Impacto es artefacto en `docs/informes/` | **Añade.** Extiende V11 (E2), no lo sustituye: V11 seguía cubriendo solo la inversión del aserto |
| **E12** (nueva) — §12: la M1 de doble conteo con palabra intermedia, con su alcance real medido (3 de 4 fraseos fallan, 2 `COMPLETE`), causa, solución acordada (invertir la regla) y estatus de **condición bloqueante de piloto, no de merge** | **Añade y corrige alcance.** Sustituye en este punto la formulación de E9, que registraba dos fraseos y ya arreglados. E9 queda como está — el contrato es histórico |
| **E13** (nueva) — §10: casos **28-32** de la matriz de aceptación | **Añade.** La numeración continúa desde el 27 (E9/E10); no se renumera ningún caso existente |
| **E2** — nota de referencia con la serie completa de informes `REVISION_AG01_*` y dónde vive cada uno | **Corrige una referencia.** El texto y el motivo de E2 quedan intactos; la cita original al informe de tanda 1 sigue siendo correcta y se conserva |
| **E6** — nota de referencia con las dos revisiones posteriores y qué añade cada una al motivo de E6 | **Corrige una referencia.** Igual que arriba: se añade contexto, no se altera la enmienda |

**Los informes no se movieron ni se reescribieron.** `REVISION_AG01_qa_testdev8.md` y
`REVISION_AG01_qa_testdev8_ronda2.md` siguen donde AG01 los dejó, en `origin/agent/01` (`704f907`
y `e029734`), y el contrato los cita **con su rama** hasta que se mergeen.

## 3 · Qué cambió en `docs/ESTADO_ACTUAL.md`

Reescrito al estado del 18 de agosto. Lo que se **retira** del documento anterior y por qué:

- La hoja de ruta "al piloto (17 de agosto)" pasa a ser una **tabla de estado por condición**: la
  fecha ya pasó y presentarla como plan futuro sería falso. De las siete condiciones, **una está
  cerrada** (memoria de usuario).
- "Migraciones ejecutadas hasta `020`" → **hasta `021`**, verificado contra el esquema real de
  Supabase (proyecto `sovereign-cfo`), no contra el árbol de archivos.
- La deuda "memoria de usuario (E10): diseño pendiente" se retira: **está implementada** (021, PR
  #55/#56).
- La nota de proceso sobre la reconstrucción de `CLAUDE.md` (julio) se retira por antigüedad; su
  contenido sigue en el historial y en las ramas `backup/ag05-*`.

**Se añade:** estado de `main` (22 de julio, 76 commits detrás), los cuatro bloques de
infraestructura, y el hallazgo de RLS.

## 4 · Verificación de los datos publicados

Nada de este documento ni del estado actual se copió de otro informe sin comprobarlo.

| Dato | Cómo se verificó |
|---|---|
| `develop` = `358c729`; `main` = `713eb59` (22 jul); 76 commits de diferencia | `git log`, `git rev-list --count origin/main..origin/develop` |
| 120 archivos / ~21.300 líneas entre `main` y `develop`; `main` llega a la migración `010` | `git diff --stat origin/main origin/develop`, `git ls-tree origin/main supabase/migrations/` |
| Migraciones 001-021 **ejecutadas** en Supabase | Consulta al esquema real: existen `response_telemetry` con las columnas de 019 y 020, `telemetry_alerts` y `user_financial_state` |
| RLS activo en las 18 tablas de `public` | `pg_class.relrowsecurity` + recuento de políticas por tabla |
| Política de `messages` `TO public` (alcanza a `anon`) y `anon` sin GRANT de DML | `pg_policies.roles` + `information_schema.role_table_grants` |
| `user_financial_state` con política de `SELECT` y sin GRANT para `authenticated` | misma consulta de GRANTs |
| Los cinco casos de E11, con su informe | Lectura de los informes citados, uno por uno |
| Cifras de la M1 (3 de 4 fraseos, 2 `COMPLETE`) | `REVISION_AG01_qa_testdev8_ronda2.md` §5, medición de AG01 sobre los tres árboles |

## 5 · Validación

`npm run build`:

- ✅ **Compilación correcta** (Turbopack, 2.4 s) y **TypeScript limpio** (3.8 s).
- ❌ Falla después en el prerender de `/login`: `@supabase/ssr` exige URL y API key y **no hay
  `.env.local` en el worktree** (solo `.env.example`). Es **entorno, no código** — el mismo
  resultado que AG01 registró en sus dos rondas sobre este mismo repo.
- El diff de esta entrega **no toca ningún archivo de código**, así que no puede influir en ese
  resultado.

Advertencia preexistente sin relación con esta entrega: `middleware` deprecado en Next.js 16
(asignado a AG03 en `CLAUDE.md`).

## 6 · Consecuencias para otros agentes

- **AG08** — E12 fija la solución acordada de la M1: **invertir la regla** (cifra + `:` + lista de
  ≥2 partidas con importe propio ⇒ agregado), no enumerar conectores. Con batería de ≥10 fraseos.
  El caso **28** de la matriz es su criterio de aceptación. Pendiente además la condición de merge
  de AG01: ampliar `ANAFORA_SIN_ANTECEDENTE_RE` al demostrativo + cópula y **reponer** el test con
  la frase canónica (casos **29** y **30**).
- **AG01** — sus dos últimas revisiones son evidencia citada por el contrato y **siguen sin
  mergear** a `develop`. Merecen entrar.
- **Todos** — desde E11, una entrega sin Declaración de Impacto como archivo en `docs/informes/`
  es rechazable por el revisor sin entrar en el código.
