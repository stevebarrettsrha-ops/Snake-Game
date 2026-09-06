# Serpent — 150 levels across ten biomes

A snake game that takes its subject seriously. 150 levels, ten biomes, ten real snake
species and six prey animals, all drawn procedurally on HTML5 Canvas.

No dependencies, no build step, no image files. Open `index.html`.

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

**Ten places, not ten palettes.** Every biome has its own terrain generator,
seeded so a level looks the same each time you reach it. The rainforest grows
ferns, moss beds and mossy fallen logs under canopy light shafts; the dune sea
has wind ripples and cracked hardpan; the ashlands glow through lava veins from
beneath the basalt.

**Prey that is drawn, not typed.** Six animals with procedural fur, skin and
idle animation — a mouse that breathes and twitches its whiskers, a frog whose
throat pulses, a rabbit that hops. Each biome draws from its own roster.

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
