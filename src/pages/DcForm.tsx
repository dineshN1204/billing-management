import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Link2, Save, Send } from 'lucide-react'
import { Button, Card, Field, Loading, PageTitle, SelectField, TextArea } from '../components/ui'
import { DcItemEditor } from '../components/DcItemEditor'
import { DcPartyPicker } from '../components/DcPartyPicker'
import { useAuth } from '../lib/auth'
import { dcApi, loadDcBundle, optionValue } from '../lib/dc-api'
import { DC_TYPE_DESCRIPTION, DC_TYPE_LABEL, draftFromItem, emptyItem, type DcBundle, type DcInwardLine, type DcItemDraft, type DcType } from '../lib/dc-types'
import { explainError, today } from '../lib/format'
import { firstLineWithoutQuantity, parseQty, qty } from '../lib/dc-quantities'
import { db } from '../lib/db'
import { settle } from '../lib/async'
import type { Customer, Product } from '../lib/types'

type Party = Pick<Customer, 'id' | 'name' | 'gstin' | 'party_type'>

type Form = {
  dc_date: string
  party_id: string
  purpose: string
  receipt_type: string
  movement_type: string
  delivery_purpose: string
  external_dc_number: string
  external_dc_date: string
  external_notes: string
  purchase_order_no: string
  customer_order_reference: string
  delivery_schedule_reference: string
  mode_of_transport: string
  transporter_name: string
  vehicle_number: string
  driver_name: string
  driver_contact: string
  lr_number: string
  docket_number: string
  eway_bill_number: string
  package_count: string
  expected_arrival_at: string
  remarks: string
  prepared_by: string
  authorized_by: string
  /**
   * The inward challan this one answers.
   *
   * It is not typed by hand: it is set when the outward challan is opened from
   * an inward one, and it is what makes the outward challan take the same
   * serial as the inward (migration 0035). Kept in the form so that saving a
   * draft cannot quietly detach the two documents from each other.
   */
  reference_inward_dc_id: string
}

const blank = (): Form => ({
  dc_date: today(),
  party_id: '',
  purpose: '',
  receipt_type: '',
  movement_type: '',
  delivery_purpose: '',
  external_dc_number: '',
  external_dc_date: '',
  external_notes: '',
  purchase_order_no: '',
  customer_order_reference: '',
  delivery_schedule_reference: '',
  mode_of_transport: '',
  transporter_name: '',
  vehicle_number: '',
  driver_name: '',
  driver_contact: '',
  lr_number: '',
  docket_number: '',
  eway_bill_number: '',
  package_count: '',
  expected_arrival_at: '',
  remarks: '',
  prepared_by: '',
  authorized_by: '',
  reference_inward_dc_id: '',
})

/** Which party types make sense for each document type. */
const PARTY_TYPES: Record<DcType, string[]> = {
  inward: ['customer', 'supplier', 'vendor', 'other'],
  outward_customer: ['customer'],
  material_return: ['customer', 'supplier', 'vendor', 'other'],
}

export function DcForm({ dcType }: { dcType: DcType }) {
  const { id } = useParams()
  const [params] = useSearchParams()
  const { organization } = useAuth()
  const navigate = useNavigate()

  const [form, setForm] = useState<Form>(blank)
  const [party, setParty] = useState<Party | null>(null)
  const [items, setItems] = useState<DcItemDraft[]>([emptyItem()])
  const [options, setOptions] = useState<Record<string, string[]>>({})
  const [productMatches, setProductMatches] = useState<Record<string, Product[]>>({})
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(Boolean(id))
  const [error, setError] = useState('')
  // Row version of the challan being edited, sent back as expected_version so a
  // concurrent edit is refused instead of silently overwritten.
  const [version, setVersion] = useState<number | null>(null)
  // Which line's quantity the form refused, plus a nonce so pressing Save again
  // on the same line still re-runs the focus effect inside the line editor.
  const [qtyIssue, setQtyIssue] = useState<{ index: number; seq: number } | null>(null)
  // The inward lines of this customer that still have material to give, for the
  // outward challan to be built from. Only loaded once a customer is chosen,
  // because it is scoped to them.
  const [inwardLines, setInwardLines] = useState<DcInwardLine[]>([])
  const [sourceQuery, setSourceQuery] = useState('')
  const [sourcesLoading, setSourcesLoading] = useState(false)
  // Off by default. A line still awaiting inspection is legitimate material and
  // the operator may well want it on the challan now; the filter is a way to
  // narrow the list to what is finished, not a gate on what can be chosen.
  const [readyOnly, setReadyOnly] = useState(false)
  // The number of the inward challan this outward challan answers, shown so the
  // operator can see the link before the number is issued on the first save.
  const [referenceInwardNumber, setReferenceInwardNumber] = useState('')
  // True when the lines come from more than one inward challan, which means
  // there is no single inward to answer and the outward number stands alone.
  const [mixedSources, setMixedSources] = useState(false)
  const searchTimer = useRef(0)
  const sourceTimer = useRef(0)

  const title = DC_TYPE_LABEL[dcType]
  const listPath = dcType === 'inward' ? '/dc/inward' : '/dc/outward'

  // Seed option lists once, then load them for the pickers.
  useEffect(() => {
    if (!organization) return
    let active = true
    void (async () => {
      try {
        await dcApi.bootstrapOptions()
        const rows = await dcApi.options(organization.id)
        if (!active) return
        const grouped: Record<string, string[]> = {}
        for (const row of rows) (grouped[row.option_group] ??= []).push(row.option_value)
        setOptions(grouped)
      } catch (cause) {
        if (active) setError(explainError(cause, 'Could not load DC options.'))
      }
    })()
    return () => { active = false }
  }, [organization])


  useEffect(() => {
    if (!organization) return
    const preset = params.get('party')
    if (preset) {
      // The error was discarded here, so a stale or wrong ?party= link left the
      // picker silently empty with no explanation.
      void settle(() => db.from('customers').select('id,name,gstin,party_type').eq('id', preset)
        .eq('organization_id', organization.id).single()).then(result => {
          if (!result.ok) { setError(explainError(result.error, 'Could not open the requested party.')); return }
          if (result.value.error) { setError(explainError(result.value.error, 'Could not open the requested party.')); return }
          if (result.value.data) { setParty(result.value.data as Party); setForm(f => ({ ...f, party_id: preset })) }
          else setError('That party could not be found. Choose one from the list.')
        })
    }
  }, [organization, params])

  /**
   * Opened from an inward challan: /dc/outward/new?fromInward=<id>.
   *
   * This is the job-work flow in one click. The customer is taken from the
   * inward challan, every line that still has material on it is brought over
   * with the customer's own challan numbers attached, and the inward challan
   * is named as the reference - which is what makes the outward challan take
   * the same serial (migration 0035).
   *
   * The lines are added at their available quantity. The database still caps
   * the dispatch at what is left of each inward line, so a number typed here
   * can never move more than the customer actually sent.
   */
  useEffect(() => {
    const fromInward = params.get('fromInward')
    if (!organization || !fromInward || id || dcType !== 'outward_customer') return
    let active = true
    void (async () => {
      const head = await settle(() => loadDcBundle(fromInward, organization.id))
      if (!active) return
      if (!head.ok) { setError(explainError(head.error, 'Could not open the inward challan.')); return }
      const inward = head.value.bundle?.document
      if (!inward) { setError('That inward challan could not be found.'); return }
      setParty({ id: inward.party_id, name: inward.party_name, gstin: inward.party_gstin, party_type: inward.party_type })
      setForm(old => ({ ...old, party_id: inward.party_id, reference_inward_dc_id: inward.id }))
      setReferenceInwardNumber(inward.dc_number)
      const lines = await settle(() => dcApi.inwardLines(organization.id, inward.party_id))
      if (!active) return
      if (!lines.ok) { setError(explainError(lines.error, 'Could not load the lines of that inward challan.')); return }
      const mine = lines.value.filter(line => line.inward_dc_id === inward.id)
      if (mine.length) {
        // The form always starts with one blank line. Opened from an inward
        // challan that blank is dropped first: the lines below come from that
        // challan, and the empty row above them had nothing to fill in.
        setItems([])
        for (const line of mine) {
          if (!active) return
          addFromSource(line)
        }
      } else {
        setError(`Every line of ${inward.dc_number} has already been dispatched or rejected. There is nothing left to send back.`)
      }
    })()
    return () => { active = false }
  }, [organization, params, id, dcType])

  useEffect(() => {
    if (!id || !organization) return
    let active = true
    setLoading(true)
    setError('')
    void (async () => {
      // settle(), not a bare await: a rejected read used to skip setLoading(false)
      // entirely and leave this form spinning until the page was refreshed.
      const head = await settle(() => db.from('dc_documents').select('*').eq('id', id).eq('organization_id', organization.id).single())
      if (!active) return
      if (!head.ok) { setError(explainError(head.error, 'Could not load the challan.')); setLoading(false); return }
      if (head.value.error) { setError(explainError(head.value.error, 'Could not load the challan.')); setLoading(false); return }
      const data = head.value.data
      if (!data) { setError('Delivery challan not found.'); setLoading(false); return }
      const doc = data as unknown as Record<string, string | null>
      setVersion(typeof (data as { version?: unknown }).version === 'number' ? (data as { version: number }).version : null)
      setForm({
        dc_date: doc.dc_date ?? today(),
        party_id: doc.party_id ?? '',
        purpose: doc.purpose ?? '',
        receipt_type: doc.receipt_type ?? '',
        movement_type: doc.movement_type ?? '',
        delivery_purpose: doc.delivery_purpose ?? '',
        external_dc_number: doc.external_dc_number ?? '',
        external_dc_date: doc.external_dc_date ?? '',
        external_notes: doc.external_notes ?? '',
        purchase_order_no: doc.purchase_order_no ?? '',
        customer_order_reference: doc.customer_order_reference ?? '',
        delivery_schedule_reference: doc.delivery_schedule_reference ?? '',
        mode_of_transport: doc.mode_of_transport ?? '',
        transporter_name: doc.transporter_name ?? '',
        vehicle_number: doc.vehicle_number ?? '',
        driver_name: doc.driver_name ?? '',
        driver_contact: doc.driver_contact ?? '',
        lr_number: doc.lr_number ?? '',
        docket_number: doc.docket_number ?? '',
        eway_bill_number: doc.eway_bill_number ?? '',
        package_count: doc.package_count === null ? '' : String(doc.package_count),
        expected_arrival_at: doc.expected_arrival_at ?? '',
        remarks: doc.remarks ?? '',
        prepared_by: doc.prepared_by ?? '',
        authorized_by: doc.authorized_by ?? '',
        reference_inward_dc_id: doc.reference_inward_dc_id ?? '',
      })
      if (doc.party_id && typeof doc.party_id === 'string') {
        const partyId = doc.party_id
        // Scoped to the organization like every other party read. Without the
        // filter this one query relied on RLS alone to return a row.
        const owner = await settle(() => db.from('customers').select('id,name,gstin,party_type')
          .eq('id', partyId).eq('organization_id', organization.id).single())
        if (active && owner.ok) {
          const row = owner.value as { data?: unknown; error?: unknown }
          if (!row.error && row.data) setParty(row.data as Party)
        }
      }
      // The inward challan this one answers, for the read-only field above.
      if (doc.reference_inward_dc_id && typeof doc.reference_inward_dc_id === 'string') {
        const inwardId = doc.reference_inward_dc_id
        const ref = await settle(() => db.from('dc_documents').select('dc_number')
          .eq('id', inwardId).eq('organization_id', organization.id).maybeSingle())
        if (active && ref.ok) {
          const row = ref.value as { data?: { dc_number?: string } | null }
          if (row.data?.dc_number) setReferenceInwardNumber(row.data.dc_number)
        }
      }
      const lines = await settle(() => db.from('dc_items').select('*').eq('dc_id', id).eq('organization_id', organization.id).order('line_no'))
      if (!active) return
      if (!lines.ok) { setError(explainError(lines.error, 'Could not load the challan lines.')); setLoading(false); return }
      if (lines.value.error) { setError(explainError(lines.value.error, 'Could not load the challan lines.')); setLoading(false); return }
      if (lines.value.data?.length) setItems(lines.value.data.map(draftFromItem as never) as DcItemDraft[])
      setLoading(false)
    })()
    return () => { active = false }
  }, [id, organization])

  /**
   * The inward challan this one answers, worked out from the lines.
   *
   * When every line is drawn from one inward challan, that is the challan
   * this one answers, and it is what makes the outward number the same serial
   * (migration 0035). When the lines come from two different inward challans
   * there is no single one to answer, so the reference is dropped and the
   * challan takes its own number from the outward sequence.
   *
   * The reference is worked out rather than typed, so it cannot say one thing
   * while the lines say another - and the database refuses a save where the
   * two disagree.
   */
  useEffect(() => {
    const sources = new Map<string, string>()
    for (const item of items) {
      if (!item.source_inward_item_id) continue
      const line = inwardLines.find(candidate => candidate.item_id === item.source_inward_item_id)
      if (line) sources.set(line.inward_dc_id, line.inward_dc_number)
    }
    if (sources.size === 1) {
      const [id, number] = [...sources.entries()][0]!
      setForm(old => old.reference_inward_dc_id === id ? old : { ...old, reference_inward_dc_id: id })
      setReferenceInwardNumber(number)
      setMixedSources(false)
    } else if (sources.size > 1) {
      setForm(old => old.reference_inward_dc_id === '' ? old : { ...old, reference_inward_dc_id: '' })
      setReferenceInwardNumber('')
      setMixedSources(true)
    }
  }, [items, inwardLines])

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm(old => ({ ...old, [key]: value }))
  }

  // Inward lines available to draw from, refetched when the customer or the
  // search term changes. Only an outward challan needs this: an inward challan
  // is where the customer's material is recorded, not where it is drawn from.
  useEffect(() => {
    if (!organization || dcType !== 'outward_customer' || !party) {
      setInwardLines([])
      return
    }
    let active = true
    window.clearTimeout(sourceTimer.current)
    sourceTimer.current = window.setTimeout(() => {
      setSourcesLoading(true)
      void settle(() => dcApi.inwardLines(organization.id, party.id, sourceQuery))
        .then(result => {
          if (!active) return
          setSourcesLoading(false)
          if (!result.ok) { setError(explainError(result.error, 'Could not load the inward challans for this customer.')); return }
          setInwardLines(result.value)
        })
    }, sourceQuery.trim() ? 250 : 0)
    return () => { active = false }
  }, [organization, dcType, party, sourceQuery])

  // A line already used as a source cannot be used twice on one challan; the
  // figure would then be offered twice and the second dispatch would be refused
  // by the database for a reason the form did not show.
  const alreadyLinked = useMemo(
    () => new Set(items.map(item => item.source_inward_item_id).filter((id): id is string => Boolean(id))),
    [items],
  )

  const sourceLabels = useMemo(() => Object.fromEntries(inwardLines.map(line => [
    line.item_id,
    `${line.inward_dc_number}${line.customer_dc_number ? ` · ${line.customer_dc_number}` : ''} · line ${line.line_no}`,
  ])), [inwardLines])

  const shownLines = useMemo(
    () => readyOnly ? inwardLines.filter(line => line.fully_inspected) : inwardLines,
    [inwardLines, readyOnly],
  )

  /**
   * The customer DC numbers this outward challan will print.
   *
   * Taken from the inward lines the lines were drawn from, which is the only
   * place the fact exists. A line of our own finished stock contributes
   * nothing, so a mixed challan names only the customer DCs its material
   * actually arrived on.
   */
  const customerDcPreview = useMemo(() => {
    const numbers = new Set<string>()
    for (const item of items) {
      const source = item.source_inward_item_id
        ? inwardLines.find(line => line.item_id === item.source_inward_item_id)
        : undefined
      if (source?.customer_dc_number) numbers.add(source.customer_dc_number)
    }
    return [...numbers].sort((a, b) => a.localeCompare(b))
  }, [items, inwardLines])

  /**
   * Turns a picked inward line into an outward line.
   *
   * The part, drawing and unit come across unchanged, because the material
   * leaving is the material that arrived under the same part and drawing. The
   * quantity defaults to everything still available on that inward line, which
   * is what dispatch will be capped at.
   */
  function addFromSource(line: DcInwardLine) {
    setItems(old => {
      if (old.some(item => item.source_inward_item_id === line.item_id)) return old
      const draft = emptyItem()
      return [...old, {
        ...draft,
        part_number: line.part_number,
        customer_part_number: line.customer_part_number ?? '',
        customer_dc_number: line.customer_dc_number ?? '',
        drawing_number: line.drawing_number ?? '',
        drawing_revision: line.drawing_revision ?? '',
        description: line.part_number,
        batch_lot_no: line.batch_lot_no ?? '',
        unit: line.unit,
        supply_source: 'customer_material',
        declared_qty: String(line.available_qty),
        source_inward_item_id: line.item_id,
      }]
    })
  }

  function searchProducts(index: number, term: string) {
    if (!organization || term.trim().length < 2) return
    window.clearTimeout(searchTimer.current)
    searchTimer.current = window.setTimeout(async () => {
      const { data } = await db.from('products').select('*').eq('organization_id', organization.id)
        .is('deleted_at', null).ilike('name', `%${term.replace(/[\\%_]/g, '\\$&')}%`).limit(6)
      setProductMatches(old => ({ ...old, [`${index}:${term}`]: (data ?? []) as Product[] }))
    }, 220)
  }

  function pickProduct(index: number, product: Product) {
    setItems(old => old.map((item, i) => (i === index
      ? {
        ...item,
        product_id: product.id,
        part_number: product.product_code || product.name,
        description: product.description ?? item.description,
        unit: product.unit || item.unit,
      }
      : item)))
  }

  function matchesFor(index: number) {
    const key = `${index}:${items[index]?.part_number ?? ''}`
    return productMatches[key] ?? []
  }

  async function save(finalize: boolean) {
    if (!organization || busy) return
    if (!party) { setError('Select a party first.'); return }
    if (items.some(item => !item.part_number.trim())) { setError('Every line needs a part number.'); return }

    // A quantity of zero (or blank) is never a valid line. Refuse the save and
    // take the operator to the field that needs fixing.
    const badLine = firstLineWithoutQuantity(items)
    if (badLine >= 0) {
      setError(`Line ${badLine + 1}: Quantity must be greater than 0.`)
      setQtyIssue(previous => ({ index: badLine, seq: (previous?.seq ?? 0) + 1 }))
      return
    }

    setBusy(true); setError('')
    try {
      const payload = {
        ...form,
        dc_id: id ?? null,
        party_id: party.id,
        finalize,
        // Optimistic concurrency. Without this the RPC's VERSION_CONFLICT guard
        // can never fire (0018 skips the check when the value is null), so two
        // people editing the same draft silently overwrote each other.
        ...(id && version !== null ? { expected_version: version } : {}),
        expected_arrival_at: form.expected_arrival_at || null,
        external_dc_date: form.external_dc_date || null,
        package_count: form.package_count || null,
        items: items.map(item => ({
          product_id: item.product_id,
          part_number: item.part_number.trim(),

          customer_part_number: item.customer_part_number || null,

          // Which of the customer's own challans this material arrived on. One
          // inward challan of ours can carry several of theirs, so it lives on
          // the line rather than on the header.
          customer_dc_number: item.customer_dc_number || null,

          // Which inward line this outward line is made from. Null for finished
          // stock we hold ourselves, which has no inward material behind it.
          source_inward_item_id: item.source_inward_item_id || null,

          description: item.description || null,
          drawing_number: item.drawing_number || null,

          drawing_revision: item.drawing_revision || null,
          batch_lot_no: item.batch_lot_no || null,


          // These three were carried by the form and then dropped on save. Since
          // the RPC deletes and re-inserts every line, opening a draft for editing
          // and saving it silently erased the heat number, the material grade and
          // the ordered quantity.
          heat_no: item.heat_no || null,
          material_grade: item.material_grade || null,
          ordered_qty: item.ordered_qty === '' ? null : Number(item.ordered_qty),

          unit: item.unit,

          supply_source: item.supply_source,

          declared_qty: item.declared_qty || 0,

          processing_operation: item.processing_operation || null,
          material_owner_id: item.material_owner_id || null,
          item_remarks: item.item_remarks || null,
        })),
      }

      const save = dcType === 'inward' ? dcApi.saveInward : dcApi.saveOutwardCustomer
      const bundle: DcBundle = await save(organization.id, payload)
      navigate(`/dc/${bundle.document.dc_type === 'inward' ? 'inward' : 'outward'}/${bundle.document.id}`)
    } catch (cause) {
      // explainError, not friendlyError: a cause that no rule recognises used to
      // collapse into "the request could not be completed", which told the person
      // filling in the challan nothing at all about what had actually gone wrong.
      setError(explainError(cause, 'Could not save the challan.'))
    } finally {
      setBusy(false)
    }
  }

  const units = useMemo(() => (options.unit?.length ? options.unit : ['NOS', 'Kg', 'Meter']), [options])

  if (loading || !organization) return <Loading label="Loading challan..." />

  return (
    <>
      <div className="no-print">
        <Link className="back-link" to={listPath}><ArrowLeft size={16} /> {DC_TYPE_LABEL[dcType]}s</Link>
        <PageTitle
          eyebrow={id ? 'EDIT CHALLAN' : 'NEW CHALLAN'}
          title={id ? `Edit ${form.external_dc_number || 'challan'}` : title}
          description={DC_TYPE_DESCRIPTION[dcType]}
          action={
            <div className="inline-actions">
              <Button variant="secondary" disabled={busy || organization?.role === 'viewer'} onClick={() => void save(false)}>
                <Save size={16} /> Save draft
              </Button>
              <Button disabled={busy || organization?.role === 'viewer'} onClick={() => void save(true)}>
                <Send size={16} /> Finalize
              </Button>
            </div>
          }
        />
      </div>

      {error && <p role="alert" className="error-box no-print">{error}</p>}

      <div className="dc-form no-print">
        <Card>
          <h2>DC information</h2>
          <div className="field-grid">
            <Field label="DC date" type="date" required value={form.dc_date} onChange={e => set('dc_date', e.target.value)} />
            {/* The header-level customer DC number is gone. One inward challan
                can carry material from several of the customer's own challans,
                so the number belongs on the line - where it also drives the
                outward challan and the search. dc_documents.external_dc_number
                still holds whatever was recorded before this, and is read as a
                fallback when printing a challan whose lines carry none, so no
                old record loses its number. */}
            {dcType === 'outward_customer' && (
              <>
                <Field label="Customer purchase order" value={form.customer_order_reference} onChange={e => set('customer_order_reference', e.target.value)} />
                <Field label="Schedule / delivery reference" value={form.delivery_schedule_reference} onChange={e => set('delivery_schedule_reference', e.target.value)} />
              </>
            )}
            {/* The inward challan this one answers. It is not typed by hand: it
                is worked out from the lines, and it decides the outward number
                (migration 0035). Shown read-only so the link is visible on the
                form and printed on the challan. */}
            {dcType === 'outward_customer' && form.reference_inward_dc_id && (
              <Field
                label="Answers inward challan"
                value={referenceInwardNumber || 'Loading...'}
                readOnly
                hint="This outward challan takes the same serial as the inward one."
              />
            )}
            {dcType === 'outward_customer' && mixedSources && (
              <p className="muted">
                These lines come from more than one inward challan, so this challan does not answer
                any single one of them and takes its own number.
              </p>
            )}
            {dcType === 'inward' && (
              <SelectField label="Material receipt type" value={form.receipt_type} onChange={e => set('receipt_type', e.target.value)}>
                <option value="">Not specified</option>
                {(options.receipt_type ?? [])
                  // Retired option: 'Customer Owned Component' can no longer be picked on a new
                  // challan, but an existing one that already holds it keeps showing its own value.
                  .filter(v => optionValue('receipt_type', v) !== 'customer_owned' || form.receipt_type === 'customer_owned')
                  .map(v => <option key={v} value={optionValue('receipt_type', v)}>{v}</option>)}
              </SelectField>
            )}

            {dcType === 'outward_customer' && (
              <SelectField label="Delivery purpose" value={form.delivery_purpose} onChange={e => set('delivery_purpose', e.target.value)}>
                <option value="">Not specified</option>
                {(options.delivery_purpose ?? []).map(v => <option key={v} value={optionValue('delivery_purpose', v)}>{v}</option>)}
              </SelectField>
            )}
            <Field label="Purchase order reference" value={form.purchase_order_no} onChange={e => set('purchase_order_no', e.target.value)} />
            <Field label="Purpose / remarks" value={form.purpose} onChange={e => set('purpose', e.target.value)} />
          </div>
          {dcType === 'inward' && (
            <TextArea label="Notes from the customer DC" value={form.external_notes} onChange={e => set('external_notes', e.target.value)} rows={2} />
          )}
        </Card>

        <Card>
          <h2>{dcType === 'outward_customer' ? 'Customer' : 'Customer or supplier'}</h2>
          <DcPartyPicker
            organizationId={organization.id}
            value={party}
            onChange={p => { setParty(p); set('party_id', p?.id ?? '') }}
            partyTypes={PARTY_TYPES[dcType]}
            label="Party"
            hint="Details are taken from the customer record and frozen on this challan when it is finalized."
          />
          {party && (
            <dl className="detail-list">
              <dt>GSTIN</dt><dd className="mono">{party.gstin || 'Not recorded'}</dd>
              <dt>Type</dt><dd>{party.party_type}</dd>
            </dl>
          )}
        </Card>

        <Card>
          <h2>Mode of transport</h2>
          <div className="field-grid">
            <SelectField label="Mode of transport" value={form.mode_of_transport} onChange={e => set('mode_of_transport', e.target.value)}>
              <option value="">Not specified</option>
              {(options.mot ?? []).map(v => <option key={v} value={v}>{v}</option>)}
            </SelectField>
            <Field label="Transporter" value={form.transporter_name} onChange={e => set('transporter_name', e.target.value)} />
            <Field label="Vehicle number" value={form.vehicle_number} onChange={e => set('vehicle_number', e.target.value)} />
            <Field label="Driver" value={form.driver_name} onChange={e => set('driver_name', e.target.value)} />
            <Field label="Driver contact" value={form.driver_contact} onChange={e => set('driver_contact', e.target.value)} />
            <Field label="LR / lorry receipt" value={form.lr_number} onChange={e => set('lr_number', e.target.value)} />
            <Field label="Docket number" value={form.docket_number} onChange={e => set('docket_number', e.target.value)} />
            <Field label="E-way bill" value={form.eway_bill_number} onChange={e => set('eway_bill_number', e.target.value)} />
            <Field label="Number of packages" type="number" min="0" step="0.001" value={form.package_count} onChange={e => set('package_count', e.target.value)} />
            {/* Expected arrival was dropped from the form. expected_arrival_at stays in the form
                state so re-saving an existing draft keeps whatever value it already has. */}
          </div>
          <p className="muted">Transport details that do not apply can be left blank.</p>
        </Card>

        {dcType === 'outward_customer' && party && (
          <Card>
            <h2>Against inward challans</h2>
            <p className="muted">
              Pick the inward lines this delivery is made from. A line can only be used once, and only
              what is left of it can be dispatched &mdash; accepted, less machining rejection, less
              anything already sent back.
            </p>
            <Field
              label="Search"
              value={sourceQuery}
              onChange={e => setSourceQuery(e.target.value)}
              hint="Part number, drawing, our inward number or the customer's DC number"
            />
            {sourcesLoading && <p className="muted">Loading inward lines...</p>}
            {!sourcesLoading && inwardLines.length === 0 && (
              <p className="muted">
                Nothing left to dispatch from this customer. Accepted material appears here once it
                has been inspected on an inward challan.
              </p>
            )}
            {inwardLines.length > 0 && (
              <>
                <label className="inline-control">
                  <input
                    type="checkbox"
                    checked={readyOnly}
                    onChange={e => setReadyOnly(e.target.checked)}
                  />
                  Show only fully received and inspected
                </label>
                {readyOnly && shownLines.length === 0 && (
                  <p className="muted">
                    Nothing is fully inspected yet. Every line still has material awaiting a
                    decision on the inward challan.
                  </p>
                )}
                {shownLines.length > 0 && (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Inward DC</th><th>Customer DC</th><th>Line</th><th>Part</th><th>Drawing</th>
                      <th className="num">Accepted</th>
                      <th className="num">Machining rej.</th>
                      <th className="num">Sent back</th>
                      <th className="num">Available</th>
                      <th>Inspection</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {shownLines.map(line => {
                      const used = alreadyLinked.has(line.item_id)
                      // A line with material still awaiting a decision is shown,
                      // marked, and offered - not hidden. Silently omitting it
                      // reads as though the inward challan had no such line, and
                      // the operator has no way to tell "not inspected yet" from
                      // "not there". What can actually be sent back is the
                      // accepted quantity, which is on the row either way.
                      const waiting = parseQty(String(line.pending_inspection_qty ?? 0)) > 0
                      return (
                        <tr key={line.item_id} className={used || waiting ? 'row-dim' : undefined}>
                          <td><span className="table-primary">{line.inward_dc_number}</span></td>
                          <td className="mono">{line.customer_dc_number || '—'}</td>
                          <td className="num">{line.line_no}</td>
                          <td>{line.part_number}</td>
                          <td>{line.drawing_number ? `${line.drawing_number}${line.drawing_revision ? ` rev ${line.drawing_revision}` : ''}` : '—'}</td>
                          <td className="num">{qty(line.accepted_qty)}</td>
                          <td className="num">{qty(line.machining_rejection_qty)}</td>
                          <td className="num">{qty(line.dispatched_qty)}</td>
                          <td className="num strong">{qty(line.available_qty)} {line.unit}</td>
                          <td>
                            {waiting
                              ? <span className="muted">{qty(line.pending_inspection_qty)} {line.unit} awaiting inspection</span>
                              : <span>Fully inspected</span>}
                          </td>
                          <td>
                            <Button
                              variant="secondary"
                              disabled={used}
                              onClick={() => addFromSource(line)}
                              aria-label={`Add ${line.part_number} from ${line.inward_dc_number} line ${line.line_no}`}
                            >
                              <Link2 size={15} /> {used ? 'Added' : 'Add'}
                            </Button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
                )}
              </>
            )}
            <p className="muted">
              A line with no inward material behind it &mdash; finished stock you hold yourself &mdash; is
              added with <strong>Add line</strong> below and left unlinked.
            </p>
          </Card>
        )}

        <Card>
          <h2>Material details</h2>
          <DcItemEditor
            items={items}
            onChange={next => { setItems(next); setQtyIssue(null) }}
            quantityIssue={qtyIssue}
            dcType={dcType}
            party={party}
            units={units}
            sourceLabels={sourceLabels}
            onProductSearch={searchProducts}
            productMatches={matchesFor}
            onPickProduct={pickProduct}
          />
          {dcType === 'outward_customer' && customerDcPreview.length > 0 && (
            <p className="muted dc-hint">
              <strong>Against customer DC{customerDcPreview.length === 1 ? '' : 's'}:</strong>{' '}
              {customerDcPreview.join(', ')}
            </p>
          )}
        </Card>

        <Card>
          <h2>Authorization</h2>
          <div className="field-grid">
            <Field label="Prepared by" value={form.prepared_by} onChange={e => set('prepared_by', e.target.value)} />
            <Field label="Authorized by" value={form.authorized_by} onChange={e => set('authorized_by', e.target.value)} />
          </div>
          <TextArea label="Remarks" value={form.remarks} onChange={e => set('remarks', e.target.value)} rows={3} />
          <p className="muted">Finalizing reserves the document number and freezes the party details as they stand today.</p>
        </Card>
      </div>
    </>
  )
}