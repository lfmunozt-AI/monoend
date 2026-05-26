# Synthetic Data Spec — Auditoría y Simulación Masiva (AG07)

> Especificación de los datos sintéticos generados por
> `scripts/seed-synthetic-profiles.ts`.
> Diseñado para staging — **nunca producción**.

## 1. Objetivo

Generar 100 perfiles reproducibles que cubran el espacio realista de
usuarios PT/ES con patrones de comportamiento financiero distintos
(no aleatoriedad pura), para:

- Probar el motor ICA / IDF con volúmenes representativos.
- Validar el Consigliere con conversaciones contra perfiles diversos.
- Stress-tear vistas del dashboard (cards, gráficas, fugas).
- Detectar regresiones masivas (perfil X deja de calcularse, etc.).

## 2. Identidad de los datos sintéticos

| Campo            | Patrón                                                 |
|------------------|--------------------------------------------------------|
| Email            | `synth_001@audit.andgcore.test` … `synth_100@…`        |
| `user_metadata`  | `{ synthetic: true, archetype, country, age }`         |
| `onboarding_data._synthetic` | `true`                                     |
| Dominio          | `audit.andgcore.test` (TLD reservado IANA, nunca real) |

El sufijo `audit.andgcore.test` cumple [RFC 2606] § 2 — un dominio `.test`
no es enrutable, lo que garantiza que ningún correo se entregue jamás
si el seeder se ejecuta por error contra un entorno con SMTP saliente.

[RFC 2606]: https://datatracker.ietf.org/doc/html/rfc2606

## 3. Distribución del plan

### País (100 = 60 PT + 40 ES)

| País | Recuento | Idioma UI |
|------|----------|-----------|
| PT   | 60       | `pt`      |
| ES   | 40       | `es`      |

### Edad

| Bucket | Recuento | Rango etario |
|--------|----------|--------------|
| 25-34  | 25       | 25–34        |
| 35-49  | 40       | 35–49        |
| 50-64  | 25       | 50–64        |
| 65-80  | 10       | 65–80        |

### Arquetipo financiero

| Arquetipo    | Recuento | Firma característica                                                 |
|--------------|----------|----------------------------------------------------------------------|
| ahorrador    | 20       | Tasa de ahorro >15%, fugas <5% del gasto, gastos discrecionales bajos|
| gastador     | 25       | Tasa de ahorro <5%, fugas 15–25%, restaurantes/ocio/ropa altos       |
| impulsivo    | 15       | Fugas con varianza semanal alta (spike factor 0.3–2.5)               |
| conservador  | 20       | Ingresos estables, gastos predecibles, sin meta agresiva             |
| endeudado    | 20       | `pago_deuda` 25–35% + `intereses_deuda` 6–10% del ingreso            |

Las tres distribuciones se generan por separado y se barajan independientemente
con un PRNG determinista (mulberry32, seed `20260526`), de modo que dos ejecuciones
sucesivas producen el **mismo conjunto** de asignaciones. Esto es clave para que
las auditorías comparen ejecuciones distintas a igualdad de input.

## 4. Salarios netos mensuales

Los rangos corresponden al salario **neto** en € (lo que llega a la cuenta).
El `monthly_gross` de `fiscal_profiles` se aproxima como `neto × 1.32`.

### Portugal — 800–3500 €/mes neto

| Arquetipo    | Mín  | Máx  |
|--------------|------|------|
| ahorrador    | 1800 | 2800 |
| gastador     | 1800 | 3500 |
| impulsivo    | 1400 | 2600 |
| conservador  | 1400 | 2400 |
| endeudado    | 800  | 1800 |

### España — 1100–4500 €/mes neto

| Arquetipo    | Mín  | Máx  |
|--------------|------|------|
| ahorrador    | 2200 | 3500 |
| gastador     | 2200 | 4500 |
| impulsivo    | 1800 | 3200 |
| conservador  | 1800 | 2800 |
| endeudado    | 1100 | 2200 |

### Pagas extra / subsidios

| País | Mes  | Concepto             | Importe          |
|------|------|----------------------|------------------|
| PT   | 6    | Subsídio de férias   | = 1× salario neto|
| PT   | 11   | Subsídio de Natal    | = 1× salario neto|
| ES   | 7    | Paga extra de verano | = 1× salario neto|
| ES   | 12   | Paga extra de Navidad| = 1× salario neto|

## 5. Categorías de gasto

Cada arquetipo aplica un perfil distinto sobre el siguiente catálogo.
Los porcentajes son fracción del **ingreso mensual neto**; el script
genera entre N y M transacciones por categoría y mes (`txPerMonth`).

| Categoría             | `power_law`     | Aplica `is_leak` para…             |
|-----------------------|-----------------|------------------------------------|
| alquiler              | vital           | —                                  |
| supermercado          | vital           | —                                  |
| transporte            | important       | —                                  |
| energia               | important       | —                                  |
| telecomunicaciones    | important       | —                                  |
| salud                 | important       | —                                  |
| restaurantes          | discretionary   | gastador, impulsivo                |
| ocio                  | discretionary   | gastador, impulsivo                |
| ropa                  | discretionary   | gastador, impulsivo                |
| suscripciones         | leak            | gastador, impulsivo                |
| pago_deuda            | debt            | — (sólo endeudado)                 |
| intereses_deuda       | debt            | — (sólo endeudado)                 |

### Resumen porcentual por arquetipo (% del ingreso neto)

| Categoría          | ahorrador     | gastador      | impulsivo     | conservador   | endeudado     |
|--------------------|---------------|---------------|---------------|---------------|---------------|
| alquiler           | 25–33         | 28–36         | 28–36         | 30–35         | 28–34         |
| supermercado       | 9–14          | 10–18         | 10–18         | 13–17         | 10–18         |
| transporte         | 4–10          | 4–10          | 4–10          | 4–10          | 4–10          |
| energia            | 3–7           | 3–7           | 3–7           | 3–7           | 3–7           |
| telecomunicaciones | 2–5           | 2–5           | 2–5           | 2–5           | 2–5           |
| salud              | 1–5           | 1–5           | 1–5           | 1–5           | 1–5           |
| restaurantes       | 1–3           | 8–14          | 3–18 (×spike) | 2–4           | 3–6           |
| ocio               | 1–2.5         | 5–10          | 2–16 (×spike) | 2–4           | 2–4           |
| ropa               | 0.5–2         | 4–9           | 1–22 (×spike) | 1–3           | 1–3           |
| suscripciones      | 0.5–1.5       | 3–6           | 2–10 (×spike) | 1–2.5         | 1.5–3.5       |
| pago_deuda         | —             | —             | —             | —             | 25–35         |
| intereses_deuda    | —             | —             | —             | —             | 6–10          |

`spike` para `impulsivo` se sortea por mes en `[0.3, 2.5]` y se aplica sólo
a categorías `discretionary` y `leak`. Esto produce semanas tranquilas y
semanas de exceso, que es el patrón que el Consigliere debe detectar.

## 6. Eventos puntuales

Cada usuario tira tres dados independientes para eventos no recurrentes:

| Evento                       | Probabilidad | Importe          | Ventana temporal             |
|------------------------------|--------------|------------------|------------------------------|
| Bono anual (ingreso)         | 25%          | 1000–3000 €      | Mes aleatorio del histórico  |
| Devolución hacienda (ingreso)| 30%          | 300–1200 €       | Mayo–Julio si está cubierto  |
| Gasto médico inesperado      | 20%          | 200–1500 €       | Mes aleatorio del histórico  |

## 7. Histórico temporal

Cada usuario tiene entre **3 y 6 meses** de transacciones (uniforme).
El último mes incluido es el actual (`2026-05` con la fecha de TODAY).

## 8. Meta declarada

Cada arquetipo elige aleatoriamente una meta de un set coherente con su perfil,
y un horizonte (en meses) que se convierte en `goal_date` ISO.

Ejemplos:

- **ahorrador** → "Independencia financiera antes de los 55" (120 meses)
- **gastador** → "Cerrar el mes con ahorro positivo de forma constante" (6 meses)
- **impulsivo** → "Identificar y reducir mis fugas semanales" (9 meses)
- **conservador** → "Planificar mi jubilación con tranquilidad" (60 meses)
- **endeudado** → "Salir de deudas en menos de 24 meses" (24 meses)

Se guardan en `profiles.onboarding_data.main_goal` y `.goal_date` (mismo shape
que `/api/onboarding/complete`). Cuando la tabla `goals` exista (migración 007
pendiente, owner AG06), este script deberá extender la inserción.

## 9. Filas escritas en BD por usuario

| Tabla              | Filas por usuario       | Notas                             |
|--------------------|-------------------------|-----------------------------------|
| `auth.users`       | 1                       | vía `auth.admin.createUser`       |
| `profiles`         | 1                       | auto-creado por trigger + UPDATE  |
| `subscriptions`    | 1                       | auto-creado por trigger           |
| `fiscal_profiles`  | 1                       | INSERT directo                    |
| `transactions`     | ~60–180                 | depende de meses y arquetipo      |
| `ica_history`      | tx + 1 (onboarding)     | generadas por trigger `005`       |

Total estimado: ~10 000–15 000 transacciones, ~12 000–17 000 filas en
`ica_history`. Cada `INSERT` en `transactions` dispara el trigger ICA, por
lo que el seeder no es instantáneo (≈2–4 min en staging típico).

## 10. Seguridad y guard-rails

El seeder se niega a correr salvo que se cumplan **todas** estas condiciones:

1. `NEXT_PUBLIC_SUPABASE_URL` (o `SUPABASE_URL`) y `SUPABASE_SERVICE_ROLE_KEY`
   están en el entorno.
2. La URL **no** contiene `prod` ni `production` (case-insensitive).
3. La variable `ALLOW_SYNTHETIC_SEED=1` está explícitamente puesta.

El cleanup tiene una variable separada `ALLOW_SYNTHETIC_CLEANUP=1` para evitar
re-uso accidental del confirm flag.

## 11. Cómo ejecutar

```bash
# Cargar credenciales staging
export $(grep -v '^#' .env.local | xargs)

# Sembrado (idempotencia: re-run crea otros 100 si el dominio cambia;
#  si ya existen, falla al crear y reporta el error por usuario)
ALLOW_SYNTHETIC_SEED=1 npx tsx scripts/seed-synthetic-profiles.ts

# Limpieza
ALLOW_SYNTHETIC_CLEANUP=1 npx tsx scripts/cleanup-synthetic-profiles.ts
```

`tsx` se resuelve vía `npx` sin necesidad de instalación previa.

## 12. Verificación post-seed

```sql
-- ¿100 usuarios?
SELECT count(*) FROM auth.users
 WHERE email LIKE 'synth_%@audit.andgcore.test';

-- Distribución por arquetipo
SELECT onboarding_data->>'_archetype' AS archetype, count(*)
  FROM profiles
 WHERE onboarding_data->>'_synthetic' = 'true'
 GROUP BY 1 ORDER BY 1;

-- Transacciones medias por usuario
SELECT u.email,
       count(t.id) AS txs,
       sum(t.amount) FILTER (WHERE t.type = 'income')  AS ingresos,
       sum(t.amount) FILTER (WHERE t.type = 'expense') AS gastos
  FROM auth.users u
  LEFT JOIN transactions t ON t.user_id = u.id
 WHERE u.email LIKE 'synth_%@audit.andgcore.test'
 GROUP BY u.email
 ORDER BY u.email
 LIMIT 20;

-- Cobertura de leaks
SELECT onboarding_data->>'_archetype' AS archetype,
       avg(CASE WHEN is_leak THEN amount END) AS leak_avg,
       sum(CASE WHEN is_leak THEN amount END)
        / NULLIF(sum(amount), 0) AS leak_pct_total
  FROM profiles p
  JOIN transactions t ON t.user_id = p.user_id
 WHERE onboarding_data->>'_synthetic' = 'true'
   AND t.type = 'expense'
 GROUP BY 1
 ORDER BY 1;
```

## 13. Limitaciones conocidas

- **No genera `goals`**: la tabla aún no existe (migración 007 pendiente). Las
  metas viven en `onboarding_data`. Extender este script cuando AG06 termine
  la migración.
- **No genera embeddings**: los embeddings se crean asincrónicamente cuando el
  Consigliere conversa con el usuario. Si el suite de pruebas los necesita,
  lanzar conversaciones sintéticas en una pasada posterior.
- **No genera `messages` ni `conversations`**: out of scope. Hay perfiles pero no historial de chat.
- **Triggers ICA disparan por cada `INSERT`**: el seeder no los desactiva. La
  consecuencia es que cada usuario sube su ICA al máximo (100) por el simple
  hecho de tener muchas transacciones. Si esto distorsiona pruebas, considera
  resetear `ica_score` y truncar `ica_history` tras el seed.
