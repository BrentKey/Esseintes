import { useEffect, useRef, useState } from 'react'
import { sized } from '../lib'

const ZOOM = 2.5
const MAX_ZOOM = 5

/**
 * Full-window photo viewer. Click to zoom in where you clicked (and out again),
 * move the mouse to look around, scroll to zoom further, arrow keys to page.
 */
export function Lightbox({ images, start, alt, onClose }: { images: string[]; start: number; alt: string; onClose: () => void }) {
  const [i, setI] = useState(start)
  const [zoom, setZoom] = useState(1)
  // Point of the photo under the cursor, as fractions of its width and height.
  const [focus, setFocus] = useState({ x: 0.5, y: 0.5 })
  const stage = useRef<HTMLDivElement>(null)

  const go = (d: number) => {
    setI((n) => (n + d + images.length) % images.length)
    setZoom(1)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [images.length])

  const pointAt = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect()
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }
  }

  return (
    <div className="lightbox" onClick={onClose}>
      <button className="lightbox-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      <div
        ref={stage}
        className={`lightbox-stage${zoom > 1 ? ' zoomed' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          setFocus(pointAt(e))
          setZoom((z) => (z > 1 ? 1 : ZOOM))
        }}
        onMouseMove={(e) => zoom > 1 && setFocus(pointAt(e))}
        onWheel={(e) => {
          setFocus(pointAt(e))
          setZoom((z) => Math.min(MAX_ZOOM, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))))
        }}
      >
        <img
          src={sized(images[i], 2400)}
          alt={alt}
          draggable={false}
          style={{ transform: `scale(${zoom})`, transformOrigin: `${focus.x * 100}% ${focus.y * 100}%` }}
        />
      </div>
      {images.length > 1 && (
        <>
          <button className="lightbox-nav prev" onClick={(e) => (e.stopPropagation(), go(-1))} aria-label="Previous photo">
            ‹
          </button>
          <button className="lightbox-nav next" onClick={(e) => (e.stopPropagation(), go(1))} aria-label="Next photo">
            ›
          </button>
          <div className="lightbox-count">
            {i + 1} / {images.length}
          </div>
        </>
      )}
    </div>
  )
}
