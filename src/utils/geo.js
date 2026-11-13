/**
 * Geography helpers (data v11): coordinates for hubs / customers, great-circle distance, simple route metrics and
 * the SIMULATED GPS position used by live tracking. No geocoding service is called — address search matches the
 * built-in city gazetteer below (clearly labelled in the UI); positions can always be set on the map or typed in.
 */

export const CITY_COORDS = {
  chennai: [13.0827, 80.2707], madurai: [9.9252, 78.1198], bengaluru: [12.9716, 77.5946], bangalore: [12.9716, 77.5946],
  hyderabad: [17.385, 78.4867], coimbatore: [11.0168, 76.9558], salem: [11.6643, 78.146], ooty: [11.4102, 76.695],
  puducherry: [11.9416, 79.8083], pondicherry: [11.9416, 79.8083], kochi: [9.9312, 76.2673], trichy: [10.7905, 78.7047],
  tiruchirappalli: [10.7905, 78.7047], vellore: [12.9165, 79.1325], mysuru: [12.2958, 76.6394], mysore: [12.2958, 76.6394],
  dubai: [25.2048, 55.2708], 'abu dhabi': [24.4539, 54.3773], sharjah: [25.3463, 55.4209], mumbai: [19.076, 72.8777], delhi: [28.6139, 77.209],
}
const HUB_COORDS = { 'hub-che': [13.0982, 80.1622], 'hub-cbe': [11.03, 77.01], 'hub-blr': [13.0285, 77.5197], 'hub-mdu': [9.8806, 78.0567], 'hub-hyd': [17.471, 78.596] }

const hash = (s) => [...String(s)].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 7)
const r6 = (n) => Math.round(n * 1e6) / 1e6

export const isValidCoord = (lat, lng) => Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180 && !(Number(lat) === 0 && Number(lng) === 0)

/** City centre for an address, or null. */
export const cityCoords = (city) => CITY_COORDS[String(city || '').trim().toLowerCase()] || null

/** Deterministic position inside the city for a record without saved coordinates (labelled "approximate"). */
export const approximateCoords = (id, city) => {
  const c = cityCoords(city)
  if (!c) return null
  const h = hash(id)
  return [r6(c[0] + (((h & 0xff) / 255) - 0.5) * 0.06), r6(c[1] + ((((h >> 8) & 0xff) / 255) - 0.5) * 0.06)]
}

export const hubCoords = (hub) => {
  if (!hub) return null
  if (isValidCoord(hub.latitude, hub.longitude)) return [Number(hub.latitude), Number(hub.longitude)]
  return HUB_COORDS[hub.id] || cityCoords(hub.city)
}

/** Coordinates of a customer: saved pin → approximate city position → null. { lat, lng, source }. */
export const customerLocation = (c) => {
  if (!c) return null
  if (isValidCoord(c.latitude, c.longitude)) return { lat: Number(c.latitude), lng: Number(c.longitude), source: c.locationVerified ? 'Verified pin' : 'Saved pin' }
  const a = approximateCoords(c.id, c.city)
  return a ? { lat: a[0], lng: a[1], source: 'Approximate (city)' } : null
}

/** Built-in gazetteer search (no external geocoder). */
export const searchPlaces = (q) => {
  const s = String(q || '').trim().toLowerCase()
  if (s.length < 2) return []
  return Object.entries(CITY_COORDS).filter(([name]) => name.includes(s) || s.includes(name)).slice(0, 8)
    .map(([name, [lat, lng]]) => ({ name: name.replace(/\b\w/g, (m) => m.toUpperCase()), lat, lng }))
}

/** Great-circle distance in km. */
export const distanceKm = (a, b) => {
  if (!a || !b) return 0
  const [lat1, lon1] = Array.isArray(a) ? a : [a.lat, a.lng]
  const [lat2, lon2] = Array.isArray(b) ? b : [b.lat, b.lng]
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const x = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return Math.round(R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)) * 10) / 10
}

/** Road distance estimate (straight line × 1.3) and drive time at an average urban speed. */
export const ROAD_FACTOR = 1.3
export const AVG_SPEED_KMH = 28
export const SERVICE_MINUTES = 12
export const roadKm = (a, b) => Math.round(distanceKm(a, b) * ROAD_FACTOR * 10) / 10
export const driveMinutes = (km) => Math.round((km / AVG_SPEED_KMH) * 60)

/** Nearest-neighbour ordering of stops from the hub (each stop: { id, lat, lng }). */
export const nearestNeighbour = (origin, stops) => {
  const left = [...stops]
  const out = []
  let cur = origin
  while (left.length) {
    let best = 0
    left.forEach((s, i) => { if (distanceKm(cur, s) < distanceKm(cur, left[best])) best = i })
    cur = left.splice(best, 1)[0]
    out.push(cur)
  }
  return out
}

/** Point a fraction t (0..1) of the way from a to b. */
export const interpolate = (a, b, t) => ({ lat: r6(a.lat + (b.lat - a.lat) * t), lng: r6(a.lng + (b.lng - a.lng) * t) })
