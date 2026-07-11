import { useEffect, useMemo, useState, type RefObject } from 'react'
import { fitSliceViewport, type SliceViewport } from '../slicing/viewport'

export interface SliceViewportState {
  canvasSize: [number, number]
  devicePixelRatio: number
  viewport: SliceViewport | null
}

export function useSliceViewport(
  containerRef: RefObject<HTMLDivElement | null>,
  columns: number,
  rows: number,
  columnSpacing: number,
  rowSpacing: number,
  sharedFitSize: readonly [number, number] | null = null
): SliceViewportState {
  const [measurement, setMeasurement] = useState<{
    canvasSize: [number, number]
    devicePixelRatio: number
  }>({ canvasSize: [0, 0], devicePixelRatio: 1 })

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const update = (): void => {
      const devicePixelRatio = window.devicePixelRatio || 1
      const rect = element.getBoundingClientRect()
      const canvasSize: [number, number] = [
        Math.round(rect.width * devicePixelRatio),
        Math.round(rect.height * devicePixelRatio)
      ]
      setMeasurement((current) =>
        current.devicePixelRatio === devicePixelRatio &&
        current.canvasSize[0] === canvasSize[0] &&
        current.canvasSize[1] === canvasSize[1]
          ? current
          : { canvasSize, devicePixelRatio }
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [containerRef])

  const viewport = useMemo<SliceViewport | null>(() => {
    const fit = fitSliceViewport(
      measurement.canvasSize[0],
      measurement.canvasSize[1],
      columns,
      rows,
      columnSpacing,
      rowSpacing,
      0.96,
      sharedFitSize
    )
    return fit ? { fit, columns, rows, columnSpacing, rowSpacing } : null
  }, [measurement.canvasSize, columns, rows, columnSpacing, rowSpacing, sharedFitSize])

  return { ...measurement, viewport }
}
