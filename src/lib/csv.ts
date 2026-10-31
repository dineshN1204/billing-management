/**
 * CSV export.
 *
 * Every report and export screen shares this one writer. There were four
 * divergent copies, one of which escaped quotes and three of which did not, and
 * all of which had the same two problems described below.
 */

export type CsvCell = string | number | boolean | null | undefined

/**
 * Neutralises spreadsheet formula injection.
 *
 * A cell beginning with =, +, -, @, tab or carriage return is executed by Excel,
 * LibreOffice and Google Sheets when the file is opened. Customer and supplier
 * names come from OCR'd paper documents and from phone calls, so this app is
 * exactly the kind of application that ingests hostile-looking strings.
 *
 * A leading apostrophe is the spreadsheet's own "treat this as text" marker. It is
 * stripped on display, so the cell still reads correctly to the person.
 */
export function neutralizeFormula(value: string): string {
  return /^[\s]*[=+\-@\t\r]/.test(value) ? `'${value}` : value
}

/** Quotes and escapes one cell, including the formula guard. */
export function csvCell(value: CsvCell): string {
  const text = value === null || value === undefined ? '' : String(value)
  return `"${neutralizeFormula(text).replace(/"/g, '""')}"`
}

/** Builds a CSV document from a header row and a body. */
export function buildCsv(headers: string[], rows: CsvCell[][]): string {
  return [headers.map(csvCell).join(','), ...rows.map(row => row.map(csvCell).join(','))].join('\r\n')
}

/**
 * Downloads a CSV.
 *
 * The anchor is appended to the document and the object URL is released on the
 * next tick. Revoking it synchronously right after `click()` cancels the download
 * in some browsers, and an anchor that was never attached does not always
 * receive the click at all.
 *
 * A UTF-8 BOM is written so Excel on Windows reads the rupee symbol and
 * non-Latin names correctly instead of showing mojibake.
 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** Builds and downloads in one step. Does nothing when there is no data. */
export function exportCsv(filename: string, headers: string[], rows: CsvCell[][]): boolean {
  if (!rows.length) return false
  downloadCsv(filename, buildCsv(headers, rows))
  return true
}