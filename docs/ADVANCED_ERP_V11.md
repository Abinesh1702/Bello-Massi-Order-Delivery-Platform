# Advanced ERP implementation & workflow enhancement (data v11)

This release extends the cleaned v10 project in place. It is still a **frontend-only LocalStorage application**
(React 19 · Vite 8 · Tailwind 4 · React Router 7 · Leaflet). Nothing was rebuilt from scratch, no stored data is reset
and every new rule is enforced in the services (not only by hiding buttons).

## 1. What was added, by brief section

| § | Feature | Where | Notes |
|---|---|---|---|
| 3 | Dashboard Period A vs Period B (month / quarter / year / custom), absolute + % difference with up/down, clickable KPIs → records, KPI format (compact, full, currency + exact, number only, percentage, quantity / KG), 9 overviews (sales, orders, delivery, inventory, purchase, vendor quality, finance, fleet, customer) | `/dashboard/compare` · `services/erp/compareService.js` | All values computed from stored records on each collection's own business date. Snapshot KPIs are labelled "Current". |
| 4 | Barcode: type, validation (EAN-13 / EAN-8 / UPC-A check digit, Code 128), duplicate check, generation (company prefix), SVG display, label printing, camera scan (BarcodeDetector) with manual / handheld fallback; scanning in product list, order workspace, new stock, bulk receipt, transfers, adjustments and dispatch loading | `utils/barcode.js`, `components/erp/ErpUi.jsx` | SKU, unit, secondary unit, conversion factor, expiry tracking, shelf life, minimum remaining shelf life, batch tracking, perishable, category / subcategory and image are on the product form. |
| 5 | Application chat: personal, department, group, project, announcement, support, sales, operations, warehouse, dispatch; search people / messages, create group, add / remove members, text, attachments (image preview, download), reply, timestamps, read receipts, pin, edit / delete own, notifications, history; share order / customer / invoice / dispatch / delivery / product / batch / complaint with permission check | `/chat` · `services/erp/chatService.js` | Real-time is **simulated** (LocalStorage + browser storage event between tabs). Nothing leaves the device. |
| 6 | Admin-only **New stock** (opening stock, opening batch, import CSV, adjustment-in) with hub, warehouse, product, qty, unit cost, batch, mfg / expiry, reason, attachments — posted as ledger receipt movements that create the batch | `/inventory/new-stock` · `stockControlService.postOpeningStock` | `inventory.openingstock` is granted to Admin only. |
| 6 | Multi-product stock receipt with category / subcategory / search / SKU / barcode / supplier / batch / expiry filters, multi-select and a table of ordered / received / rejected / accepted / unit / cost / batch / expiry | `/inventory/stock-receipts/bulk` | Accepted = received − rejected. |
| 7 | Customer map pin (Leaflet + OSM tiles), coordinates, built-in place search, device location, verification; map on customer, order, dispatch route and driver delivery screens; approximate city position when no pin | `components/erp/CustomerLocation.jsx` | No external geocoder; markers / routes render even when tiles are offline. |
| 7 | Primary / secondary salesman, team, manager, history; automatic fallback when the primary is on leave (approved HR leave), resigned, terminated or inactive; Sales Manager notified and responsible when both are unavailable; manual override; hand-over; audit | `/sales/assignments` · `salesAssignmentService.js` | Effective salesman is used by recurring orders and the order workspace. |
| 8 | Order workspace: search, SKU, barcode scan, category, favourites, frequent, recent, customer-specific, price + stock, quantity in any unit, quick / bulk add (last order), cart, no duplicate lines, delivery date + slot, draft / submit, keyboard shortcuts; validations (customer status, credit, availability, minimum qty, unit conversion, pricing, discount, slot, duplicate order with confirmation) | `/orders/workspace` (sidebar "Create Order") | The classic form stays routable (`/orders/create`) for editing drafts. |
| 9 | Sidebar in 15 groups (Dashboard, Sales & Customers, Orders, Purchase & Vendors, Inventory & Warehouse, Dispatch & Delivery, Fleet & VMS, Customer Complaints, Documents & OCR, Finance & Invoices, Communication, Reports & Analytics, AI Intelligence, Administration, Settings), breadcrumbs, back / forward and previous / next page within the group, favourite star | `config/navigation.js`, `components/layout/PageNav.jsx` | 459 routes, no duplicate ids / paths, no route lost (checked against v10). |
| 10 | Units: pieces, units, boxes, packs, cartons, kg, g, litres, ml, sets and custom units per product with factors; base / sales / purchase / inventory / dispatch / delivery / secondary unit; every calculation in the base unit; order line ordered (entry unit + base), dispatched, delivered, returned, remaining | `utils/units.js`, order "Quantities by unit" card | 5 BOX = 50 KG; dispatch 30 → remaining 20. |
| 11 | Vehicle capacity: max weight, volume, stops, quantity; incremental loading with used / remaining / % ; route grouping (stop no., customer, address, coordinates, distance, slot, quantity, weight); no overloading (loading and dispatch confirmation refuse it) | Dispatch → "Loading & capacity" · `fleetService.capacityCheck / setOrderLoaded` | |
| 12 | Driver availability: Available, Assigned, On Delivery, On Leave, Offline, Suspended, Inactive; offline / leave periods with date-times, reason, remarks; no assignment while unavailable; no overlapping assignments; 14-day calendar; admin override per day with reason; history | `/fleet/driver-availability` · `fleetService` + `driverService.driverAssignmentIssues` | |
| 13 | Vehicle replacement on the **same** dispatch: candidates checked for availability and capacity, deliveries and orders follow, old vehicle → Maintenance (or chosen status), driver + dispatcher notified, replacement history | Dispatch → "Replace vehicle" · `fleetService.replaceVehicle` | Statuses: Available, Assigned, In Transit, Maintenance, Inactive, Suspended. |
| 14 | Live route: hub **H** + numbered stops, polyline, current position, completed / pending / current stop, distance, ETA, last update; stop statuses Pending, Arrived, In Progress, Delivered, Failed, Skipped; driver route view; manual / device location update and simulated arrival | Dispatch → "Live route", driver `/driver/route` · `fleetService.routeModel` | Position is labelled **Simulated GPS** or **Manual location** — never presented as live tracking. |
| 15 | Recurring orders: customer, products, qty + unit, several slots with times and products, start / end, Daily / Weekly (weekdays) / Fortnightly / Monthly / every N days, address, salesman, hub; list, create, detail, edit, pause, resume, cancel, generated orders, calendar with skip; idempotent generation (key per schedule × date × slot); edits never change generated orders | `/orders/recurring` · `recurringService.js` | Generated orders are submitted for approval → reservation → consolidation → dispatch → delivery. Standing orders (HORECA templates) were migrated into schedules. |
| 16 | Vendor master `/vendors`: code, name, GSTIN, PAN, contact, mobile, email, address, products supplied, payment terms, bank, status Active / On Watch / Blocked (blocked → no PO, no approve, no send) | `/vendors` · `vendorService.js` | `/suppliers` redirects here; suppliers are mirrored to the planning settings for forecasting. |
| 16 | Purchase orders (Draft → Sent → Partially Received → Fully Received → Closed / Cancelled) with GRN history, vendor invoice, source batches and **where it went** (in stock / sold / scrapped / returned); GRN with vendor invoice number + date, hub, warehouse, accepted / rejected, partial receipts | `/purchase/orders`, `/purchase/receipts` (aliases of the procurement / receiving modules) | |
| 17 | Batch traceability: `bellomassi_vendors`, `purchase_orders`, `goods_receipts`, `batches`, `batch_allocations`; lots carry PO, GRN, vendor, cost, mfg, expiry, status, quantities received / available / dispatched / returned / scrapped / returned to vendor; allocations per order (e.g. 60 KG B-101 from PO-1 + 20 KG opening batch); source batches on order and invoice (immutable snapshot at issue); PO ↔ invoice traceability report; batch lifecycle report | `utils/batchAllocation.js`, `batchService.rebuildAllocations` | Allocations are derived from lot consumption on the single stock ledger, so they can never disagree with stock. |
| 18 | FEFO: skip expired, QA-held and lots under the minimum remaining shelf life; sort by expiry then receipt; preview before confirmation; block with "Only 40 KG usable; 20 KG is expired or near expiry"; override with reason + confirmation + audit (expired / QA-blocked can never be chosen); expiry page with expired / 7-day / 30-day buckets, filters and value | Dispatch → "Batches (FEFO)", `/inventory/expiry` · `stockControlService.fefoPlan` | Confirmation passes the plan's lots to the dispatch movement. |
| 19 | Complaints `/complaints` and `/complaints/create`: delivered / partially delivered orders only, 7-day window (settings), number, order, customer, line, product, qty, batch, PO, vendor (auto from allocations), type, description, photos, contact, date; batch selection / split; Open → Under Investigation → Resolved / Rejected → Closed; Replacement (linked no-charge order), Credit Note (linked to invoice), Refund (Finance records payment), No Action — remarks required | `complaintService.js` | CS create / investigate / resolve, salesman raise (own customers), Admin full, SM and Finance view. |
| 20 | Vendor quality: threshold 3 vendor-responsible complaints / 30 days (settings) → alert once per window, Admin (+ SM) notified, vendor On Watch, affected batches / products / history; Admin may block; scorecard (complaints, rate = complained ÷ supplied, types, trend, batches, alerts); Vendor Complaint Analysis report | Vendor page → Quality tab | |
| 21 | Expiry → scrap: detection on sign-in and every 30 min, batch marked expired and blocked (dispatch / transfer impossible), one scrap request per lot (Pending Approval), Admin notified; approve → stock deducted, scrap movement on that lot, batch closed; reject → reason, stock stays blocked, **Return to Vendor** (PO return PRN, original PO, vendor, batch, qty, reason, stock deduction, history) | `stockControlService.detectExpiry / returnToVendor`, `/inventory/expiry` | |
| 22 | Smart search (customers, orders, products, batches, invoices, vendors, dispatches, drivers, complaints, POs), quick actions, favourites, recent activity, notifications, bulk approval / receipt / loading / import / export, exception dashboard, audit trail | Header search, `/workspace`, `/exceptions` | |
| 23 | Centralized services (`src/services/erp/*`), idempotent migration v10 → v11, validation in services, numbering (REC / CMP / PRN / SCR / VEN), transactions, integrity (lot totals reconcile, unique allocations, unique invoices), import / export, demo reset | | |
| 24 | Order details: actions by status and permission (Edit / Submit / Approve / Consolidate / Plan dispatch / Invoice / Raise complaint / Cancel), map, source batches, quantities by unit | `/orders/:id` | |
| 25 | RBAC: permission catalog v5 (+18 keys: complaints, recurring, vendor quality, opening stock, FEFO override, driver availability, vehicle replacement, loading, customer location / assignment, chat); system roles get defaults, enterprise and custom roles receive keys from their existing "trigger" permissions; customers see only their own complaints; drivers only their route | `config/enterprise/permissionCatalog.js` | |

## 2. Data model (v11)

New keys (created on upgrade only when missing, built from the live data): `bellomassi_vendors`,
`bellomassi_batch_allocations`, `bellomassi_recurring_orders`, `bellomassi_complaints`, `bellomassi_purchase_returns`,
`bellomassi_vendor_quality_alerts`, `bellomassi_chat_channels`, `bellomassi_chat_messages`, `bellomassi_user_prefs`,
`bellomassi_erp_settings`.

New fields (added only where missing — nothing a user set is overwritten):
products (`baseUnit`, `units[]`, `salesUnit` … `deliveryUnit`, `secondaryUnit`, `weightKg`, `volumeM3`, `barcodeType`,
`trackExpiry`, `batchTracking`, `perishable`, `shelfLifeDays`, `minRemainingShelfLifeDays`, `subcategory`,
`minOrderQty`), customers (`latitude`, `longitude`, `locationVerified`, `secondarySalesRepId`, `salesTeam`,
`salesManagerId`, `assignmentHistory`), hubs (coordinates), drivers (`offlinePeriods`, `availabilityHistory`,
`suspended`), vehicles (`maxWeightKg`, `maxVolumeM3`, `maxStops`, `replacementHistory`), lots (`poId`, `poNumber`,
`vendorId`, `unitCost`, `warehouseId`, scrap / return-to-vendor quantities), order lines (`entryUnit`,
`entryQuantity`, `entryFactor`), orders (`deliverySlotId`, `orderMode`, `recurringOrderId`, `recurringKey`,
`sourceComplaintId`), dispatches (`fefoOverride`, `lotPlan`, `loading`, `vehicleReplacements`, `gps`), invoices
(`sourceBatches`). Movement type added: `Return to Vendor`.

## 3. Verification (this release)

| Check | Result |
|---|---|
| `npm run build` | passes |
| `oxlint src` | 0 errors (30 warnings — fast-refresh exports and React-compiler hints, same categories as before) |
| `npm run check:workflow` (order-to-cash regression) | 73 / 73 |
| `npm run check:erp` (43-step brief scenario + negative cases) | 98 / 98 |
| `npm run check:migration -- <v10 snapshot>` and `<v9 snapshot>` | all pass, idempotent, no existing key reseeded |
| Playwright: 27 demo sign-ins, 297 static routes, 137 detail routes | 0 page errors, 0 error boundaries, 0 unauthorized |
| Playwright: 29 targeted UI flows (vendor create, opening stock, expiry scan, compare + KPI drill-down + format, chat, product barcode, customer map, driver availability, exceptions, workspace, PO alias + traceability, dispatch route / loading / FEFO tabs, order workspace submit in KG, recurring schedule + generation, driver route map, RBAC denials, mobile layout) | 29 / 29 |

The 43-step scenario (`scripts/erp-scenario.mjs`) covers: vendor → product with barcode → hub → opening stock →
PO → sent → GRN → batch → stock → customer with primary / secondary salesman (leave, resignation, both unavailable) →
one-time order in BOX + recurring order with two slots → approval with reservation → FEFO preview → consolidation →
driver offline period / admin-only override → capacity check → dispatch → loading → vehicle replacement → confirmation
with FEFO lots → GPS route (H, stops, simulated + manual position) → OTP → POD → delivery → movement → allocation
(60 + 20 KG from two batches) → invoice with source batches → customer visibility → payment → complaints with batch
split → vendor alert → On Watch → credit note / replacement resolutions → blocked vendor refused a PO → expiry
detection → FEFO block message → expired override refused → scrap approval and write-off → batch closed → reject +
return to vendor → reports → PO "where it went" → exceptions → smart search → chat share with permission check →
audit trail → RBAC → ledger reconciliation and uniqueness.

## 4. Remaining limitations (prototype boundaries)

- No backend: data lives in this browser. Chat "real time" works between tabs of the same browser only; a chat
  server (WebSocket) is needed for other devices.
- GPS is simulated (or a manual / device location the driver records). No vehicle telematics is connected.
- Map tiles come from OpenStreetMap when online; address search uses a built-in city list (no geocoding API).
- Camera barcode scanning needs a browser with the BarcodeDetector API (Chrome / Edge on Android, ChromeOS, macOS);
  elsewhere handheld scanners and typing work.
- Seeded historical orders pre-date lot tracking, so their allocation list is empty; every dispatch confirmed from
  this release on records its batches.
- Refunds are recorded on the complaint and paid by Finance with a reference; no payment gateway.
- Background jobs (expiry scan, recurring generation, vendor quality, salesman coverage) run while the app is open
  (on sign-in and every 30 minutes); a server scheduler would run them unattended.
- Barcode scanning is not wired into the generic warehouse task screens (put-away / picking modules); it is available
  in the product list, order workspace, new stock, multi-product receipt, transfers, adjustments and dispatch loading.
