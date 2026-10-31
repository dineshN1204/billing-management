import { useState } from 'react'
import { Download, RefreshCw, WifiOff, X } from 'lucide-react'
import { Button } from './ui'
import { usePwa } from '../lib/pwa'

/**
 * The three states a Progressive Web App has to communicate, none of which the
 * browser surfaces on its own:
 *
 *  - Offline. The app is still open and the navigation works, but every screen
 *    that reads or writes business data needs the network. Saying so plainly
 *    stops someone filling in a challan that cannot be saved.
 *  - Update ready. A new build is on the server. It is NOT applied
 *    automatically, because doing that can swap the code under a form someone is
 *    halfway through.
 *  - Installable. Chrome and Edge raise a real prompt; iOS Safari does not, so
 *    the fallback copy points at the Share sheet instead of pretending.
 */
export function PwaStatus() {
  const { updateReady, installable, installed, offline, applyUpdate, dismissUpdate, promptInstall } = usePwa()
  const [applying, setApplying] = useState(false)
  const [showInstallHelp, setShowInstallHelp] = useState(false)

  return (
    <>
      {offline && (
        <div className="pwa-banner pwa-banner-offline" role="status" aria-live="polite">
          <WifiOff size={16} aria-hidden="true" />
          <span>
            <strong>You are offline.</strong> The app is open, but creating or saving anything needs a
            connection. Nothing you have already saved is affected.
          </span>
        </div>
      )}

      {updateReady && (
        <div className="pwa-banner pwa-banner-update" role="status" aria-live="polite">
          <RefreshCw size={16} aria-hidden="true" />
          <span>A new version of the app is ready.</span>
          <Button
            variant="secondary"
            disabled={applying}
            onClick={() => { setApplying(true); void applyUpdate() }}
          >
            {applying ? 'Updating...' : 'Update now'}
          </Button>
          <button className="icon-button" aria-label="Dismiss update" onClick={dismissUpdate}>
            <X size={16} />
          </button>
        </div>
      )}

      {installable && !installed && (
        <div className="pwa-banner pwa-banner-install" role="status" aria-live="polite">
          <Download size={16} aria-hidden="true" />
          <span>Install Billbook on this device for a full-screen, app-like experience.</span>
          <Button variant="secondary" onClick={() => void promptInstall()}>Install</Button>
          <button className="icon-button" aria-label="Installation instructions" onClick={() => setShowInstallHelp(true)}>
            How?
          </button>
        </div>
      )}

      {showInstallHelp && <InstallHelp onClose={() => setShowInstallHelp(false)} />}
    </>
  )
}

function InstallHelp({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal install-help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-help-title"
        onClick={event => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">INSTALLATION</span>
            <h2 id="install-help-title">Add Billbook to this device</h2>
          </div>
          <button className="icon-button" aria-label="Close" onClick={onClose}><X size={22} /></button>
        </div>

        <div className="section-heading"><div><h3>Android (Chrome, Edge, Samsung Internet)</h3>
          <p>Tap <strong>Install</strong> in the bar above. If it has been dismissed, open the browser
            menu (⋮) and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</p></div></div>

        <div className="section-heading"><div><h3>iPhone and iPad (Safari)</h3>
          <p>Safari does not offer an install prompt. Tap <strong>Share</strong>, then
            <strong> Add to Home Screen</strong>, then <strong>Add</strong>.</p></div></div>

        <div className="section-heading"><div><h3>Desktop (Chrome, Edge)</h3>
          <p>Click the install icon at the right of the address bar, or use
            <strong> ⋮ → Cast, save and share → Install page as app</strong>.</p></div></div>

        <div className="divider" />

        <h3>What still works without a connection</h3>
        <ul className="plain-list">
          <li>Opening the app and moving between screens.</li>
          <li>Printing a document already on screen, using the browser Print dialog.</li>
        </ul>
        <h3>What needs a connection</h3>
        <ul className="plain-list">
          <li>Every screen that reads data - bills, challans, stock, reports.</li>
          <li>Saving anything at all: no invoice or challan is ever queued offline.</li>
          <li>Signing in.</li>
        </ul>
        <p className="muted">
          Offline entry is deliberately not offered. A queued challan that synced twice would create a
          duplicate record, and a duplicate material movement cannot be undone by editing a number.
        </p>

        <div className="form-actions">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  )
}