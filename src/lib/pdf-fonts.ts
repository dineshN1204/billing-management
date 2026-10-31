/**
 * DM Sans, registered with pdfmake so the PDF uses the exact same typeface the
 * on-screen print preview does.
 *
 * pdfmake's font engine (fontkit, bundled inside its UMD build) understands
 * WOFF, and Vite's `?inline` query inlines the font as a base64 data URL at
 * build time, so generating a PDF needs no runtime fetch and no separate HTTP
 * cache miss. The same files are referenced by `@font-face` in style.css, which
 * is what keeps the screen, the browser printout and the downloaded PDF from
 * ever disagreeing on the typeface.
 */
export const PDF_FONT_FAMILY = 'DMSans'

type PdfMakeLike = {
  addVirtualFileSystem: (vfs: Record<string, string>) => void
  addFonts: (fonts: Record<string, Record<string, string>>) => void
}

/** A Vite `?inline` import is a `data:font/woff;base64,<bytes>` string. */
const toBase64 = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(',') + 1)

/**
 * Installs DM Sans into a pdfmake instance. Idempotent per document-build: the
 * engine caches fonts, so registering once per `createPdf` call is enough.
 */
export async function registerPdfFonts(pdfmake: PdfMakeLike): Promise<void> {
  const [regular, bold] = await Promise.all([
    import('../assets/fonts/DMSans-Regular.woff?inline').then(m => toBase64(m.default)),
    import('../assets/fonts/DMSans-Bold.woff?inline').then(m => toBase64(m.default)),
  ])
  pdfmake.addVirtualFileSystem({
    'DMSans-Regular.woff': regular,
    'DMSans-Bold.woff': bold,
  })
  pdfmake.addFonts({
    DMSans: {
      normal: 'DMSans-Regular.woff',
      bold: 'DMSans-Bold.woff',
      italics: 'DMSans-Regular.woff',
      bolditalics: 'DMSans-Bold.woff',
    },
  })
}
