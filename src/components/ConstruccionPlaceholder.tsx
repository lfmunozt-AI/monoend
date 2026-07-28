interface ConstruccionPlaceholderProps {
  title: string
  description: string
  isDark: boolean
}

export default function ConstruccionPlaceholder({ title, description, isDark }: ConstruccionPlaceholderProps) {
  const T = isDark
    ? { bg: '#0E0E0E', card: '#1A1A1A', fg: '#EAE6DC', fg2: '#6A6460', border: 'rgba(255,255,255,.08)' }
    : { bg: '#E8E3D9', card: '#FFFFFF', fg: '#1A1A1A', fg2: '#7A736C', border: 'rgba(26,26,26,.1)' }

  return (
    <div style={{
      flex: 1, marginLeft: '220px', minHeight: '100vh', backgroundColor: T.bg,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px',
      transition: 'background .3s',
    }}>
      <div style={{
        background: T.card, borderRadius: '16px', padding: '48px 40px', maxWidth: '480px', width: '100%',
        border: `1px solid ${T.border}`, boxShadow: isDark ? 'none' : '0 1px 4px rgba(0,0,0,.08)',
        textAlign: 'center',
      }}>
        <span style={{
          display: 'inline-block', background: 'rgba(201,168,76,.1)', border: '1px solid rgba(201,168,76,.3)',
          color: '#C9A84C', fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.6px',
          borderRadius: '20px', padding: '6px 14px', marginBottom: '20px',
        }}>
          En construcción — versión final
        </span>
        <h1 style={{ fontSize: '22px', fontWeight: 700, color: T.fg, margin: '0 0 14px' }}>{title}</h1>
        <p style={{ fontSize: '14px', color: T.fg2, lineHeight: '1.6', margin: 0 }}>{description}</p>
      </div>
    </div>
  )
}
