'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV_MAIN = [
  { label: 'Dashboard',     href: '/dashboard' },
  { label: 'Chat CFO',      href: '/chat', icon: 'ti-message-circle' },
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
  onLogout?: () => void
}

export default function Sidebar({ isDark, onToggleDark, onLogout }: SidebarProps) {
  const pathname = usePathname()

  const renderLink = (item: { label: string; href: string; icon?: string }) => {
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
        {item.icon && <i className={`ti ${item.icon}`} style={{ fontSize: '16px' }} />}
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
        {/* Logout */}
        {onLogout && (
          <button
            onClick={onLogout}
            style={{
              width: '100%', padding: '14px 24px',
              display: 'flex', alignItems: 'center', gap: '10px',
              background: 'transparent', border: 'none',
              color: 'rgba(255,255,255,.35)', fontSize: '13px', cursor: 'pointer',
              transition: 'color .2s',
            }}
            onMouseEnter={(e) => e.currentTarget.style.color = '#8B2635'}
            onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255,255,255,.35)'}
          >
            <i className="ti ti-logout" style={{ fontSize: '16px' }} />
            <span>Cerrar sesión</span>
          </button>
        )}

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
        <div style={{ padding: '18px 24px 22px', background: 'rgba(201,168,76,.05)', borderTop: '1px solid rgba(201,168,76,.12)' }}>
          <div style={{ fontSize: '10px', fontWeight: 700, color: '#C9A84C', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '6px' }}>
            Plan Actual
          </div>
          <div style={{ fontSize: '14px', fontWeight: 500, color: '#EAE6DC', marginBottom: '4px' }}>
            Élite
          </div>
          <div style={{ fontSize: '11px', color: '#6A6460', marginBottom: '12px' }}>
            activo · renovación en 26 días
          </div>
          <button style={{
            background: '#C9A84C', border: 'none',
            borderRadius: '8px', padding: '9px 14px', color: '#111',
            fontSize: '12px', fontWeight: 600, cursor: 'pointer', width: '100%',
          }}>
            Ver beneficios
          </button>
        </div>
      </div>
    </aside>
  )
}
