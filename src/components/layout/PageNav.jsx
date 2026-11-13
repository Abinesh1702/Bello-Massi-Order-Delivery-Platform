import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, Star } from 'lucide-react'
import { findNavItemByPath, getNavigationForRole } from '../../config/navigation'
import { useAuth } from '../../hooks/useAuth'
import { useStoredValue } from '../../hooks/useLocalStorage'
import { STORAGE_KEYS as K } from '../../utils/constants'
import { getPrefs, toggleFavourite, trackRecent } from '../../services/erp/workspaceService'
import { getBreadcrumbs } from './Breadcrumbs'
import { cn } from '../../utils/helpers'

const btn = 'grid h-8 w-8 place-items-center rounded-lg text-muted transition-colors hover:text-ink hover:bg-surface-3 disabled:opacity-30 disabled:hover:bg-transparent'

/**
 * Back / forward (browser history), previous / next page within the current menu group, and a favourite star for
 * the current page. Also records the page in the user's recent list (My Workspace).
 */
export default function PageNav({ className }) {
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const { user } = useAuth()
  useStoredValue(K.USER_PREFS, {})
  const item = findNavItemByPath(pathname)
  const group = user && item?.group ? getNavigationForRole(user).find((g) => g.id === item.group.id) : null
  const siblings = group?.children || []
  const anchor = item?.hidden && item.parent ? siblings.find((s) => s.id === item.parent) : item
  const idx = anchor ? siblings.findIndex((s) => s.id === anchor.id) : -1
  const prev = idx > 0 ? siblings[idx - 1] : null
  const next = idx >= 0 && idx < siblings.length - 1 ? siblings[idx + 1] : null
  const fav = item && !item.hidden && getPrefs(user).favourites.includes(item.id)
  useEffect(() => {
    if (!item || !user) return
    const crumbs = getBreadcrumbs(pathname)
    trackRecent({ path: pathname + search, label: item.path.includes(':') ? `${crumbs[crumbs.length - 1]?.label} · ${decodeURIComponent(pathname.split('/').pop())}` : item.label })
  }, [pathname]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={cn('flex items-center gap-0.5', className)}>
      <button type="button" className={btn} onClick={() => navigate(-1)} aria-label="Back" title="Back"><ArrowLeft size={16} /></button>
      <button type="button" className={btn} onClick={() => navigate(1)} aria-label="Forward" title="Forward"><ArrowRight size={16} /></button>
      {group && <>
        <button type="button" className={btn} disabled={!prev} onClick={() => prev && navigate(prev.path)} aria-label={prev ? `Previous: ${prev.label}` : 'No previous page'} title={prev ? `Previous in ${group.label}: ${prev.label}` : ''}><ChevronLeft size={16} /></button>
        <button type="button" className={btn} disabled={!next} onClick={() => next && navigate(next.path)} aria-label={next ? `Next: ${next.label}` : 'No next page'} title={next ? `Next in ${group.label}: ${next.label}` : ''}><ChevronRight size={16} /></button>
      </>}
      {item && !item.hidden && <button type="button" className={cn(btn, fav && 'text-accent')} onClick={() => toggleFavourite('page', item.id)} aria-label={fav ? 'Remove from favourites' : 'Add to favourites'} aria-pressed={fav} title={fav ? 'Remove from favourites' : 'Add to favourites (My Workspace)'}><Star size={16} fill={fav ? 'currentColor' : 'none'} /></button>}
    </div>
  )
}
