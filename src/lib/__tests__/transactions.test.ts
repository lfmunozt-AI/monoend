/**
 * Tests unitarios — lógica de validación de transacciones (pura, sin I/O)
 * Ejecutar: npx tsx src/lib/__tests__/transactions.test.ts
 */

import { parseAmount, parseType, parseISODate, parseCursor } from '../transactions-validation'

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

function assertNull(actual: unknown): void {
  if (actual !== null) throw new Error(`esperado null, obtenido ${JSON.stringify(actual)}`)
}

function assertNotNull(actual: unknown): void {
  if (actual === null || actual === undefined)
    throw new Error('esperado valor no nulo')
}

// ─── parseAmount ─────────────────────────────────────────────────────────────

console.log('\nparseAmount')

test('entero positivo → válido', () => assertEqual(parseAmount(100), 100))
test('decimal positivo → válido', () => assertEqual(parseAmount(12.5), 12.5))
test('string numérico → válido', () => assertEqual(parseAmount('99.99'), 99.99))
test('redondea a 2 decimales', () => assertEqual(parseAmount(1.234), 1.23))
test('cero → null (no permitido)', () => assertNull(parseAmount(0)))
test('negativo → null', () => assertNull(parseAmount(-10)))
test('NaN → null', () => assertNull(parseAmount('abc')))
test('undefined → null', () => assertNull(parseAmount(undefined)))
test('null → null', () => assertNull(parseAmount(null)))

// ─── parseType ───────────────────────────────────────────────────────────────

console.log('\nparseType')

test('"income" → income', () => assertEqual(parseType('income'), 'income'))
test('"expense" → expense', () => assertEqual(parseType('expense'), 'expense'))
test('"gasto" → null', () => assertNull(parseType('gasto')))
test('número → null', () => assertNull(parseType(1)))
test('null → null', () => assertNull(parseType(null)))

// ─── parseISODate ─────────────────────────────────────────────────────────────

console.log('\nparseISODate')

test('fecha ISO válida → YYYY-MM-DD', () => assertEqual(parseISODate('2026-05-14'), '2026-05-14'))
test('datetime ISO → solo fecha', () => {
  const result = parseISODate('2026-05-14T10:00:00Z')
  assertNotNull(result)
  assertEqual(result!.length, 10)
})
test('string vacío → null', () => assertNull(parseISODate('')))
test('fecha inválida → null', () => assertNull(parseISODate('not-a-date')))
test('número → null', () => assertNull(parseISODate(20260514)))
test('null → null', () => assertNull(parseISODate(null)))

// ─── parseCursor ──────────────────────────────────────────────────────────────

console.log('\nparseCursor')

test('cursor válido → { date, id }', () => {
  const result = parseCursor('2026-05-14T10:00:00.000Z|123e4567-e89b-12d3-a456-426614174000')
  assertNotNull(result)
  assertEqual(result!.date, '2026-05-14T10:00:00.000Z')
  assertEqual(result!.id, '123e4567-e89b-12d3-a456-426614174000')
})
test('null → null', () => assertNull(parseCursor(null)))
test('sin separador | → null', () => assertNull(parseCursor('nodivider')))
test('parcial sin id → null', () => assertNull(parseCursor('2026-05-14|')))

// ─── Resumen ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed · ${failed} failed\n`)
if (failed > 0) process.exit(1)
