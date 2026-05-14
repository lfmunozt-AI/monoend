/**
 * @module transactions-validation
 * Helpers de validación puros para la API de transacciones.
 * Sin dependencias de servidor — importable en tests con npx tsx.
 */

export function parseAmount(raw: unknown): number | null {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
}

export function parseType(raw: unknown): 'income' | 'expense' | null {
  return raw === 'income' || raw === 'expense' ? raw : null
}

export function parseISODate(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const d = new Date(raw)
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0]
}

export function parseCursor(raw: string | null): { date: string; id: string } | null {
  if (!raw) return null
  const sep = raw.indexOf('|')
  if (sep <= 0 || sep === raw.length - 1) return null
  return { date: raw.slice(0, sep), id: raw.slice(sep + 1) }
}
