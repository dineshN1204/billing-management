import { useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import {
  BarChart3, BookOpen, Boxes, ChartNoAxesCombined, ClipboardCheck, FileText, LayoutDashboard,
  LogOut, Menu, Package, Printer, Receipt, ScanLine, Search, Settings, Truck, Undo2, Users, X,
} from 'lucide-react'
import { GlobalSearch } from './GlobalSearch'
import { PageErrorBoundary } from './PageErrorBoundary'
import { PwaStatus } from './PwaStatus'
import { useAuth } from '../lib/auth'
import { usePwa } from '../lib/pwa'
import { friendlyError } from '../lib/format'

/**
 * Billing Management and Delivery Challans share one session, one organization
 * and one role. The switcher below changes the navigation set and nothing else -
 * no second sign-in, no separate workspace.
 */
const BILLING_NAV = [
  { to: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { to: '/customers', label: 'Customers', icon: Users },
  { to: '/bills', label: 'Bills', icon: FileText },
  { to: '/products', label: 'Products', icon: Package },
  { to: '/scan', label: 'Scan bills', icon: ScanLine },
  { to: '/reports', label: 'Reports', icon: ChartNoAxesCombined },
  { to: '/reports/outstanding', label: 'Outstanding', icon: ChartNoAxesCombined },
  { to: '/import', label: 'Import', icon: Package },
  { to: '/exports', label: 'Exports', icon: FileText },
  { to: '/audit-log', label: 'Audit log', icon: Settings },
  { to: '/settings', label: 'Company settings', icon: Settings },
]

const DC_NAV = [
  { to: '/dc', label: 'DC dashboard', icon: LayoutDashboard },
  { to: '/dc/inward', label: 'Inward DC', icon: Package },
  { to: '/dc/outward', label: 'Outward DC', icon: Truck },
  { to: '/dc/all', label: 'All challans', icon: Boxes },
  { to: '/dc/search', label: 'Find a challan', icon: Search },
  { to: '/dc/ledger', label: 'Customer material ledger', icon: BookOpen },
  { to: '/dc/inspection', label: 'Material inspection', icon: ClipboardCheck },
  { to: '/dc/rejections', label: 'Rejection management', icon: Undo2 },
  { to: '/dc/pending', label: 'Pending quantities', icon: Receipt },
  { to: '/dc/movements', label: 'Dispatch and receipt', icon: Printer },
  { to: '/dc/reports', label: 'Reports', icon: BarChart3 },
  { to: '/dc/settings', label: 'Challan settings', icon: Settings },
  // The company details live in the billing module's settings screen, and the
  // two modules share one session. Without this link the DC sidebar led
  // nowhere near the GSTIN, address and phone that print on every challan.
  { to: '/settings', label: 'Company settings', icon: Users },
]

export function Shell() {
  const { organization, user, signOut } = useAuth()
  const { offline } = usePwa()
  const location = useLocation()
  const navigate = useNavigate()
  const [mobile, setMobile] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [signOutError, setSignOutError] = useState('')

  // The module is derived from the URL rather than stored, so a bookmark or a
  // refresh lands in the module the link belongs to.
  const module = location.pathname.startsWith('/dc') ? 'dc' : 'billing'
  const nav = module === 'dc' ? DC_NAV : BILLING_NAV

  async function leave() {
    setLeaving(true); setSignOutError('')
    const failure = await signOut()
    // On success the provider drops the user and the shell unmounts.
    if (failure) { setSignOutError(friendlyError(failure)); setLeaving(false) }
  }

  return (
    <div className="app-layout">
      {mobile && <button className="mobile-backdrop" aria-label="Close menu" onClick={() => setMobile(false)} />}
      <aside className={`sidebar ${mobile ? 'sidebar-open' : ''}`}>
        <div className="brand">
          <div className="brand-icon">{module === 'dc' ? <Truck size={20} /> : <BookOpen size={20} />}</div>
          <div>
            <strong>billbook</strong>
            <small>{module === 'dc' ? 'DELIVERY CHALLANS' : 'BUSINESS ARCHIVE'}</small>
          </div>
          <button className="menu-close" aria-label="Close navigation" onClick={() => setMobile(false)}><X size={20} /></button>
        </div>

        <div className="module-switch" role="group" aria-label="Module">
          <button
            type="button"
            className={module === 'billing' ? 'active' : ''}
            aria-pressed={module === 'billing'}
            onClick={() => { navigate('/dashboard'); setMobile(false) }}
          >
            <BookOpen size={15} /> Billing
          </button>
          <button
            type="button"
            className={module === 'dc' ? 'active' : ''}
            aria-pressed={module === 'dc'}
            onClick={() => { navigate('/dc'); setMobile(false) }}
          >
            <Truck size={15} /> DC
          </button>
        </div>

        <div className="nav-caption">{module === 'dc' ? 'DELIVERY CHALLANS' : 'WORKSPACE'}</div>
        <nav aria-label="Main navigation">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={to === '/dc' || to === '/reports'} onClick={() => setMobile(false)} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
              <Icon size={18} /><span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {signOutError && <p role="alert" className="sidebar-error">{signOutError}</p>}
          <div className="org-avatar">{organization?.name.charAt(0).toUpperCase()}</div>
          <div className="org-info"><strong>{organization?.name}</strong><small>{organization?.role} · {user?.email}</small></div>
          <button className="signout" title="Sign out" aria-label="Sign out" disabled={leaving} onClick={() => void leave()}><LogOut size={17} /></button>
        </div>
      </aside>
      <div className="main-column">
        <PwaStatus />
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobile(true)} aria-label="Open navigation"><Menu size={22} /></button>
          <GlobalSearch />
          <div className="topbar-right">
            <span className={`online-dot ${offline ? 'online-dot-offline' : ''}`} />
            {offline ? 'Offline' : 'Secure workspace'}
          </div>
          {/*
            A sign-out that does not depend on the sidebar.
            The sidebar footer is fine on a desktop, but below 850px the sidebar is
            a hidden drawer, so signing out meant opening the menu first - and on a
            short viewport the footer itself used to be clipped away entirely. This
            button is always on screen, in both modules, at every width.
          */}
          <button
            className="topbar-signout"
            title="Sign out"
            aria-label="Sign out"
            disabled={leaving}
            onClick={() => void leave()}
          >
            <LogOut size={17} />
            <span className="topbar-signout-label">Sign out</span>
          </button>
        </header>
        <main className="content">
          {/* A screen that throws while rendering must not take the whole
              application down with it: the boundary keeps the navigation, the
              session and the other screens alive, and says what went wrong. */}
          <PageErrorBoundary label={module === 'dc' ? 'delivery challan' : 'billing'}>
            <Outlet />
          </PageErrorBoundary>
        </main>
      </div>
    </div>
  )
}