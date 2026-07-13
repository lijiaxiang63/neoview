let nextFileReadRequestId = 0

/** Allocate from the one renderer-wide namespace owned by main-side file reads. */
export function allocateFileReadRequestId(): number {
  if (nextFileReadRequestId >= Number.MAX_SAFE_INTEGER) nextFileReadRequestId = 0
  return ++nextFileReadRequestId
}
