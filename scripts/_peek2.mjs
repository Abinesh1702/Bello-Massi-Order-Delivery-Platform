const mem = new Map()
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), clear: () => mem.clear(), key: (i) => [...mem.keys()][i] ?? null, get length() { return mem.size } }
globalThis.sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.window = globalThis; globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {}; globalThis.dispatchEvent = () => true
const src = new URL('../src/', import.meta.url).href
const { buildSeed } = await import(src + 'services/storageService.js')
const s = buildSeed()
const f = new Function('s', 'return (' + process.argv[2] + ')')
console.log(JSON.stringify(f(s), null, 0))
