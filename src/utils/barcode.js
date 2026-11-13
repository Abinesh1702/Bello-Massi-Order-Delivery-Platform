/**
 * Barcodes (data v11): validation (EAN-13 / EAN-8 / UPC-A check digits, Code 128 character set), generation of a
 * new unique EAN-13 inside the company prefix, and module patterns for rendering (EAN-13 and Code 128-B) as SVG bars.
 */
export const BARCODE_TYPES = ['EAN-13', 'EAN-8', 'UPC-A', 'CODE-128']
export const COMPANY_PREFIX = '890550' // GS1 India range used by the demo data (89055…)

const checkDigit = (digits) => {
  // GS1 mod-10: weights 3,1 from the right (excluding the check digit)
  const sum = digits.split('').reverse().reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 3 : 1), 0)
  return String((10 - (sum % 10)) % 10)
}
export const gs1Valid = (code) => /^\d+$/.test(code) && checkDigit(code.slice(0, -1)) === code.slice(-1)

/** Error message or null. */
export const validateBarcode = (code, type = 'EAN-13') => {
  const c = String(code || '').trim()
  if (!c) return null
  if (type === 'EAN-13') return /^\d{13}$/.test(c) ? (gs1Valid(c) ? null : 'EAN-13 check digit is wrong.') : 'EAN-13 barcodes have 13 digits.'
  if (type === 'EAN-8') return /^\d{8}$/.test(c) ? (gs1Valid(c) ? null : 'EAN-8 check digit is wrong.') : 'EAN-8 barcodes have 8 digits.'
  if (type === 'UPC-A') return /^\d{12}$/.test(c) ? (gs1Valid(c) ? null : 'UPC-A check digit is wrong.') : 'UPC-A barcodes have 12 digits.'
  if (type === 'CODE-128') return /^[\x20-\x7E]{1,40}$/.test(c) ? null : 'Code 128 allows 1–40 printable characters.'
  return 'Unknown barcode type.'
}

/** Next free EAN-13 in the company prefix (prefix + 6-digit item reference + check digit). */
export const generateEan13 = (existing = []) => {
  const used = new Set(existing.map(String))
  for (let n = 1; n < 1000000; n += 1) {
    const body = `${COMPANY_PREFIX}${String((Date.now() % 900000) + n).padStart(6, '0').slice(-6)}`
    const code = body + checkDigit(body)
    if (!used.has(code)) return code
  }
  return null
}

/* ---------- Rendering patterns (string of 1/0 modules) ---------- */
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011']
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111']
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100']
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL']

export const ean13Pattern = (code) => {
  if (!/^\d{13}$/.test(code)) return null
  const d = code.split('').map(Number)
  const par = PARITY[d[0]]
  let out = '101'
  for (let i = 1; i <= 6; i += 1) out += (par[i - 1] === 'L' ? L : G)[d[i]]
  out += '01010'
  for (let i = 7; i <= 12; i += 1) out += R[d[i]]
  return `${out}101`
}

// Code 128 bar widths (value 0..106), as 6 or 7 digit width strings
const C128 = ['212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112']
export const code128Pattern = (text) => {
  const s = String(text || '')
  if (!/^[\x20-\x7E]+$/.test(s)) return null
  const values = [104, ...s.split('').map((ch) => ch.charCodeAt(0) - 32)]
  const check = values.reduce((sum, v, i) => sum + v * (i === 0 ? 1 : i), 0) % 103
  const widths = [...values, check, 106].map((v) => C128[v]).join('')
  let out = ''
  widths.split('').forEach((w, i) => { out += (i % 2 === 0 ? '1' : '0').repeat(Number(w)) })
  return out
}

/** Module pattern for a code: EAN-13 when it is a valid EAN-13, otherwise Code 128. */
export const barcodePattern = (code, type) => {
  if ((type === 'EAN-13' || !type) && /^\d{13}$/.test(String(code))) return { pattern: ean13Pattern(String(code)), symbology: 'EAN-13' }
  return { pattern: code128Pattern(code), symbology: 'Code 128' }
}
