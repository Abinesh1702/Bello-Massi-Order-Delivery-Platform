/**
 * Supplier directory — compatibility facade over the vendor master (data v11, services/erp/vendorService).
 * Vendors are the single source; the planning mirror in the forecast settings is maintained by vendorService.
 */
import { getVendors, saveVendor } from './erp/vendorService'

/** Suppliers in the legacy shape (name, leadTimeDays, minOrderValue, categories, contactEmail, contactPhone) plus vendor fields. */
export const getSuppliers = () => getVendors().map((v) => ({ ...v, contactEmail: v.email || '', contactPhone: v.mobile || '' }))

export const saveSupplier = (id, values) => {
  const v = getVendors().find((x) => x.id === id)
  if (!v) return { ok: false, error: 'This supplier no longer exists.' }
  return saveVendor({ ...v, ...values, email: values.contactEmail ?? values.email ?? v.email, mobile: values.contactPhone ?? values.mobile ?? v.mobile }, id)
}

export default { getSuppliers, saveSupplier }
