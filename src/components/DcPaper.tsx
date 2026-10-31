import type { ReactNode } from 'react'
import type { DcBundle, DcItem } from '../lib/dc-types'
import { DC_TYPE_TITLE } from '../lib/dc-types'
import { displayDate } from '../lib/format'
import { qty } from '../lib/dc-quantities'

type Company = { name: string; gstin?: string | null; address?: string | null; phone?: string | null; email?: string | null }

const label = (text: string) => <span className="dc-label">{text}</span>
const val = (value: string | null | undefined, fallback = '—') => (
  <span>{value && value.trim() ? value : fallback}</span>
)

/** Same as val(), but when the fallback is itself already a rendered node. */
const valNode = (value: string | null | undefined, fallback: ReactNode) => (
  <span>{value && value.trim() ? value : fallback}</span>
)

/**
 * One label-and-value line that disappears when there is nothing to put beside
 * it.
 *
 * A challan is a document that gets filed, signed and sometimes attached to a
 * vehicle, so a row reading "Customer order —" is not a neutral placeholder:
 * it reads as a gap in the record. Same rule as the PDF, and this preview is
 * what the customer is shown before the download.
 */
function Row({ label: text, value }: { label: string; value: string | null | undefined }) {
  if (!value || !value.trim()) return null
  return <><dt>{text}</dt><dd>{value}</dd></>
}

/**
 * The A4 challan, used for both on-screen preview and printing.
 *
 * It is intentionally not styled like the rest of the app: a delivery challan is
 * a document that gets filed, signed and sometimes attached to a vehicle, so it
 * is laid out as a document rather than as an application screen.
 */
export function DcPaper({ bundle, company }: { bundle: DcBundle; company: Company }) {
  const d = bundle.document
  const isInward = d.dc_type === 'inward'
  const hasInspection = isInward && bundle.items.some(i => i.inspection_required)
  // Same gate as the PDF, so what the customer is shown before the download is
  // what the downloaded file contains.
  const hasMachining = d.dc_type === 'outward_customer' && bundle.machining_results.length > 0
  // What the customer signed for at the other end. Rendered only once there is
  // something to sign, so a challan printed at dispatch time is not carrying an
  // empty block that implies the delivery was confirmed and merely not recorded.
  const hasDelivery = d.dc_type === 'outward_customer'
    && Boolean(d.proof_of_delivery_ref || d.receiver_name || d.actual_delivery_at)

  // Every customer DC number this challan touches: the ones on its own lines,
  // and the ones behind the lines it drew from. Always a list, because one
  // inward challan can carry material from several of the customer's own
  // challans.
  //
  // Challans created before the per-line number existed (0026) carry theirs in
  // the header column instead, which nothing writes to any more. Falling back
  // to it is what stops those old records printing with no customer number at
  // all - the data is not discarded, only no longer typed.
  const customerDcNumbers = bundle.customer_dc_numbers?.length
    ? bundle.customer_dc_numbers
    : [...new Set([
      ...bundle.items.flatMap(item =>
        [item.customer_dc_number, item.source_inward_customer_dc_number]
          .filter((value): value is string => Boolean(value && value.trim())),
      ),
      ...(bundle.items.every(item => !item.customer_dc_number && !item.source_inward_customer_dc_number)
        ? [d.external_dc_number ?? '']
        : []),
    ].filter(value => value.trim() !== ''))].sort((a, b) => a.localeCompare(b))

  return (
    <div className="dc-paper">
      <header className="dc-paper-head">
        <div>
          <h1>{company.name}</h1>
          {company.address && <p>{company.address}</p>}
          {company.phone && <p>{company.phone}</p>}
          {company.email && <p>{company.email}</p>}
          {company.gstin && <p className="mono">GSTIN: {company.gstin}</p>}
        </div>
        <div className="dc-paper-title">
          <h2>{DC_TYPE_TITLE[d.dc_type]}</h2>
          <p className="dc-number">{d.dc_number}</p>
          <p>{displayDate(d.dc_date)}</p>
          <p className="dc-status">{d.status.replaceAll('_', ' ')}</p>
          {d.cancelled_at && <p className="dc-cancelled">CANCELLED</p>}
        </div>
      </header>

      <section className="dc-party">
        {label(isInward ? 'RECEIVED FROM' : d.dc_type === 'outward_customer' ? 'DELIVERED TO' : 'DISPATCHED TO')}
        <strong>{d.party_name}</strong>
        {d.party_gstin && <div className="mono">GSTIN: {d.party_gstin}</div>}
        {d.party_contact_person && <div>Contact: {d.party_contact_person}</div>}
        {d.party_phone && <div>{d.party_phone}</div>}
        {d.party_email && <div>{d.party_email}</div>}
        {(d.party_ship_to || d.party_address) && <div>{val(d.party_ship_to ?? d.party_address)}</div>}
        {d.party_pincode && <div>PIN: {d.party_pincode}</div>}
      </section>

      {/* Only what has been recorded. A row reading "Customer order —" tells
          the reader nothing and reads as a gap in the record; a challan is a
          document that gets filed and signed. The same rule governs the PDF, and
          this preview is what the customer is shown before the download. */}
      <section className="dc-references">
        <dl>
          <Row label={d.dc_type === 'inward' ? 'Customer DC no.' : 'Against customer DC'} value={customerDcNumbers.join(', ')} />
          <Row label="Purchase order" value={d.purchase_order_no ?? ''} />
          <Row label="Financial year" value={d.financial_year ?? ''} />
        </dl>
        <dl>
          <Row label="Purpose" value={d.purpose ?? d.movement_type ?? d.delivery_purpose ?? ''} />
          <Row label="Required by" value={d.expected_arrival_at ? new Date(d.expected_arrival_at).toLocaleDateString('en-IN') : ''} />
        </dl>
      </section>

      <table className="dc-items">
        <thead>
          <tr>
            <th>#</th><th>Part number</th><th>Customer DC</th><th>Description</th><th>Drawing</th>
            {/* The receipt quantities the party signs for. Shortage and the
                inspection state stay on the screen and in the receipt summary
                below - neither is mandatory on the paper. */}
            {isInward
              ? <>
                <th className="num">Declared</th>
                <th className="num">Received</th>
                <th className="num">Accepted</th>
                <th className="num">Rejected</th>
              </>
              : <th className="num">Quantity</th>}
            <th>Unit</th>
          </tr>
        </thead>
        <tbody>
          {bundle.items.map((item, index) => (
            <tr key={item.id}>
              <td>{index + 1}</td>
              <td>
                <strong>{item.part_number}</strong>
                {item.customer_part_number && <small>Cust: {item.customer_part_number}</small>}
              </td>
              {/* Which of the customer's own challans this material arrived on.
                  Printed per line on an outward challan too, so the customer can
                  match the delivery against the challans they actually sent. */}
              <td className="mono">{item.customer_dc_number || item.source_inward_customer_dc_number || ''}</td>
              <td>{val(item.description, '')}</td>
              <td>{item.drawing_number ? `${item.drawing_number}${item.drawing_revision ? ` (Rev ${item.drawing_revision})` : ''}` : ''}</td>
              {isInward
                ? <>
                  <td className="num">{qty(item.declared_qty)}</td>
                  <td className="num">{qty(item.received_qty)}</td>
                  <td className="num">{qty(item.accepted_qty)}</td>
                  <td className="num">{qty(item.rejected_qty)}</td>
                </>
                : <td className="num">{qty(item.qty_dispatched)}</td>}
              <td>{item.unit}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {hasInspection && (
        <section className="dc-inspection-summary">
          {label('RECEIPT AND INSPECTION SUMMARY')}
          <table className="dc-items compact">
            <thead>
              <tr>
                <th>Part number</th><th className="num">Received</th><th className="num">Accepted</th>
                <th className="num">Rejected</th><th className="num">Rework</th><th className="num">Pending inspection</th>
              </tr>
            </thead>
            <tbody>
              {bundle.items.map(item => (
                <tr key={item.id}>
                  <td>{item.part_number}</td>
                  <td className="num">{qty(item.received_qty)}</td>
                  <td className="num">{qty(item.accepted_qty)}</td>
                  <td className="num">{qty(item.rejected_qty)}</td>
                  <td className="num">{qty(item.rework_qty)}</td>
                  <td className="num">{qty(item.pending_inspection_qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {hasMachining && (
        <section className="dc-machining-summary">
          {label('Machining and processing results')}
          <table className="dc-items compact">
            <thead>
              <tr>
                <th className="mono">Line</th><th>Part number</th><th>Operation</th><th className="num">Quantity</th>
                <th className="num">Finished</th><th className="num">Rejected</th>
                <th className="num">Rework</th><th className="num">Scrap</th>
                <th className="num">Loss</th><th className="num">Remaining</th>
              </tr>
            </thead>
            <tbody>
              {bundle.machining_results.map(result => (
                <tr key={result.id}>
                <td className="mono">{bundle.items?.find(i => i.id === result.source_dc_item_id)?.line_no ?? '—'}</td>
                  <td>{result.part_number}</td>
                  <td>{result.operation}</td>
                  {/* The unit rides with the quantity: input and output units can
                      differ on a conversion, and rejection, rework, scrap and loss
                      are all input-unit quantities. */}
                  <td className="num">{qty(result.input_quantity)} {result.input_unit}</td>
                  <td className="num">{qty(result.accepted_output_quantity)} {result.output_unit}</td>
                  <td className="num">{qty(result.machining_rejection_quantity)}</td>
                  <td className="num">{qty(result.rework_quantity)}</td>
                  <td className="num">{qty(result.scrap_quantity)}</td>
                  <td className="num">{qty(result.process_loss_quantity)}</td>
                  {/* What had not been machined when the record was made. It is
                      the material still with the customer, and it is why the
                      record did not add up to the whole input. */}
                  <td className="num">{qty(result.remaining_quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="dc-transport">
        {label('TRANSPORT DETAILS')}
        <dl>
          <dt>Mode</dt><dd>{val(d.mode_of_transport)}</dd>
          <dt>Transporter</dt><dd>{val(d.transporter_name)}</dd>
          <dt>Vehicle</dt><dd>{val(d.vehicle_number)}</dd>
          <dt>LR / docket</dt><dd>{valNode(d.lr_number, val(d.docket_number))}</dd>
          <dt>E-way bill</dt><dd>{val(d.eway_bill_number)}</dd>
        </dl>
      </section>

      {hasDelivery && (
        <section className="dc-transport">
          {label('DELIVERY')}
          <dl>
            <dt>Dispatched at</dt><dd>{d.dispatch_at ? new Date(d.dispatch_at).toLocaleString('en-IN') : '—'}</dd>
            <dt>Delivered at</dt><dd>{d.actual_delivery_at ? new Date(d.actual_delivery_at).toLocaleString('en-IN') : '—'}</dd>
            <dt>Proof of delivery</dt><dd>{val(d.proof_of_delivery_ref)}</dd>
            <dt>Received by</dt><dd>{val(d.receiver_name)}</dd>
          </dl>
        </section>
      )}

      {(d.remarks || d.unloading_remarks || d.cancel_reason) && (
        <section className="dc-remarks">
          {d.remarks && <><div>{label('REMARKS')}</div><p>{d.remarks}</p></>}
          {d.unloading_remarks && <><div>{label('UNLOADING REMARKS')}</div><p>{d.unloading_remarks}</p></>}
          {d.cancel_reason && <><div>{label('CANCELLATION')}</div><p>{d.cancel_reason}</p></>}
        </section>
      )}

      <div className="dc-signatures">
        <div>
          <span className="sig-name">{val(d.prepared_by, '')}</span>
          <span className="line" />{label('Prepared by')}
        </div>
        <div>
          <span className="sig-name">{val(d.authorized_by, '')}</span>
          <span className="line" />{label('Authorized by')}
        </div>
        <div>
          {/* Received by stays empty on purpose: the party signs here by hand. */}
          <span className="sig-name" />
          <span className="line" />{label(isInward ? 'Received by (party)' : 'Receiver (party)')}
        </div>
      </div>

      <p className="dc-disclaimer">This is a material movement record, not a tax invoice.</p>
    </div>
  )
}

/** One line's inspection state, used in lists and the item editor. */
export function inspectionBadge(item: DcItem) {
  if (!item.inspection_required) return <span className="status status-neutral">Not required</span>
  if (item.inspection_status === 'accepted') return <span className="status status-success">Accepted</span>
  if (item.inspection_status === 'partially_accepted') return <span className="status status-warning">Partially accepted</span>
  if (item.inspection_status === 'rejected') return <span className="status status-danger">Rejected</span>
  if (item.inspection_status === 'rework_required') return <span className="status status-warning">Rework required</span>
  if (item.inspection_status === 'partially_inspected') return <span className="status status-warning">Partially inspected</span>
  return <span className="status status-neutral">Pending inspection</span>
}