# Serpent – Modern Snake Game

A beautifully rendered, browser-based Snake game built with vanilla HTML5 Canvas. No dependencies, no build step — just open `index.html`.

## Features

- **10 levels** with increasing speed and seasonal visual themes (Spring → Summer → Autumn → Winter → Mystic → Void)
- **3 food types** with weighted probability:
  - Apple — 10 pts (60% spawn rate)
  - Mouse — 20 pts (30% spawn rate)
  - Rabbit — 50 pts, animated hop (10% spawn rate)
- **Realistic snake rendering** — scales, head, eyes, tongue (flicks near food)
- **Wrapping edges** — snake passes through walls toroidally
- **Persistent high score** via localStorage
- **Accessible** — ARIA live regions, keyboard-only playable, focus indicators
- **Touch support** — swipe gestures for mobile play
- **Particle system** — season-themed floating particles

## Controls

| Input | Action |
|-------|--------|
| Arrow Keys | Move snake |
| Space | Start / Pause / Resume |
| Swipe | Move snake (mobile) |
| Tap | Start / Restart (mobile) |

## Running Locally

```bash
# No build required — just open the file
open index.html
# or serve with any static server
npx serve .
```

## Levels & Seasons

| Level | Speed | Theme |
|-------|-------|-------|
| 1 | 140ms | Spring |
| 2 | 125ms | Summer |
| 3 | 110ms | Autumn |
| 4 | 95ms | Winter |
| 5 | 80ms | Spring |
| 6 | 70ms | Summer |
| 7 | 60ms | Autumn |
| 8 | 50ms | Winter |
| 9 | 40ms | Mystic |
| 10 | 30ms | Void |

## Browser Support

Modern browsers with HTML5 Canvas support (Chrome, Firefox, Safari, Edge). No IE support.

## License

MIT
