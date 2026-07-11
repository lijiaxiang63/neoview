import { STORAGE_MIGRATION_QUERY } from '../../shared/storageMigration'

// The hidden one-time migration page needs only its old-origin localStorage.
// Avoid mounting the application or acquiring any renderer runtime resources.
if (!new URLSearchParams(window.location.search).has(STORAGE_MIGRATION_QUERY)) {
  void import('./main')
}
