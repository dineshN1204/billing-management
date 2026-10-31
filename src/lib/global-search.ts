import { challanPath } from './navigation'
import type { DcSearchHit } from './dc-types'

/**
 * A challan hit in the search dropdown.
 *
 * `dc_search` reports which identifier matched, so a hit that appeared for no
 * visible reason can say which one it was - "customer DC number", "part number"
 * and so on. Without it, a row that surfaced from a part number looks identical
 * to one that surfaced from the number the user typed.
 */
export type DcHit = Pick<DcSearchHit,
  'id' | 'dc_number' | 'dc_type' | 'dc_date' | 'status' | 'party_name' | 'customer_dc_numbers' | 'matched_on'>

export type SearchHits = {
  dcs: DcHit[]
  customers: Array<{ id: string }>
  bills: Array<{ id: string }>
  products: Array<{ id: string }>
}

/**
 * Orders challan hits so the one the term actually names comes first.
 *
 * The query matches on a substring, so "0042" finds IN-2025-0042 and
 * OUT-2025-00420 alike, ordered by date. Someone typing a number they were
 * handed is asking for one document, and leaving it second in the list reads as
 * though it is missing. An exact match wins, then a prefix match, then
 * everything else in the order the database returned.
 */
export function rankDcs(query: string, hits: DcHit[]): DcHit[] {
  const term = query.trim().toLowerCase()
  if (!term) return hits
  const rank = (hit: DcHit): number => {
    const number = hit.dc_number.trim().toLowerCase()
    if (number === term) return 0
    if (number.startsWith(term)) return 1
    if (number.includes(term)) return 2
    // The customer's own challan number. Someone quoting the number on their
    // own paperwork wants the challan it names, and it belongs above any row
    // that merely contains the term somewhere else.
    const customerNumbers = (hit.customer_dc_numbers ?? []).map(value => value.trim().toLowerCase())
    if (customerNumbers.includes(term)) return 1
    if (customerNumbers.some(value => value.startsWith(term))) return 2
    return 3
  }
  return [...hits].sort((a, b) => rank(a) - rank(b))
}

/**
 * Where the Enter key goes: the single row the typed term most likely meant.
 *
 * Pressing Enter used to open the first customer, which was the right answer
 * only while the search box knew about customers, bills and products. Now that a
 * DC number is searched too, a storekeeper typing "IN-0042" and hitting Enter
 * expected that challan and got nothing, because a customer name never contains
 * a DC number and there was no customer to open.
 *
 * A challan leads for two reasons. An exact number match is unambiguous - it is
 * the row the user asked for by name. A looser match still wins over a customer,
 * because a DC number contains digits and separators that a company name does
 * not, so a challan only matches the term at all when the term is its number.
 */
export function firstSearchTarget(query: string, hits: SearchHits): string | null {
  const dc = rankDcs(query, hits.dcs)[0]
  if (dc) return challanPath(dc.id, dc.dc_type)
  if (hits.customers[0]) return `/customers/${hits.customers[0].id}`
  if (hits.bills[0]) return `/bills/${hits.bills[0].id}`
  if (hits.products[0]) return `/products/${hits.products[0].id}`
  return null
}
