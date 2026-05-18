'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV_MAIN = [
  { label: 'Dashboard',     href: '/dashboard' },
  { label: 'Transacciones', href: '/transactions' },
  { label: 'Proyecciones',  href: '/projections' },
  { label: 'Fugas',         href: '/leaks' },
]

const NAV_SECONDARY = [
  { label: 'Reportes',      href: '/reports' },
  { label: 'Configuración', href: '/settings' },
]

interface SidebarProps {
  isDark: boolean
  onToggleDark: () => void
}

export default function Sidebar({ isDark, onToggleDark }: SidebarProps) {
  const pathname = usePathname()

  const renderLink = (item: { label: string; href: string }) => {
    const isActive = pathname === item.href
    return (
      <Link
        key={item.href}
        href={item.href}
        style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '10px 24px',
          borderLeft: isActive ? '3px solid #C9A84C' : '3px solid transparent',
          background: isActive ? 'rgba(201,168,76,.08)' : 'transparent',
          color: isActive ? '#C9A84C' : '#6A6460',
          fontSize: '14px', fontWeight: isActive ? 600 : 400,
          textDecoration: 'none', transition: 'all .15s',
        }}
      >
        {item.label}
      </Link>
    )
  }

  return (
    <aside style={{
      width: '220px', background: '#111', color: '#EAE6DC',
      display: 'flex', flexDirection: 'column', height: '100vh',
      position: 'fixed', left: 0, top: 0, zIndex: 40,
    }}>
      {/* Logo */}
      <div style={{ padding: '28px 24px 20px' }}>
        <span style={{ color: '#C9A84C', fontWeight: 700, fontSize: '18px', letterSpacing: '-0.3px' }}>
          andgcore
        </span>
        <div style={{ color: '#6A6460', fontSize: '11px', marginTop: '2px', letterSpacing: '0.5px' }}>
          Sovereign CFO
        </div>
      </div>

      {/* Nav principal */}
      <nav style={{ flex: 1, paddingTop: '8px' }}>
        {NAV_MAIN.map(renderLink)}
        <div style={{ height: '1px', background: 'rgba(255,255,255,.06)', margin: '12px 24px' }} />
        {NAV_SECONDARY.map(renderLink)}
      </nav>

      {/* Bottom */}
      <div style={{ borderTop: '1px solid rgba(255,255,255,.06)' }}>
        {/* Dark mode toggle */}
        <button
          onClick={onToggleDark}
          style={{
            width: '100%', padding: '14px 24px',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: 'transparent', border: 'none',
            color: '#6A6460', fontSize: '13px', cursor: 'pointer',
          }}
        >
          <span>Modo oscuro</span>
          <div style={{
            width: '36px', height: '20px', borderRadius: '10px',
            background: isDark ? '#C9A84C' : 'rgba(255,255,255,.12)',
            position: 'relative', transition: 'background .2s',
          }}>
            <div style={{
              width: '16px', height: '16px', borderRadius: '50%',
              background: '#fff', position: 'absolute', top: '2px',
              left: isDark ? '18px' : '2px', transition: 'left .2s',
            }} />
          </div>
        </button>

        {/* Plan */}
        <div style={{ padding: '14px 24px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
            <span style={{ color: '#C9A84C', fontWeight: 600, fontSize: '13px' }}>Élite</span>
            <span style={{ color: '#6A6460', fontSize: '11px' }}>· activo</span>
          </div>
          <button style={{
            background: 'rgba(201,168,76,.1)', border: '1px solid rgba(201,168,76,.2)',
            borderRadius: '6px', padding: '6px 12px', color: '#C9A84C',
            fontSize: '11px', fontWeight: 500, cursor: 'pointer', width: '100%',
          }}>
            Ver beneficios
          </button>
        </div>
      </div>
    </aside>
  )
}
