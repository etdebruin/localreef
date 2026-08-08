/**
 * The wallpaper catalogue.
 *
 * Two kinds of background, and the distinction is not cosmetic:
 *
 *   image     a picture in assets/backgrounds/. Gorgeous, and busy.
 *   gradient  pure CSS. Weightless, resolution-independent, and quiet —
 *             which is what you want behind actual work.
 *
 * **Each entry carries its own scrim.** This is the part that would be wrong
 * as a global setting. The scrims exist so UI text stays legible over the
 * wallpaper, and how much darkening that needs depends entirely on the
 * picture: `tranquil-reef` is blinding at top-centre exactly where the title
 * sits, `exotic-reef` is brighter at the edges and needs less at the top but
 * more vignette. One global value tuned for the first image washes out the
 * second, or fails to rescue it.
 *
 * Adding a background is one entry here plus, for an image, one file. Nothing
 * else in the app needs to know.
 */

/** Scrim opacities, 0–1: top strip, bottom strip, corner vignette. */
const scrim = (top, bottom, vignette) => ({ top, bottom, vignette })

export const BACKGROUNDS = [
  {
    id: 'tranquil-reef',
    name: 'Tranquil Reef',
    kind: 'image',
    file: 'tranquil-reef.webp',
    // Sun rays land dead centre behind the title, so the top strip works hard.
    scrim: scrim(0.66, 0.3, 0.36),
  },
  {
    id: 'exotic-reef',
    name: 'Exotic Reef',
    kind: 'image',
    file: 'exotic-reef.webp',
    // Brighter and more saturated overall, with light reaching the corners —
    // less needed up top, more vignette to stop the edges shouting.
    scrim: scrim(0.58, 0.28, 0.46),
  },
  {
    id: 'deep',
    name: 'Deep',
    kind: 'gradient',
    css: `radial-gradient(120% 90% at 50% -10%, oklch(0.42 0.09 220) 0%, transparent 62%),
          radial-gradient(90% 70% at 12% 108%, oklch(0.34 0.07 200) 0%, transparent 58%),
          linear-gradient(to bottom, oklch(0.24 0.05 240), oklch(0.16 0.035 250))`,
    // Already dark: the scrims only need to keep the vignette shape consistent.
    scrim: scrim(0.22, 0.2, 0.16),
  },
  {
    id: 'shallows',
    name: 'Shallows',
    kind: 'gradient',
    css: `radial-gradient(110% 80% at 50% -12%, oklch(0.62 0.1 205) 0%, transparent 60%),
          radial-gradient(80% 60% at 88% 104%, oklch(0.46 0.08 190) 0%, transparent 55%),
          linear-gradient(to bottom, oklch(0.4 0.07 210), oklch(0.24 0.05 225))`,
    // Lighter, so the dock and the title need real separation.
    scrim: scrim(0.4, 0.22, 0.28),
  },
  {
    id: 'dusk',
    name: 'Dusk',
    kind: 'gradient',
    css: `radial-gradient(100% 80% at 78% -8%, oklch(0.5 0.12 30) 0%, transparent 58%),
          radial-gradient(95% 75% at 10% 105%, oklch(0.36 0.09 300) 0%, transparent 60%),
          linear-gradient(to bottom, oklch(0.26 0.06 285), oklch(0.17 0.04 275))`,
    scrim: scrim(0.26, 0.24, 0.2),
  },
]

export const DEFAULT_BACKGROUND_ID = 'tranquil-reef'

/**
 * Never returns null. A settings file can name a background that a later
 * release removed, and a blank canvas is a worse answer than the default.
 */
export function resolveBackground(id) {
  return (
    BACKGROUNDS.find((bg) => bg.id === id) ??
    BACKGROUNDS.find((bg) => bg.id === DEFAULT_BACKGROUND_ID)
  )
}

/** Path relative to the renderer, or null for a gradient. */
export function backgroundFile(background) {
  if (!background || background.kind !== 'image') return null
  return `../../assets/backgrounds/${background.file}`
}
