import { StrictMode, Suspense, lazy, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { backendConfigured, databaseConfigured } from './lib/db'
import { Shell } from './components/Shell'
import { EmptyState } from './components/ui'
import { SignIn, Onboarding, Boot, LoadWorkspaceError } from './pages/Access'
import { Dashboard } from './pages/Dashboard'
import './style.css'

/**
 * Every other page is loaded on demand.
 *
 * The single bundle this used to produce was ~975 kB, which on a 3G connection
 * in the factory office was long enough that people reopened the tab to "speed
 * it up" and, on a slow link, gave up entirely. Splitting by route means signing
 * in downloads only the sign-in screen, and the dashboard does not carry the
 * PDF engine or the whole delivery-challan module.
 *
 * Access stays eager on purpose: it is the first thing a signed-out employee
 * sees, and a lazy chunk there would only add a round trip to the screen that
 * must appear fastest.
 */
const Customers = lazy(() => import('./pages/Customers').then(m => ({ default: m.Customers })))
const CustomerDetail = lazy(() => import('./pages/Customers').then(m => ({ default: m.CustomerDetail })))
const Products = lazy(() => import('./pages/Products').then(m => ({ default: m.Products })))
const ProductDetail = lazy(() => import('./pages/Products').then(m => ({ default: m.ProductDetail })))
const ProductForm = lazy(() => import('./pages/Products').then(m => ({ default: m.ProductForm })))
const Bills = lazy(() => import('./pages/Bills').then(m => ({ default: m.Bills })))
const BillDetail = lazy(() => import('./pages/Bills').then(m => ({ default: m.BillDetail })))
const BillForm = lazy(() => import('./pages/BillForm').then(m => ({ default: m.BillForm })))
const Scan = lazy(() => import('./pages/Scan').then(m => ({ default: m.Scan })))
const ScanReview = lazy(() => import('./pages/Scan').then(m => ({ default: m.ScanReview })))
const Reports = lazy(() => import('./pages/Reports').then(m => ({ default: m.Reports })))
const Outstanding = lazy(() => import('./pages/Outstanding').then(m => ({ default: m.Outstanding })))
const Import = lazy(() => import('./pages/Import').then(m => ({ default: m.Import })))
const AuditLog = lazy(() => import('./pages/AuditLog').then(m => ({ default: m.AuditLog })))
const Exports = lazy(() => import('./pages/Exports').then(m => ({ default: m.Exports })))
const Settings = lazy(() => import('./pages/Settings').then(m => ({ default: m.Settings })))
const DcDashboard = lazy(() => import('./pages/DcDashboard').then(m => ({ default: m.DcDashboard })))
const DcForm = lazy(() => import('./pages/DcForm').then(m => ({ default: m.DcForm })))
const DcDetail = lazy(() => import('./pages/DcDetail').then(m => ({ default: m.DcDetail })))
const InwardList = lazy(() => import('./pages/DcList').then(m => ({ default: m.InwardList })))
const OutwardCustomerList = lazy(() => import('./pages/DcList').then(m => ({ default: m.OutwardCustomerList })))
const AllChallans = lazy(() => import('./pages/DcList').then(m => ({ default: m.AllChallans })))
const DcSearch = lazy(() => import('./pages/DcSearch').then(m => ({ default: m.DcSearch })))
const DcInspection = lazy(() => import('./pages/DcOperations').then(m => ({ default: m.DcInspection })))
const DcMovements = lazy(() => import('./pages/DcOperations').then(m => ({ default: m.DcMovements })))
const DcPending = lazy(() => import('./pages/DcOperations').then(m => ({ default: m.DcPending })))
const DcRejections = lazy(() => import('./pages/DcOperations').then(m => ({ default: m.DcRejections })))
const DcLedger = lazy(() => import('./pages/DcLedger').then(m => ({ default: m.DcLedger })))
const DcReports = lazy(() => import('./pages/DcReports').then(m => ({ default: m.DcReports })))
const DcSettingsPage = lazy(() => import('./pages/DcReports').then(m => ({ default: m.DcSettingsPage })))

function NewCustomer() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(true)
  const CustomerForm = lazy(() => import('./components/CustomerForm').then(m => ({ default: m.CustomerForm })))
  return <>{open && <CustomerForm onClose={() => { setOpen(false); navigate('/customers') }} onSaved={customer => navigate(`/customers/${customer.id}`)} />}</>
}

/**
 * The session gate lives inside the router so the address bar always matches the
 * screen. Rendering SignIn/Onboarding as siblings of <Routes> left the URL on the
 * last protected route while a different screen was shown, which broke sign-out,
 * signed-out bookmarks and the Back button.
 */
function RequireSession() {
  const { user, organization, loading, loadError, refresh } = useAuth()
  const location = useLocation()
  const [retrying, setRetrying] = useState(false)
  if (loading) return <Boot />
  const from = `${location.pathname}${location.search}`
  if (!user) return <Navigate to="/signin" replace state={{ from }} />
  // A lookup that failed means "unknown", never "no workspace": redirecting here
  // is what asked returning members to set up a workspace they already had.
  if (loadError) return <LoadWorkspaceError message={loadError} busy={retrying} onRetry={() => { setRetrying(true); void refresh().finally(() => setRetrying(false)) }} />
  if (!organization) return <Navigate to="/onboarding" replace state={{ from }} />
  // Route chunks download on demand, so every protected screen is wrapped in a
  // boundary. Without it a chunk failure would blank the app with no recovery,
  // and a slow connection would show a blank page mid-navigation.
  return <Suspense fallback={<Boot />}><Outlet /></Suspense>
}

function AppRoutes() {
  return <Routes>
    <Route path="/signin" element={<SignIn />} />
    <Route path="/onboarding" element={<Onboarding />} />
    <Route element={<RequireSession />}>
      <Route element={<Shell />}><Route path="/" element={<Navigate to="/dashboard" replace />} /><Route path="/dashboard" element={<Dashboard />} /><Route path="/customers" element={<Customers />} /><Route path="/customers/new" element={<NewCustomer />} /><Route path="/customers/:id" element={<CustomerDetail />} /><Route path="/products" element={<Products />} /><Route path="/products/new" element={<ProductForm />} /><Route path="/products/:id" element={<ProductDetail />} /><Route path="/products/:id/edit" element={<ProductForm />} /><Route path="/bills" element={<Bills />} /><Route path="/bills/new" element={<BillForm />} /><Route path="/bills/:id" element={<BillDetail />} /><Route path="/bills/:id/edit" element={<BillForm />} /><Route path="/scan" element={<Scan />} /><Route path="/scan/review/:id" element={<ScanReview />} /><Route path="/reports" element={<Reports />} /><Route path="/reports/outstanding" element={<Outstanding />} /><Route path="/import" element={<Import />} /><Route path="/exports" element={<Exports />} /><Route path="/audit-log" element={<AuditLog />} /><Route path="/settings" element={<Settings />} /><Route path="*" element={<EmptyState title="Page not found" description="This route is not available." action="Go to dashboard" href="/dashboard" />} /></Route>

      {/*
        Delivery Challan module. It sits in the same session gate as Billing,
        so switching between them never asks for a second login. The existing
        /customers and /products pages are deliberately reused rather than
        duplicated - only /dc/ledger and /dc/rejections are DC-specific.
      */}
      <Route element={<Shell />}>
        <Route path="/dc" element={<DcDashboard />} />
        <Route path="/dc/inward" element={<InwardList />} />
        <Route path="/dc/inward/new" element={<DcForm dcType="inward" />} />
        <Route path="/dc/inward/:id" element={<DcDetail />} />
        <Route path="/dc/inward/:id/edit" element={<DcForm dcType="inward" />} />
        <Route path="/dc/outward" element={<OutwardCustomerList />} />
        <Route path="/dc/outward/new" element={<DcForm dcType="outward_customer" />} />
        <Route path="/dc/outward/:id" element={<DcDetail />} />
        <Route path="/dc/outward/:id/edit" element={<DcForm dcType="outward_customer" />} />
        {/* The old outward customer paths stay as aliases, so a challan
            bookmarked before the rename to "Outward DC" still opens. */}
        <Route path="/dc/outward/customer" element={<OutwardCustomerList />} />
        <Route path="/dc/outward/customer/new" element={<DcForm dcType="outward_customer" />} />
        <Route path="/dc/outward/customer/:id" element={<DcDetail />} />
        <Route path="/dc/outward/customer/:id/edit" element={<DcForm dcType="outward_customer" />} />
        <Route path="/dc/all" element={<AllChallans />} />
        <Route path="/dc/search" element={<DcSearch />} />
        <Route path="/dc/ledger" element={<DcLedger />} />
        <Route path="/dc/inspection" element={<DcInspection />} />
        <Route path="/dc/rejections" element={<DcRejections />} />
        <Route path="/dc/pending" element={<DcPending />} />
        <Route path="/dc/movements" element={<DcMovements />} />
        <Route path="/dc/reports" element={<DcReports />} />
        <Route path="/dc/settings" element={<DcSettingsPage />} />
      </Route>
    </Route>
  </Routes>
}

function App() {
  if (!databaseConfigured) return <main className="setup-layout"><div className="card access-card"><h1>Configuration required</h1><p>Set VITE_NEON_DATABASE_URL in .env, then restart the development server.</p></div></main>
  if (!backendConfigured) return <main className="setup-layout"><div className="card access-card"><h1>Backend not configured</h1><p>Set VITE_NEON_API_URL and VITE_NEON_PROCESS_BILL_URL in .env to the deployed Neon Function URLs, then restart the development server.</p></div></main>
  return <AppRoutes />
}

createRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter><AuthProvider><App /></AuthProvider></BrowserRouter></StrictMode>)