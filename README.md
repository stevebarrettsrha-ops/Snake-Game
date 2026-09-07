# Serpent — 150 levels, ten biomes, and an arena

A snake game that takes its subject seriously. 150 levels, ten biomes, ten real snake
species and six prey animals, all drawn procedurally on HTML5 Canvas.

No dependencies, no build step, no image files.

- **Campaign** — open `index.html`. 150 levels, single player, nothing to install.
- **Battle Royale** — `node server.js`, then open the address it prints. Everyone
  on the network joins one huge shared arena.

## Design

**The snake has an anatomy.** A tapered spline body — narrow neck, widest at a
fifth of its length, drawn out to a fine tail — shaded as a cylinder so the
spine catches light and the flanks fall away. Each species' skin is baked once
into a texture strip carrying the cylinder shading, the dorsal pattern and
overlapping scale relief, then mapped along the spine as the body moves. Heads
are lance-shaped, with cephalic plates, a supraocular ridge, labial scales,
round or slit pupils by species, heat pits on the vipers and boids, and a
forked tongue on its own flick cycle.

**It moves like a snake, not a train.** Snakes travel by lateral undulation:
the body is thrown into waves that press sideways against the ground, and the
animal then flows forward through those waves. The defining property is that
the wave is stationary in the *ground* frame — each segment follows exactly the
path the segment ahead of it took, which is why a snake leaves a single clean
sine curve as its track. So the lateral offset here is a function of ground
position rather than of position along the body: a point `u` behind the head,
with the head having travelled `D`, sits at track coordinate `D - u`. The
envelope fades to nothing at the snout, and the wave is damped wherever the
track already bends hard, so a snake threading a tight staircase does not also
throw a wave on top of it. The grid path is smoothed before it is drawn — with
a hard cap on how far the drawn body may stray from the cells it actually
occupies — so turns read as swept arcs rather than square corners.

**Eating is an event.** The strike opens the jaw, the animal is drawn into the
mouth over about half a second — shrinking and turning to line up with the
throat, still being dragged along as the snake moves on — and the gulp hands
off to a bolus in the neck.

**And it stays with you.** A swallowed animal shows as a lump in the body wall
that works its way down the snake and digests away over 35 seconds. The lump is
a gaussian widening of the body's width profile, so the skin stretches over it
rather than kinking around it, and the scale texture spreads with it. Bigger
prey leaves a bigger lump — a rabbit is unmistakable, a quail egg is a slight
swelling. The digestion clock only runs while you are playing, so pausing does
not digest.

**Wear any snake you like.** Play as whichever real species lives in the biome
you are in, or pin one of the ten for the whole run — a black mamba in the
snowfield if you want. Or design your own: base colour, marking colour, one of nine dorsal
patterns, eye colour and a round or slit pupil. It is assembled from the same
parts the wild species use — the same pattern generators, scale relief and
cylinder shading — so a custom design is rendered by exactly the same pipeline
and sits beside the real ones rather than looking pasted on. The preview in the
customiser is the real renderer, digestion bulge and all. Your design is saved,
and you can switch back to the wild species of each biome whenever you like.

**Ten places, not ten palettes.** Every biome has its own terrain generator,
seeded so a level looks the same each time you reach it. The rainforest grows
ferns, moss beds and mossy fallen logs under canopy light shafts; the dune sea
has wind ripples and cracked hardpan; the ashlands glow through lava veins from
beneath the basalt.

**Prey that is drawn, not typed.** Six animals with procedural fur, skin and
idle animation — a mouse that breathes and twitches its whiskers, a frog whose
throat pulses, a rabbit that hops. Each biome draws from its own roster.

## Battle Royale

A second mode, in its own page, sharing the campaign's look and everything the
renderer knows how to draw. Only the game underneath is different.

```bash
node server.js          # prints a localhost address and a LAN address
```

Open the address, pick a snake, and join. Everyone who opens it is in the same
arena. No npm install — the WebSocket handshake and frame codec are implemented
against RFC 6455 inside `server.js`, because adding a dependency to a project
whose whole point is not having any would be a poor trade.

**The world is 400 × 400 cells** — 160,000 of them, 256 times the area of a
campaign board — and it is walled on every side. Nothing wraps: run into the edge and
you are finished. The camera follows you and a minimap shows how little of it
you can see at once.

**Size is everything.** Eat to grow; every five segments is a level, and you get
visibly thicker as you go. When two snakes touch, the higher level survives and
the lower one dies. Equal levels kill each other. A dead snake collapses into
prey, so a kill is worth chasing.

**Big game.** The arena stocks nine animals the campaign never sees, and they
are worth crossing the map for. Weights are steep, so with 12,000 animals in
the world you can expect roughly sixteen fawns, twenty-six goat kids and forty
dogs out there at any moment — spread across a map far too large to sweep,
which is the point.

| Quarry | Length | Points | Share of spawns |
|---|---:|---:|---:|
| Brown rat | +5 | 80 | 4.9% |
| Hen | +7 | 140 | 2.6% |
| Hare | +9 | 200 | 1.8% |
| Mongoose | +11 | 260 | 1.2% |
| Cat | +14 | 360 | 0.8% |
| Piglet | +18 | 480 | 0.5% |
| Dog | +23 | 650 | 0.4% |
| Goat kid | +28 | 820 | 0.2% |
| Fawn | +35 | 1100 | 0.15% |

Cat and above are haloed in gold so you can pick them out across the plain, and
they show as pulsing beacons on the minimap from further away than you can see
— without that, a fawn in a 400 × 400 world would be a rumour rather than a
target.

**Two power-ups, arena only.**

| | Effect | Lasts |
|---|---|---:|
| **Shield** | Nothing can eat you, and anything that tries dies instead | 8s |
| **Frenzy** | Move 1.7× faster and take double growth from every animal | 7s |

The server is authoritative: clients send a heading and render what they are
sent, so nobody's browser gets to decide who ate whom. It interpolates between
snapshots at ~11 ticks a second, which is enough to look continuous. Thirty
bots keep a world this size inhabited when few people are on, and they hunt,
avoid walls, and refuse to pick fights they would lose.

Food lives in a 20-cell bucket index rather than one flat map, so the per-tick
work scales with what is near a snake instead of with the size of the world. At
the arena's original stocking that was headroom rather than a fix — both the
indexed and unindexed versions ran a tick in about 4 ms. At 12,000 animals it
earns its keep: measured over 250 ticks with 30 snakes, a tick costs 5.3 ms
with no humans connected and 7.1 ms with eight, against a 90 ms budget, where
the unindexed version costs 24 ms and 33 ms. Density is what made the index
matter, not size.

## Levels

150 levels, fifteen per biome. Walls kill; most levels are walled in, and a
handful leave the edges open so the map still wraps (the level card says
which). Eat the level's quota of animals to move on. Dying retries that level,
not the run — your furthest level is saved, and the menu lets you jump back to
any level you have reached.

Layouts come from 33 seeded shape generators — pillars, lanes, spirals, rings,
combs, chevrons, pinwheels, recursive-division mazes, lattices and so on — each
used several times with different parameters, seeds and biomes, and scheduled
by hand so terrain and difficulty ramp rather than wander.

| Levels | Biome | Resident species | Binomial |
|---:|---|---|---|
| 1–15 | Wildflower Meadow | Grass Snake | *Natrix natrix* |
| 16–30 | Rainforest Floor | Emerald Tree Boa | *Corallus caninus* |
| 31–45 | Dune Sea | Sidewinder Rattlesnake | *Crotalus cerastes* |
| 46–60 | Autumn Woodland | Corn Snake | *Pantherophis guttatus* |
| 61–75 | Frozen Taiga | Leucistic Python | *Python bivittatus* |
| 76–90 | Cypress Bayou | Cottonmouth | *Agkistrodon piscivorus* |
| 91–105 | Golden Savanna | Black Mamba | *Dendroaspis polylepis* |
| 106–120 | Ember Ashlands | Milk Snake | *Lampropeltis triangulum* |
| 121–135 | Bioluminescent Cavern | Blue Malayan Coral Snake | *Calliophis bivirgatus* |
| 136–150 | The Abyss | Brazilian Rainbow Boa | *Epicrates cenchria* |

The prey quota rises from 4 animals on level 1 to 26 on level 150; the tick
falls from 150 ms to 55 ms. Obstacles take the material of their biome — mossy
stone, sandstone strata, ice, rotten cypress, basalt with molten seams,
glowing crystal, and monoliths rimmed with starlight.

Every level is checked automatically: any ground the snake cannot reach is
turned into wall, so an animal can never spawn somewhere unwinnable. The suite
also asserts a minimum playable area, at least four cells of runway at the
start, and that no level is mostly wall.

## Prey

| Animal | Points | Spawn weight |
|---|---:|---:|
| Windfall apple | 10 | 30% |
| Quail egg | 15 | 14% |
| Field mouse | 20 | 24% |
| Marsh frog | 30 | 14% |
| Sand lizard | 40 | 11% |
| Young rabbit | 60 | 7% |

Weights are relative within each biome's own roster, so the mix shifts with
the habitat — frogs dominate the bayou, lizards the desert.

## Controls

| Input | Action |
|---|---|
| Arrow keys / WASD | Steer |
| Space | Start · pause · resume |
| Snake button | Choose a species, or design your own |
| Swipe | Steer (touch) |
| Tap | Start / restart (touch) |

Walls kill. So does your own body. Most levels are walled in; the ones that
leave the edges open are marked on the level card.

## Running it

```bash
open index.html          # no build required
# or
npx serve .
```

## Notes on assets

There are none, deliberately. Sprite packs and glTF models were considered and
rejected: they would break the single-file architecture, add licence and
attribution files, and — since the freely available snake and rodent assets are
stylised low-poly or pixel art — would look *less* realistic than drawing the
animals from scratch. Everything is generated by about two thousand lines of
canvas code inside `index.html`.

## Browser support

Any current browser with Canvas 2D. Respects `prefers-reduced-motion`, keeps
ARIA live regions for score and level changes, and is fully keyboard playable.

## Licence

MIT
