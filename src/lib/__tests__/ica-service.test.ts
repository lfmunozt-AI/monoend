/**
 * Tests unitarios — ica-service.ts (lógica pura, sin I/O)
 * Ejecutar: npx tsx src/lib/__tests__/ica-service.test.ts
 */

import { computeNewScore, isValidEvento, VALID_EVENTOS } from '../ica-service'

// ─── Mini test runner ────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓  ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗  ${name}: ${(e as Error).message}`)
    failed++
  }
}

function assertEqual<T>(actual: T, expected: T): void {
  if (actual !== expected)
    throw new Error(`esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`)
}

function assertRange(actual: number, min: number, max: number): void {
  if (actual < min || actual > max)
    throw new Error(`${actual} fuera del rango [${min}, ${max}]`)
}

// ─── computeNewScore: deltas por evento ─────────────────────────────────────

console.log('\ncomputeNewScore — deltas')

test('transaccion_registrada suma 5', () =>
  assertEqual(computeNewScore(0, 'transaccion_registrada'), 5))

test('meta_definida suma 10', () =>
  assertEqual(computeNewScore(0, 'meta_definida'), 10))

test('extracto_subido suma 15', () =>
  assertEqual(computeNewScore(0, 'extracto_subido'), 15))

test('onboarding_completado suma 20', () =>
  assertEqual(computeNewScore(0, 'onboarding_completado'), 20))

test('hito_alcanzado suma 25', () =>
  assertEqual(computeNewScore(0, 'hito_alcanzado'), 25))

test('evento desconocido no suma nada', () =>
  assertEqual(computeNewScore(50, 'evento_inexistente'), 50))

// ─── computeNewScore: caps y bordes ─────────────────────────────────────────

console.log('\ncomputeNewScore — caps')

test('score no supera 100', () =>
  assertEqual(computeNewScore(95, 'hito_alcanzado'), 100))

test('score no baja de 0 con evento desconocido', () =>
  assertEqual(computeNewScore(0, 'evento_inexistente'), 0))

test('score en 100 permanece en 100', () =>
  assertEqual(computeNewScore(100, 'transaccion_registrada'), 100))

test('acumulación: 0 + meta + extracto = 25', () => {
  const s1 = computeNewScore(0, 'meta_definida')       // 10
  const s2 = computeNewScore(s1, 'extracto_subido')    // 25
  assertEqual(s2, 25)
})

test('resultado siempre en rango 0–100', () => {
  for (const ev of VALID_EVENTOS) {
    assertRange(computeNewScore(0, ev), 0, 100)
    assertRange(computeNewScore(50, ev), 0, 100)
    assertRange(computeNewScore(100, ev), 0, 100)
  }
})

// ─── VALID_EVENTOS ───────────────────────────────────────────────────────────

console.log('\nVALID_EVENTOS')

test('contiene los 5 eventos definidos', () => {
  const expected = [
    'transaccion_registrada',
    'meta_definida',
    'extracto_subido',
    'onboarding_completado',
    'hito_alcanzado',
  ]
  for (const ev of expected) {
    if (!isValidEvento(ev))
      throw new Error(`Falta evento: ${ev}`)
  }
})

// ─── Resumen ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed · ${failed} failed\n`)
if (failed > 0) process.exit(1)
